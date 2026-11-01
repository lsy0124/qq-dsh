/**
 * B站 MCP 工具 —— 让 QQ 桥接那边的她能刷 B 站。
 *
 * 为什么单独写一个：
 *   bili-duty 是个独立的 DSH 插件（每天定时跑、写简报），跟 QQ 桥接不在一个进程里。
 *   她在 QQ 里刷唤醒时，手上根本没有 B 站工具。
 *
 * 只读，不做点赞/评论/投币 —— 刷内容用不上写操作。
 *
 * 工具：
 *   bili_hot        热门视频（相当于"刷首页"）
 *   bili_search     搜索
 *   bili_detail     看详情（简介、UP 主、播放量）
 *   bili_comments   看评论（常常比视频更好笑）
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const BILI_PY = process.env.BILI_PYTHON
  || path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'bili-duty', '.venv', 'Scripts', 'python.exe');

const PY_SCRIPT = String.raw`
import asyncio, json, sys, io

# Windows 控制台默认 GBK，B 站标题里有 emoji（💃）会直接崩在 print 上。
# 必须在任何输出之前把 stdout 换成 UTF-8。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))

async def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'hot'
    try:
        from bilibili_api import search, video, comment, hot, homepage

        if action == 'hot':
            page_size = int(sys.argv[2]) if len(sys.argv) > 2 else 20
            # 热门视频排行榜 —— 相当于 B 站首页"热门"
            r = await hot.get_hot_videos(pn=1, ps=page_size)
            items = r.get('list', [])[:page_size]
            out = []
            for it in items:
                out.append({
                    'bvid': it.get('bvid'),
                    'title': it.get('title', ''),
                    'owner': (it.get('owner') or {}).get('name', ''),
                    'play': it.get('stat', {}).get('view', 0),
                    'danmaku': it.get('stat', {}).get('danmaku', 0),
                    'desc': (it.get('desc') or '')[:120],
                    'duration': it.get('duration', 0),
                    'url': 'https://www.bilibili.com/video/' + str(it.get('bvid')),
                })
            emit({'ok': True, 'items': out})

        elif action == 'search':
            kw = sys.argv[2]
            limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10
            r = await search.search_by_type(kw, search_type=search.SearchObjectType.VIDEO, page=1)
            items = r.get('result', [])[:limit]
            out = []
            for it in items:
                title = it.get('title', '').replace('<em class="keyword">', '').replace('</em>', '')
                out.append({
                    'bvid': it.get('bvid'),
                    'title': title,
                    'owner': it.get('author', ''),
                    'play': it.get('play', 0),
                    'duration': it.get('duration', ''),
                    'desc': (it.get('description') or '')[:120],
                    'url': 'https://www.bilibili.com/video/' + str(it.get('bvid')),
                })
            emit({'ok': True, 'items': out, 'keyword': kw})

        elif action == 'detail':
            bvid = sys.argv[2]
            v = video.Video(bvid=bvid)
            info = await v.get_info()
            out = {
                'bvid': bvid,
                'title': info.get('title', ''),
                'desc': (info.get('desc') or '')[:400],
                'owner': (info.get('owner') or {}).get('name', ''),
                'play': (info.get('stat') or {}).get('view', 0),
                'like': (info.get('stat') or {}).get('like', 0),
                'coin': (info.get('stat') or {}).get('coin', 0),
                'duration': info.get('duration', 0),
                'pubdate': info.get('pubdate', 0),
                'tags': [t.get('tag_name') for t in (info.get('tag') or [])][:8],
                'url': 'https://www.bilibili.com/video/' + bvid,
            }
            emit({'ok': True, 'video': out})

        elif action == 'comments':
            bvid = sys.argv[2]
            limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10
            v = video.Video(bvid=bvid)
            # get_aid() 是同步方法（返回 int），不能 await —— 实测 TypeError
            aid = v.get_aid()
            r = await comment.get_comments(aid, comment.CommentResourceType.VIDEO, page_index=1, order=comment.OrderType.LIKE)
            replies = (r.get('replies') or [])[:limit]
            out = []
            for c in replies:
                out.append({
                    'user': (c.get('member') or {}).get('uname', ''),
                    'text': (c.get('content') or {}).get('message', '')[:200],
                    'like': c.get('like', 0),
                })
            emit({'ok': True, 'comments': out, 'count': r.get('page', {}).get('count', 0)})

        else:
            emit({'ok': False, 'error': 'unknown action: ' + action})

    except Exception as e:
        emit({'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:300]})

asyncio.run(main())
`;

function runPy(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(BILI_PY, ['-c', PY_SCRIPT, ...args], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      resolve({ ok: false, error: '超时' });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) return resolve({ ok: false, error: (err || out).slice(-300) || '无输出' });
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: '输出无法解析' }); }
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e) }); });
  });
}

const server = new Server(
  { name: 'bili', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bili_hot',
      description: '看 B 站热门视频（相当于刷首页）。刷内容时先用这个。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '取几条，默认 20，最大 50' },
        },
      },
    },
    {
      name: 'bili_search',
      description: '搜 B 站视频。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索词' },
          limit: { type: 'number', description: '取几条，默认 10' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'bili_detail',
      description: '看一条视频的详情：简介、UP 主、播放量、标签。确定要看才调，能判断值不值得记。',
      inputSchema: {
        type: 'object',
        properties: { bvid: { type: 'string', description: 'BV 号' } },
        required: ['bvid'],
      },
    },
    {
      name: 'bili_comments',
      description: '看一条视频的热门评论。评论常常比视频本身更好笑，是找梗的好地方。',
      inputSchema: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          limit: { type: 'number', description: '取几条，默认 10' },
        },
        required: ['bvid'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  let r;
  if (name === 'bili_hot') {
    const n = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    r = await runPy(['hot', String(n)]);
  } else if (name === 'bili_search') {
    const n = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    r = await runPy(['search', String(args.keyword || ''), String(n)]);
  } else if (name === 'bili_detail') {
    r = await runPy(['detail', String(args.bvid || '')]);
  } else if (name === 'bili_comments') {
    const n = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    r = await runPy(['comments', String(args.bvid || ''), String(n)]);
  } else {
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
  }

  if (!r.ok) {
    return { content: [{ type: 'text', text: `失败：${r.error}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
