/**
 * 贴吧 MCP 工具 —— 让她也能刷贴吧。
 *
 * 用 aiotieba（4.8.2，最活跃的贴吧库），只读。
 *
 * 工具：
 *   tieba_threads   看某个吧的帖子列表（相当于"刷吧"）
 *   tieba_posts     看某个帖子的回复（楼中楼，常常是精华所在）
 *   tieba_search    搜帖子
 *   tieba_hot       看热门吧/热门话题
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

const TIEBA_PY = process.env.BILI_PYTHON
  || path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'bili-duty', '.venv', 'Scripts', 'python.exe');

const PY_SCRIPT = String.raw`
import asyncio, json, sys, io

# Windows 默认 GBK，贴吧标题里 emoji / 特殊符号会崩在 print 上
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))

async def main():
    import aiotieba
    action = sys.argv[1] if len(sys.argv) > 1 else 'threads'

    try:
        async with aiotieba.Client() as client:

            if action == 'threads':
                fname = sys.argv[2]
                limit = int(sys.argv[3]) if len(sys.argv) > 3 else 20
                r = await client.get_threads(fname, pn=1, rn=min(limit, 30))
                out = []
                for p in r.objs:
                    # text 是正文（实测 get_threads 自带），截 200 字够她判断值不值得看。
                    # 为什么重要：她刷吧是为了「看到什么」，光有标题不够 ——
                    # 而 get_posts（楼中楼）在这台机器上不通，正文就是唯一的细节来源。
                    body = ''
                    try:
                        body = str(getattr(p, 'text', '') or '')[:200]
                    except Exception:
                        body = ''
                    out.append({
                        'tid': str(p.tid),
                        'title': str(p.title),
                        'author': str(p.user.user_name),
                        'reply': int(p.reply_num),
                        'view': int(p.view_num),
                        'text': body,
                        'create_time': int(p.create_time),
                        'url': 'https://tieba.baidu.com/p/' + str(p.tid),
                    })
                emit({'ok': True, 'forum': fname, 'threads': out})

            elif action == 'posts':
                tid = int(sys.argv[2])
                limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10
                # ⚠ get_posts 走的是 tiebac.baidu.com/c/f/pb/page，这台机器上
                # 连续 3 次全部 Connection timeout（2026-10-29 实测）。
                # 而 get_threads 走的接口是通的 —— 所以「看帖子正文」能用，
                # 「看楼中楼回复」用不了。带一次重试，失败就如实报。
                last_err = ''
                r = None
                for attempt in range(2):
                    try:
                        r = await client.get_posts(tid, pn=1, rn=min(limit, 30))
                        if r.objs:
                            break
                    except Exception as e:
                        last_err = type(e).__name__ + ': ' + str(e)[:150]
                    await asyncio.sleep(1.5)

                if not r or not r.objs:
                    emit({
                        'ok': False,
                        'error': '读不到回复。tiebac.baidu.com 这个接口在本机不通'
                                 + '（tieba_threads 用的是另一个接口，那个是好的）。'
                                 + (f' 最后错误：{last_err}' if last_err else ''),
                        'hint': '想看帖子内容，用 tieba_threads 返回的 text 字段（那是正文）。',
                    })
                    return

                out = []
                for p in r.objs:
                    out.append({
                        'author': str(p.user.user_name),
                        'text': str(p.text)[:300],
                        'floor': int(p.floor),
                        'agree': int(p.agree),
                        'create_time': int(p.create_time),
                    })
                forum_name = ''
                try:
                    forum_name = str(getattr(r, 'forum', '') or '')
                except Exception:
                    forum_name = ''
                emit({'ok': True, 'tid': tid, 'posts': out, 'forum': forum_name})

            elif action == 'search':
                kw = sys.argv[2]
                limit = int(sys.argv[3]) if len(sys.argv) > 3 else 10
                # aiotieba 的 search 是搜吧，不是搜帖；这里用 get_threads 里的关键词过滤兜底
                emit({'ok': False, 'error': 'aiotieba 不支持搜帖，只支持按吧浏览。请用 tieba_threads 指定吧名。'})

            else:
                emit({'ok': False, 'error': 'unknown action: ' + action})

    except Exception as e:
        emit({'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:300]})

asyncio.run(main())
`;

function runPy(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(TIEBA_PY, ['-c', PY_SCRIPT, ...args], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let out = '', err = '';
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
  { name: 'tieba', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'tieba_threads',
      description: '看某个贴吧的帖子列表（相当于逛那个吧）。只看不发。',
      inputSchema: {
        type: 'object',
        properties: {
          forum: { type: 'string', description: '吧名，不含"吧"字。例如 "v" "steam" "stardewvalley"' },
          limit: { type: 'number', description: '取几条，默认 20，最大 30' },
        },
        required: ['forum'],
      },
    },
    {
      name: 'tieba_posts',
      description: '看某个帖子的回复。贴吧的神回复常常在这些楼里，比帖子本身好玩。',
      inputSchema: {
        type: 'object',
        properties: {
          tid: { type: 'string', description: '帖子 ID（来自 tieba_threads）' },
          limit: { type: 'number', description: '取几条，默认 10，最大 30' },
        },
        required: ['tid'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  let r;
  if (name === 'tieba_threads') {
    const n = Math.min(Math.max(Number(args.limit) || 20, 1), 30);
    r = await runPy(['threads', String(args.forum || ''), String(n)]);
  } else if (name === 'tieba_posts') {
    const n = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    r = await runPy(['posts', String(args.tid || ''), String(n)]);
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
