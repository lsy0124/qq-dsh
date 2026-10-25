#!/usr/bin/env node
// mcp-douyin.js —— 把抖音内容读取能力接给 AI
//
// 架构说明（为什么这么设计）：
//   浏览器实例很重，不能每次工具调用都启停。所以这个 MCP server 自己持有
//   一个长驻的 Edge（懒加载：第一次调用时才启动，之后复用）。
//   抖音的签名由页面自己算，我们只在页面上下文里发 fetch —— 这就是能读到
//   数据而不用逆向 a_bogus 的原因。
//
// 能力边界：
//   ✅ 推荐流列表（标题/标签/作者/时长/计数/封面）
//   ✅ 评论列表
//   ✅ 单条视频的内容摘要
//   ✅ 搜索
//   ❌ 视频画面本身（需要下载+抽帧，另做）
//   ❌ 点赞/收藏/评论（接口有服务端强校验，不做）

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// douyin 核心脚本目录。随仓库分发（src/douyin/），不再依赖外部目录
// ⚠️ 必须在使用之前定义（const 有暂时性死区）
const DY_DIR = path.join(ROOT, 'douyin');

// 验证码检测与通知（遇到风控时通过 QQ 把控制权交回本人）
const captchaUrl = pathToFileURL(path.join(DY_DIR, 'douyin-captcha.mjs')).href;
const { handleCaptcha, notifyOwner } = await import(captchaUrl);

/** 检测验证码；有就通知 QQ 并抛出可识别错误（不吞掉、不重试） */
async function checkCaptcha(page, context) {
  return handleCaptcha(page, { context });
}

function log(...a) {
  // stdio MCP：stdout 是协议通道，调试只能走 stderr
  console.error('[douyin]', ...a);
}

// 懒加载的浏览器单例
let bot = null;
let reader = null;
let starting = null;

async function ensureBrowser() {
  if (bot && reader) return { bot, reader };
  if (starting) return starting;

  starting = (async () => {
    // 动态 import 在 Windows 上必须用 file:// URL —— 直接传 "D:\..." 会被
    // ESM loader 当成协议 "d:"，报 "Only URLs with a scheme in: file, data..."。
    const { pathToFileURL } = await import('node:url');
    const coreUrl = pathToFileURL(path.join(DY_DIR, 'douyin-core.mjs')).href;
    const readerUrl = pathToFileURL(path.join(DY_DIR, 'douyin-reader.mjs')).href;

    const { DouyinBot } = await import(coreUrl);
    const { DouyinReader } = await import(readerUrl);

    // headless 由环境变量控制：默认有头，因为抖音对无头浏览器检测更严
    const headless = process.env.DOUYIN_HEADLESS === '1';
    log('启动浏览器 headless=', headless);

    const b = await new DouyinBot({ headless }).start();
    const r = new DouyinReader(b.page);
    bot = b;
    reader = r;
    starting = null;
    log('浏览器就绪');
    return { bot: b, reader: r };
  })();

  return starting;
}

async function withReader(fn) {
  const r = await ensureBrowser();
  try {
    const out = await fn(r.reader, r.bot);
    // 操作成功后也检查一次：抖音有时候是在动作完成后才弹验证
    await checkCaptcha(r.bot.page, '抖音操作');
    return { ok: true, data: out };
  } catch (error) {
    // 失败时先看看是不是被验证码拦了
    try {
      if (r.bot?.page) await handleCaptcha(r.bot.page, { context: '抖音操作' });
    } catch (captchaErr) {
      if (captchaErr?.code === 'CAPTCHA_REQUIRED') throw captchaErr;
    }

    // 浏览器挂了就丢掉单例，下次调用重建
    const msg = String(error?.message ?? error);
    if (/closed|Target page|browser has been closed/i.test(msg)) {
      log('浏览器异常，重置单例:', msg);
      try { await bot?.close(); } catch {}
      bot = null; reader = null;
    }
    return { ok: false, error: msg };
  }
}

const server = new McpServer({ name: 'douyin', version: '1.0.0' });

// ── 写操作总开关 ───────────────────────────────────────────────────────────
//
// 抖音的「发评论 / 回复 / 发作品 / 发私信」是不可逆的公开操作，
// 发出去所有粉丝都能看到，删不干净。
//
// 默认全部禁用，必须显式设置 DOUYIN_ALLOW_WRITES=1 才放行。
const DOUYIN_WRITES_ALLOWED = process.env.DOUYIN_ALLOW_WRITES === '1';

function assertWritesAllowed(toolName) {
  if (DOUYIN_WRITES_ALLOWED) return null;
  return {
    content: [{
      type: 'text',
      text: `「${toolName}」属于抖音写操作，默认禁用。\n\n`
        + '这会真的发到抖音上（评论 / 回复 / 作品），删不干净。\n\n'
        + '确认要用的话，在拉起这个 MCP 的环境里设：\n'
        + '  DOUYIN_ALLOW_WRITES=1\n',
    }],
    isError: true,
  };
}

server.tool(
  'douyin_feed',
  '读取抖音推荐流。返回视频的标题/文案、话题标签、作者、时长、点赞评论数、发布时间。'
  + '这是「刷抖音」的入口：想知道现在有什么内容、别人在发什么，就调它。'
  + '注意：第一次调用会启动浏览器（约 10 秒），后续复用。只读，不点赞不评论。',
  {
    count: z.number().int().min(1).max(30).optional().describe('要几条，默认 10'),
  },
  async ({ count }) => {
    const res = await withReader(async (reader) => reader.feed({ count: count ?? 10 }));
    if (!res.ok) {
      return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    }
    const list = res.data;
    if (!list.length) {
      return { content: [{ type: 'text', text: '没读到内容（可能登录失效，或页面结构变化）。' }], isError: true };
    }
    const text = list.map((v, i) => {
      const tags = v.tags.length ? `  标签: ${v.tags.map((t) => '#' + t).join(' ')}` : '';
      return `${i + 1}. [${v.id}] ${v.author} · ${v.duration_sec}s · ❤${v.digg} 💬${v.comment}\n`
        + `   ${v.desc.slice(0, 100)}\n${tags}`;
    }).join('\n\n');
    return { content: [{ type: 'text', text: `推荐流 ${list.length} 条：\n\n${text}` }] };
  },
);

server.tool(
  'douyin_detail',
  '读一条抖音视频的完整信息：文案、话题、作者、时长、各项数据、以及**热门评论**。'
  + '评论是理解视频内容的关键——观众往往会复述画面里发生的事，比自己猜准得多。',
  {
    aweme_id: z.string().describe('视频 ID（来自 douyin_feed / douyin_search）'),
    with_comments: z.boolean().optional().describe('是否附带评论，默认 true'),
  },
  async ({ aweme_id, with_comments }) => {
    const res = await withReader(async (reader) =>
      reader.describe(String(aweme_id), { withComments: with_comments !== false }));
    if (!res.ok) {
      return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    }
    if (!res.data) {
      return { content: [{ type: 'text', text: `找不到视频 ${aweme_id}（可能已删除或 ID 失效）` }], isError: true };
    }
    return { content: [{ type: 'text', text: res.data.text }] };
  },
);

server.tool(
  'douyin_comments',
  '只读某条视频的评论列表。适合想看看大家怎么讨论这条内容时用。',
  {
    aweme_id: z.string().describe('视频 ID'),
    count: z.number().int().min(1).max(50).optional().describe('几条，默认 20'),
  },
  async ({ aweme_id, count }) => {
    const res = await withReader(async (reader) => reader.comments(String(aweme_id), { count: count ?? 20 }));
    if (!res.ok) {
      return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    }
    const cs = res.data;
    if (!cs.length) return { content: [{ type: 'text', text: '这条视频没有可读的评论。' }] };
    const text = cs.map((c, i) =>
      `${i + 1}. ${c.user}${c.is_author ? '(作者)' : ''}: ${c.text.slice(0, 120)} (赞${c.digg})`).join('\n');
    return { content: [{ type: 'text', text: `${cs.length} 条评论：\n\n${text}` }] };
  },
);

server.tool(
  'douyin_search',
  '在抖音搜索内容。适合「想看看关于 X 的视频」这种定向需求。',
  {
    keyword: z.string().min(1).describe('搜索词'),
    count: z.number().int().min(1).max(20).optional().describe('几条，默认 10'),
  },
  async ({ keyword, count }) => {
    const res = await withReader(async (reader) => reader.search(keyword, { count: count ?? 10 }));
    if (!res.ok) {
      return { content: [{ type: 'text', text: `搜索失败：${res.error}` }], isError: true };
    }
    const list = res.data;
    if (!list.length) return { content: [{ type: 'text', text: `没搜到「${keyword}」的结果。` }] };
    const text = list.map((v, i) =>
      `${i + 1}. [${v.id}] ${v.author} · ${v.duration_sec}s · ❤${v.digg}\n   ${v.desc.slice(0, 100)}`).join('\n\n');
    return { content: [{ type: 'text', text: `搜索「${keyword}」得到 ${list.length} 条：\n\n${text}` }] };
  },
);

server.tool(
  'douyin_status',
  '只读：检查抖音浏览器是否可用、是否已登录。读内容前可以先确认。',
  {},
  async () => {
    try {
      const r = await ensureBrowser();
      const login = await r.bot.isLoggedIn();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            可用: true,
            已登录: login?.hasUser ?? null,
            地址: r.bot.page?.url?.() ?? '',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ 可用: false, 错误: String(error?.message ?? error) }, null, 2) }],
        isError: true,
      };
    }
  },
);

// ── 深度理解：下载视频 → 语音转文字 ────────────────────────────────────────
// 这是「真的听懂视频在说什么」的唯一路径。标题只是作者写的，评论是别人的反应，
// 而口播内容才是视频本身。转写用本机 FunASR（GPT-SoVITS 自带模型），纯 CPU。
server.tool(
  'douyin_transcribe',
  '把一条抖音视频「听懂」——下载视频、抽出音轨、语音转成文字。'
  + '这是理解内容最准的方式：拿到的是视频里真正说出来的话，不是标题也不是评论。'
  + '耗时：30 秒视频约 10-20 秒，5 分钟视频约 1-2 分钟。同一条不要反复调用。',
  {
    aweme_id: z.string().describe('视频 ID（来自 douyin_feed / douyin_search）'),
  },
  async ({ aweme_id }) => {
    const { spawnSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const PY = process.env.TTS_PYTHON || path.resolve(ROOT, '..', '..', 'GPT-SoVITS', 'GPT-SoVITS-v2pro-20250604-nvidia50', 'runtime', 'python.exe');
    const ASR = path.join(DY_DIR, 'douyin_transcribe.py');
    const MEDIA_DIR = path.join(DY_DIR, 'media');

    const res = await withReader(async (_reader, b) => {
      const mediaUrl = pathToFileURL(path.join(DY_DIR, 'douyin-media.mjs')).href;
      const { DouyinMedia } = await import(mediaUrl);
      const media = new DouyinMedia(b.page);

      log('下载视频', aweme_id);
      const dl = await media.download(String(aweme_id), MEDIA_DIR);
      log('已下载', Math.round(dl.bytes / 1024 / 1024), 'MB');

      log('开始转写…');
      const r = spawnSync(PY, [ASR, dl.file], {
        encoding: 'utf8',
        timeout: 300000,
        env: { ...process.env, PYTHONUTF8: '1' },
      });
      const outLines = (r.stdout || '').trim().split('\n').filter(Boolean);
      let asr = null;
      try { asr = JSON.parse(outLines[outLines.length - 1] || ''); } catch {}
      if (!asr?.ok) throw new Error(`转写失败: ${asr?.error ?? (r.stderr || '').slice(-200)}`);

      return {
        desc: dl.desc, author: dl.author,
        duration_sec: Math.round(dl.duration_ms / 1000),
        chars: asr.chars, text: asr.text,
      };
    });

    if (!res.ok) {
      return { content: [{ type: 'text', text: `理解失败：${res.error}` }], isError: true };
    }
    const d = res.data;
    return {
      content: [{
        type: 'text',
        text: `【作者】${d.author}  【时长】${d.duration_sec}s\n`
          + `【标题】${d.desc.slice(0, 120)}\n\n`
          + `【视频里说的话】（${d.chars} 字）\n${d.text}`,
      }],
    };
  },
);

// ── 私信与分享 ─────────────────────────────────────────────────────────────
// 走 UI 自动化（不是接口）：私信接口是 protobuf 二进制，逆向成本高且随时失效；
// 而 UI 路径实测能真实发出消息，抖音改版时只要选择器还在就还能用。
// 已知约束：抖音对陌生人私信有「对方回复或关注你之前，只能发送一条文字消息」的限制。

server.tool(
  'douyin_send_message',
  '给抖音好友发一条私信。按昵称模糊匹配会话，打开后输入并发送。'
  + '注意：抖音限制「对方回复或关注你之前只能发一条文字消息」，对不熟的人重复发会被拒。'
  + '发送会真的发出去，别用来刷屏。',
  {
    to: z.string().min(1).describe('好友昵称（模糊匹配，如「未开封的汽水」）'),
    text: z.string().min(1).max(500).describe('要发送的文字'),
  },
  async ({ to, text }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_send_message');
    if (denied) return denied;
    const res = await withReader(async (_reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const { DouyinIM } = await import(pathToFileURL(path.join(DY_DIR, 'douyin-im.mjs')).href);
      const im = new DouyinIM(b.page);
      return im.sendTo(String(to), String(text));
    });
    if (!res.ok) return { content: [{ type: 'text', text: `发送失败：${res.error}` }], isError: true };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: res.data.sent,
          会话: res.data.conversation?.slice(0, 20),
          内容: res.data.typed?.replace(/\u200b/g, '').trim(),
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'douyin_share_video',
  '把一条抖音视频分享给好友——本质是把视频链接通过私信发过去。'
  + '链接格式 https://www.douyin.com/video/<id>，对方点开就能看。',
  {
    to: z.string().min(1).describe('好友昵称'),
    aweme_id: z.string().min(1).describe('视频 ID（来自 douyin_feed / douyin_search）'),
    note: z.string().max(200).optional().describe('可选：附在链接前的一句说明'),
  },
  async ({ to, aweme_id, note }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_share_video');
    if (denied) return denied;
    const res = await withReader(async (reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const { DouyinIM } = await import(pathToFileURL(path.join(DY_DIR, 'douyin-im.mjs')).href);
      const im = new DouyinIM(b.page);

      // 用抖音标准分享文案（share_link_desc），而不是裸链接 ——
      // 裸链接在对方那里显示成一串 URL，标准文案才会渲染成卡片。
      let share;
      try {
        share = await reader.shareText(aweme_id);
      } catch (e) {
        // 拿不到分享信息就退回裸链接，至少能打开
        share = { text: `https://www.douyin.com/video/${aweme_id}`, link: `https://www.douyin.com/video/${aweme_id}`, desc: '' };
      }

      const text = note ? `${note}\n${share.text}` : share.text;
      const r = await im.sendTo(String(to), text);
      return { ...r, link: share.link, shareText: share.text, desc: share.desc };
    });
    if (!res.ok) return { content: [{ type: 'text', text: `分享失败：${res.error}` }], isError: true };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: res.data.sent,
          会话: res.data.conversation?.slice(0, 20),
          链接: res.data.link,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'douyin_conversations',
  '只读：列出抖音私信会话（最近聊过的人、最后一条消息预览）。'
  + '发消息前可以先用它确认对方昵称。',
  {},
  async () => {
    const res = await withReader(async (_reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const { DouyinIM } = await import(pathToFileURL(path.join(DY_DIR, 'douyin-im.mjs')).href);
      const im = new DouyinIM(b.page);
      await im.openPanel();
      return im.listConversations();
    });
    if (!res.ok) return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    const list = res.data.filter((c) => !/^消息/.test(c.text));
    const text = list.map((c, i) => `${i + 1}. ${c.text.slice(0, 60)}`).join('\n');
    return { content: [{ type: 'text', text: `会话 ${list.length} 个：\n\n${text}` }] };
  },
);

// ── 评论与 @ ───────────────────────────────────────────────────────────────
// 抖音的评论接口（comment/publish）有服务端强校验，直接调返回空，
// 所以走 UI：打开评论框 → 输入 @ 触发候选 → 键盘选中好友 → 点发送。
//
// 踩坑记录（都是实测得来，别改回去）：
//   · @ 不能点图标，页面有多组同尺寸图标，坐标不可靠 → 改成输入 "@" 触发
//   · 候选列表不能 DOM click，抖音是 React，合成事件不生效 → 必须键盘 ↓ + Enter
//   · 发送按钮是编辑器右侧最右的 36x36 圆箭头，没有文字也没有 aria-label
server.tool(
  'douyin_comment',
  '在抖音视频下发表评论，可选 @ 好友。'
  + '走 UI 操作（打开评论框 → 输入 → 点发送），因为评论接口有服务端强校验、直接调会被拒。'
  + '评论是公开可见的，措辞要想清楚；抖音有风控，别刷屏。'
  + '如果抖音要求验证码，会自动通过 QQ 通知你，浏览器窗口会留着让你手动验证。',
  {
    aweme_id: z.string().min(1).describe('视频 ID（来自 douyin_feed / douyin_search）'),
    text: z.string().min(1).max(200).describe('评论内容'),
    at_names: z.array(z.string()).optional().describe('要 @ 的好友昵称数组（可选）'),
    dry_run: z.boolean().optional().describe('只输入不发送，用于验证（默认 false）'),
  },
  async ({ aweme_id, text, at_names, dry_run }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_comment');
    if (denied) return denied;
    const res = await withReader(async (_reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(path.join(DY_DIR, 'douyin-comment.mjs')).href);
      const cm = new mod.DouyinComment(b.page);

      const target = `https://www.douyin.com/video/${aweme_id}`;
      await b.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 4500));

      return cm.post(String(text), {
        dryRun: dry_run === true,
        atNames: Array.isArray(at_names) ? at_names : [],
      });
    });

    if (!res.ok) {
      return { content: [{ type: 'text', text: `评论失败：${res.error}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
  },
);

// ── 读别人分享的视频 ───────────────────────────────────────────────────────
// 别人在 QQ / 抖音里发来的分享，本体是一段带口令的文本：
//   「4.35 :0pm cmd:/ 07/10 p@d.aN 标题...#tag https://v.douyin.com/xxx/ 复制此链接...」
// 不解析的话 AI 只看到一串乱码似的文字，完全不知道那是视频。
server.tool(
  'douyin_read_share',
  '别人发来的抖音分享文本/链接，直接丢给这个工具，它会解析出视频并读出内容'
  + '（标题、作者、数据、热门评论）。短链会自动跟随重定向。'
  + '对方发来一长串带「复制此链接」的文字时，原样传进来就行，不用自己提取。',
  {
    share_text: z.string().min(1).describe('分享原文：可以是完整口令文本、短链、或 douyin.com/video/xxx 链接'),
    with_comments: z.boolean().optional().describe('是否附带评论，默认 true'),
  },
  async ({ share_text, with_comments }) => {
    const res = await withReader(async (reader) => {
      return reader.fromShareText(String(share_text), { withComments: with_comments !== false });
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `解析失败：${res.error}` }], isError: true };
    }
    const d = res.data;
    if (!d?.ok) {
      return { content: [{ type: 'text', text: `解析失败：${d?.error ?? '未知原因'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `视频 ID: ${d.awemeId}\n\n${d.text}` }] };
  },
);

server.tool(
  'douyin_read_im',
  '打开一个抖音私信会话，读出里面的消息；如果对方发过视频分享，会一并解析出视频内容。'
  + '别人在抖音里分享给你视频、你想知道那是什么时用它。',
  {
    to: z.string().min(1).describe('会话对方昵称（模糊匹配）'),
    limit: z.number().int().min(5).max(60).optional().describe('读最近多少条，默认 20'),
    with_video: z.boolean().optional().describe('是否解析里面的视频链接，默认 true'),
  },
  async ({ to, limit, with_video }) => {
    const res = await withReader(async (reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(path.join(DY_DIR, 'douyin-im.mjs')).href);
      const im = new mod.DouyinIM(b.page);
      return im.readSharedFrom(String(to), {
        limit: limit ?? 20,
        reader: with_video === false ? null : reader,
      });
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    }
    const d = res.data;
    const parts = [];
    parts.push(`会话：${d.conversation?.slice(0, 30) ?? '?'}（${d.count} 条消息）`);

    // 消息按发送者标注清楚 —— 「谁说的」是理解对话的前提
    if (d.messages?.length) {
      parts.push('', '── 对话 ──');
      for (const m of d.messages.slice(-20)) {
        const who = m.from === 'me' ? '我(机器人)' : m.from === 'them' ? '对方' : '?';
        const linkMark = m.links?.length ? ' [含链接]' : '';
        parts.push(`${who}: ${m.text}${linkMark}`);
      }
    }

    // 视频单独列一节，并且明确是谁分享的
    if (d.videos?.length) {
      parts.push('', '── 分享的视频 ──');
      for (const v of d.videos) {
        const sender = v.from === 'me' ? '机器人自己发的' : v.from === 'them' ? '对方分享的' : '来源不明';
        parts.push(`【${sender}】`);
        parts.push(v.text);
        parts.push('');
      }
      // 如果所有的分享都来自对方，加一句提示，避免 AI 误以为是自己的
      const fromThem = d.videos.filter((v) => v.from === 'them').length;
      if (fromThem === d.videos.length && fromThem > 0) {
        parts.push('（以上都是对方分享过来的视频，不是自己找的）');
      }
    } else if (with_video !== false) {
      parts.push('', '（这个会话里没有可解析的视频分享）');
    }
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  },
);

// ── 读通知（@提醒 / 评论回复 / 点赞 / 关注）────────────────────────────────
// 抖音没有推送 API，只能靠 UI：hover 右上角通知图标 → 解析弹出的面板。
// 这是感知「有人在评论区 @ 我」的唯一方式。
server.tool(
  'douyin_notifications',
  '读抖音通知：@提醒、评论回复、点赞、新粉丝。'
  + '有人在你视频评论区 @ 你或回复你的评论时，这里能看到。'
  + '抖音没有推送接口，所以这是被动查询 —— 想知道有没有人找你，主动调它。',
  {
    limit: z.number().int().min(1).max(50).optional().describe('最多读几条，默认 20'),
    only_interaction: z.boolean().optional()
      .describe('只看互动（评论/@/赞），过滤掉关注类，默认 false'),
  },
  async ({ limit, only_interaction }) => {
    const res = await withReader(async (reader) => {
      return reader.readNotifications({ limit: limit ?? 20 });
    });

    if (!res.ok) {
      return { content: [{ type: 'text', text: `读取通知失败：${res.error}` }], isError: true };
    }

    const d = res.data;
    if (!d.found) {
      return { content: [{ type: 'text', text: '没打开通知面板（可能未登录，或页面没加载完）' }], isError: true };
    }

    let items = d.items || [];
    if (only_interaction) items = items.filter((x) => ['回复评论', '@提醒', '点赞', '评论'].includes(x.action));

    // 去掉重复项（同一人多条相同通知）
    const uniq = [];
    const seen = new Set();
    for (const it of items) {
      const key = it.text.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
    }

    if (!uniq.length) {
      return { content: [{ type: 'text', text: '暂时没有新通知。' }] };
    }

    const text = uniq.map((it, i) =>
      `${i + 1}. [${it.action}] ${it.time ? it.time + ' · ' : ''}${it.text}`).join('\n');

    const mentions = uniq.filter((x) => x.action === '@提醒' || x.action === '回复评论');
    const head = mentions.length
      ? `有 ${mentions.length} 条 @ 或评论回复：`
      : `共 ${uniq.length} 条通知：`;

    return { content: [{ type: 'text', text: `${head}\n\n${text}` }] };
  },
);

// ── 回复别人的评论 ────────────────────────────────────────────────────────
// 和 douyin_comment（发新评论）不同：这个是在某条已有评论下面回复，
// 对方会收到「XX 回复了你的评论」的通知。
server.tool(
  'douyin_comment_list',
  '列出视频下可回复的评论，带每条的位置。回复前先用它确认要回哪一条。',
  {
    aweme_id: z.string().min(1).describe('视频 ID'),
    limit: z.number().int().min(1).max(30).optional().describe('最多列几条，默认 15'),
  },
  async ({ aweme_id, limit }) => {
    const res = await withReader(async (_reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(path.join(DY_DIR, 'douyin-comment.mjs')).href);
      const cm = new mod.DouyinComment(b.page);

      await b.page.goto(`https://www.douyin.com/video/${aweme_id}`, {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
      await new Promise((r) => setTimeout(r, 5000));
      return cm.listCommentTargets({ limit: limit ?? 15 });
    });

    if (!res.ok) return { content: [{ type: 'text', text: `读取失败：${res.error}` }], isError: true };
    const d = res.data;
    if (!d.comments?.length) {
      return { content: [{ type: 'text', text: '没找到可回复的评论（评论区可能没展开）' }] };
    }
    // 输出带上昵称、时间、地区 —— 判断该回哪条时要看这些
    const text = d.comments.map((c, i) => {
      const meta = [c.time, c.region].filter(Boolean).join('·');
      const authorMark = c.isAuthor ? ' [作者]' : '';
      return `${i + 1}. [${c.nick}]${authorMark} ${c.text}${meta ? `（${meta}）` : ''}`;
    }).join('\n');

    return {
      content: [{
        type: 'text',
        text: `评论 ${d.comments.length} 条：\n\n${text}\n\n` +
          '回复时可以用 match_text 指定这人的话里包含的片段，或用 index（从 0 开始）指定第几条。',
      }],
    };
  },
);

server.tool(
  'douyin_reply',
  '回复抖音视频下的某条评论（对方会收到回复通知）。'
  + '用 match_text 指定要回复哪条（该评论里包含的文字），或用 index 指定第几条。',
  {
    aweme_id: z.string().min(1).describe('视频 ID'),
    reply_text: z.string().min(1).max(200).describe('回复内容'),
    match_text: z.string().optional().describe('要回复的评论里包含的文字（模糊匹配）'),
    index: z.number().int().min(0).max(30).optional().describe('或直接指定第几条（从 0 开始，默认 0）'),
    dry_run: z.boolean().optional().describe('只输入不发送，用于验证'),
  },
  async ({ aweme_id, reply_text, match_text, index, dry_run }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_reply');
    if (denied) return denied;
    const res = await withReader(async (_reader, b) => {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(path.join(DY_DIR, 'douyin-comment.mjs')).href);
      const cm = new mod.DouyinComment(b.page);

      await b.page.goto(`https://www.douyin.com/video/${aweme_id}`, {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
      await new Promise((r) => setTimeout(r, 5000));

      return cm.replyToComment({
        matchText: match_text,
        replyText: String(reply_text),
        index: index ?? 0,
        dryRun: dry_run === true,
      });
    });

    if (!res.ok) return { content: [{ type: 'text', text: `回复失败：${res.error}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
  },
);

// ── 发布作品 ───────────────────────────────────────────────────────────────
// 链路：点首页「投稿」→ 打开 creator.douyin.com → setInputFiles 上传 → 填标题 → 点发布。
// 支持格式：mp4/mov/avi/mkv/webm/flv，1 小时以内、16G 以内。
// 这是不可逆的公开操作，所以默认 dry_run=false 但会在描述里强调。
server.tool(
  'douyin_publish',
  '发布抖音作品（视频）。传本地视频文件路径 + 标题/话题。'
  + '**这是公开发布，发出去所有粉丝都能看到**，不是草稿。所以：'
  + '① 只在对方明确要求时调；② 标题要真的像人写的，别堆砌关键词；'
  + '③ 拿不准就先 dry_run=true 只上传不发布，回报结果让人确认。',
  {
    video_path: z.string().min(1).describe('视频文件的本地绝对路径'),
    title: z.string().max(50).optional().describe('**标题**（短，一句话，约 20 字内）。和描述是两个不同的框'),
    desc: z.string().max(1000).optional().describe('**描述**（长，可写几段话 + #话题）。留空则只填标题'),
    music: z.string().max(60).optional()
      .describe('背景音乐：传歌名或风格关键词（如「轻音乐」「周杰伦」）。留空则不配乐。关键词越准越容易搜到'),
    dry_run: z.boolean().optional().describe('只上传不发布，默认 false'),
  },
  async ({ video_path, title, desc, music, dry_run }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_publish');
    if (denied) return denied;
    const res = await withReader(async (reader) => {
      return reader.publishVideo({
        videoPath: String(video_path),
        title: title || '',
        desc: desc || '',
        music: music || '',
        dryRun: dry_run === true,
      });
    });

    if (!res.ok) {
      return { content: [{ type: 'text', text: `发布失败：${res.error}` }], isError: true };
    }

    const d = res.data;
    if (d.error) {
      return { content: [{ type: 'text', text: `发布未完成：${d.error}` }], isError: true };
    }

    if (d.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `已上传到编辑界面（未发布）。\n标题：${d.title}\n\n确认要发的话，把 dry_run 去掉再调一次。`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: d.published
          ? `已发布！\n标题：${d.title}\n最终页面：${d.finalUrl}`
          : `上传成功但发布状态不确定。页面提示：${d.pageText}`,
      }],
    };
  },
);

server.tool(
  'douyin_publish_images',
  '发布抖音图文作品（多张图片 + 一段文字）。'
  + '比发视频轻量得多，适合随手记录：今天看到什么、想到什么、拍到了什么。'
  + '图片 1-9 张，单张 ≤50MB，支持 png/jpg/jpeg/webp/bmp。'
  + '**这是公开发布**，所有粉丝能看到。dry_run=true 可以只上传不发布。',
  {
    image_paths: z.array(z.string()).min(1).max(9).describe('图片的本地绝对路径数组（1-9 张）'),
    title: z.string().max(50).optional().describe('**标题**（短，一句话，约 20 字内）'),
    desc: z.string().max(1000).optional().describe('**描述**（长，可写几段话 + #话题）'),
    music: z.string().max(60).optional()
      .describe('背景音乐：传歌名或风格关键词（如「轻音乐」「周杰伦」）。留空则不配乐。关键词越准越容易搜到'),
    dry_run: z.boolean().optional().describe('只上传不发布，默认 false'),
  },
  async ({ image_paths, title, desc, music, dry_run }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_publish_images');
    if (denied) return denied;
    const res = await withReader(async (reader) => {
      return reader.publishImages({
        imagePaths: image_paths,
        title: title || '',
        desc: desc || '',
        music: music || '',
        dryRun: dry_run === true,
      });
    });

    if (!res.ok) return { content: [{ type: 'text', text: `发布失败：${res.error}` }], isError: true };
    const d = res.data;
    if (d.error) return { content: [{ type: 'text', text: `未完成：${d.error}` }], isError: true };

    if (d.dryRun) {
      return {
        content: [{
          type: 'text',
          text: `已上传 ${d.imageCount} 张图到编辑界面（未发布）。\n配文：${d.title}`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: d.published
          ? `已发布！${d.imageCount} 张图\n配文：${d.title}`
          : `上传成功但发布状态不确定：${d.pageText}`,
      }],
    };
  },
);

// ── 一步到位：配图（没有就生成）+ 发布 ──────────────────────────────────────
// 用户要求：「发布和主题一致的图或视频，没有的话就生成」。
// 这个工具把「找素材 → 配文 → 发布」合成一步，减少出错环节。
server.tool(
  'douyin_publish_auto',
  '发一条图文作品，自动保证配图和主题一致：传了图片就用，没传就按主题现画。'
  + '这是发日常动态的**首选**方式。只给 theme（主题）就行，图会自动配。',
  {
    theme: z.string().min(1).max(200)
      .describe('这条动态的主题/内容，一句话说清楚。配图会按它生成。例：傍晚的云，橘红色一片'),
    image_paths: z.array(z.string()).max(9).optional()
      .describe('可选：已有的图片路径。不给就按 theme 自动生成'),
    title: z.string().max(50).optional()
      .describe('标题（短，默认取 theme 的浓缩版）'),
    desc: z.string().max(1000).optional()
      .describe('描述（长，可写感受 + #话题）。不给就用 theme 展开'),
    music: z.string().max(60).optional()
      .describe('背景音乐关键词（如「轻音乐」「钢琴」）。留空不配乐'),
    dry_run: z.boolean().optional().describe('只上传不发布'),
  },
  async ({ theme, image_paths, title, desc, music, dry_run }) => {
    // 写操作总开关
    const denied = assertWritesAllowed('douyin_publish_auto');
    if (denied) return denied;
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const urlx = await import('node:url');

    let imgs = Array.isArray(image_paths) ? image_paths.filter((p) => fsx.existsSync(p)) : [];
    const steps = [];

    // 1. 没有可用图 → 按主题生成
    if (!imgs.length) {
      steps.push('没有现成图片，按主题生成');
      try {
        // 直接复用本目录的 comfyui MCP 的 HTTP 接口
        const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
        const OUT_DIR = pathx.join(DY_DIR, '..', 'qq-bridge', 'state', 'comfy-out');
        fsx.mkdirSync(OUT_DIR, { recursive: true });

        // 先查模型名
        const info = await fetch(`${COMFY}/object_info`, { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
        const unet = info?.UNETLoader?.input?.required?.unet_name?.[0]?.[0];
        const clip = info?.CLIPLoader?.input?.required?.clip_name?.[0]?.[0];
        const vae = info?.VAELoader?.input?.required?.vae_name?.[0]?.[0];
        if (!unet || !clip || !vae) throw new Error('ComfyUI 模型清单不全');

        const seed = Math.floor(Math.random() * 1e15);
        const workflow = {
          '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
          '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan', device: 'default' } },
          '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
          '4': { class_type: 'CLIPTextEncode', inputs: { text: theme, clip: ['2', 0] } },
          '5': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, blurry, watermark, text', clip: ['2', 0] } },
          '6': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
          '7': { class_type: 'KSampler', inputs: { seed, steps: 22, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
          '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
          '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: `auto-${Date.now()}` } },
        };

        const q = await fetch(`${COMFY}/prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: workflow, client_id: `autopost-${process.pid}` }),
          signal: AbortSignal.timeout(30000),
        }).then((r) => r.json());
        if (q?.node_errors && Object.keys(q.node_errors).length) {
          throw new Error('工作流被拒: ' + JSON.stringify(q.node_errors).slice(0, 150));
        }

        // 等生成完
        const pid = q.prompt_id;
        let entry = null;
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const hist = await fetch(`${COMFY}/history/${pid}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
          entry = hist?.[pid];
          if (entry) break;
        }
        if (!entry) throw new Error('生成超时');

        // 拿到文件名
        const outs = entry.outputs || {};
        let fileName = null;
        for (const o of Object.values(outs)) {
          const f = (o.images || [])[0];
          if (f?.filename) { fileName = f.filename; break; }
        }
        if (!fileName) throw new Error('生成完成但没找到文件');

        // 从 ComfyUI 下载到本地
        const dl = `${COMFY}/view?filename=${encodeURIComponent(fileName)}&type=output`;
        const buf = Buffer.from(await fetch(dl, { signal: AbortSignal.timeout(60000) }).then((r) => r.arrayBuffer()));
        const local = pathx.join(OUT_DIR, `auto-${Date.now()}.png`);
        fsx.writeFileSync(local, buf);
        imgs = [local];
        steps.push(`自动生成配图：${pathx.basename(local)}`);

        // 释放显存
        fetch(`${COMFY}/free`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        }).catch(() => {});
      } catch (e) {
        return {
          content: [{ type: 'text', text: `自动配图失败：${String(e?.message ?? e).slice(0, 150)}\n可以先用 comfy_generate 画一张，再传 image_paths。` }],
          isError: true,
        };
      }
    } else {
      steps.push(`用已有图片 ${imgs.length} 张`);
    }

    // 2. 发布
    const res = await withReader(async (reader) => {
      return reader.publishImages({
        imagePaths: imgs,
        title: title || theme.slice(0, 20),
        desc: desc || theme,
        music: music || '',
        dryRun: dry_run === true,
      });
    });

    if (!res.ok) return { content: [{ type: 'text', text: `发布失败：${res.error}` }], isError: true };
    const d = res.data;
    if (d.error) return { content: [{ type: 'text', text: `未完成：${d.error}` }], isError: true };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...d, 步骤: steps, 图片: imgs }, null, 2),
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('douyin MCP 就绪（浏览器懒加载，首次调用约 10 秒）');