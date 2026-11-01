#!/usr/bin/env node
// 给表情库批量写 AI 认知（localNote / tags / usage）
//
// 用途：表情包加进来以后，让 AI 知道"这张图什么情绪、什么场合该用"，
//      否则它只看到 desc（甚至 desc 是错的），选不准就不敢发。
//
// 用法:
//   node scripts/annotate-stickers.mjs notes.json [选项]
//   node scripts/annotate-stickers.mjs --report           # 只报告：哪些表情还没写认知
//
// notes.json 格式（按 QQ 收藏顺序的序号，从 1 开始）:
//   [ {"i":1,"note":"橘猫吐舌头逗人","tags":["调皮","卖萌"]}, ... ]
//   也支持按 md5 指定: {"md5":"CC32F4...","note":"...","tags":[...]}
//
// 选项:
//   --key <会话key>       默认 private:<ownerQQ>
//   --report              只列出未标注/已标注统计，不写
//   --overwrite           覆盖已有 localNote（默认只补空的）
//   --dry-run             只打印将写入的内容
//
// 流程:
//   1) 触发一次表情库同步（确保 QQ 新增的表情进了本地库）
//   2) 按序号/ md5 映射到 emoji_id
//   3) POST /api/socialV2/sticker-note 写 note/tags
//
// 以后加新表情：把新图放进文件夹 → 跑 bulk-add-stickers.mjs 上传
//              → 跑本脚本 --report 看哪些没写 → 补 notes.json → 再跑本脚本

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(BRIDGE_ROOT, 'config.json');
const CONSOLE_TOKEN_PATH = path.join(BRIDGE_ROOT, 'state', 'console-token');

function parseArgs(argv) {
  const a = { notesFile: '', key: '', report: false, overwrite: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--key') a.key = argv[++i] ?? '';
    else if (t === '--report') a.report = true;
    else if (t === '--overwrite') a.overwrite = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t.startsWith('--')) throw new Error(`未知选项: ${t}`);
    else rest.push(t);
  }
  a.notesFile = rest[0] ?? '';
  return a;
}

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const token = cfg.snowluma?.accessToken || '';
  const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const consolePort = cfg.consolePort || 3100;
  return { cfg, token, httpUrl, consolePort, ownerQQ: cfg.ownerQQ };
}

async function snowluma(token, httpUrl, action, payload) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'ok' && json.retcode !== 0) {
    throw new Error(`${action} 失败: ${json.wording || JSON.stringify(json).slice(0, 150)}`);
  }
  return json.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cfg, token, httpUrl, consolePort, ownerQQ } = loadConfig();
  const key = args.key || `private:${ownerQQ}`;

  console.log(`会话: ${key}`);
  console.log(`SnowLuma: ${httpUrl}`);

  // 1) 同步一次，保证本地库是最新的
  let faces = await snowluma(token, httpUrl, 'fetch_custom_face_detail', { count: 1000 });
  if (!Array.isArray(faces)) throw new Error('fetch_custom_face_detail 没返回数组');
  console.log(`QQ 收藏表情: ${faces.length} 个`);

  // 拉本地库现状（通过 console 的 GET /api/stickers）
  let local = { stickers: [] };
  try {
    const ct = fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${consolePort}/api/stickers?count=500`, {
      headers: { 'x-console-token': ct },
    });
    local = await r.json();
  } catch (e) {
    console.warn(`⚠ 读本地库失败（继续尝试写）: ${e.message}`);
  }
  const localById = new Map((local.stickers || []).map((s) => [s.id, s]));
  console.log(`本地库: ${(local.stickers || []).length} 条`);

  // 2) --report：报告标注覆盖率
  if (args.report) {
    let hasNote = 0;
    const missing = [];
    faces.forEach((f, i) => {
      const l = localById.get(f.emoji_id);
      if (l && l.localNote) hasNote++;
      else missing.push({ i: i + 1, desc: f.desc || '(无备注)', md5: f.md5 });
    });
    console.log(`\n已标注 ${hasNote} / ${faces.length}`);
    console.log(`未标注 ${missing.length} 个：`);
    for (const m of missing) console.log(`  #${m.i}  ${m.desc}  ${m.md5}`);
    return;
  }

  // 3) 读 notes.json
  if (!args.notesFile) {
    console.error('需要 notes.json，或用 --report 查看未标注清单');
    process.exit(1);
  }
  // 去掉 BOM：PowerShell 的 Out-File 默认带 BOM，JSON.parse 会因此失败
  const rawNotes = fs.readFileSync(path.resolve(args.notesFile), 'utf8').replace(/^\uFEFF/, '');
  const notes = JSON.parse(rawNotes);
  console.log(`notes.json: ${notes.length} 条认知`);

  // 4) 建立索引：序号 → emoji_id，md5 → emoji_id
  const byIdx = new Map();
  const byMd5 = new Map();
  faces.forEach((f, i) => {
    byIdx.set(i + 1, f.emoji_id);
    byMd5.set(String(f.md5 || '').toUpperCase(), f.emoji_id);
  });

  let ok = 0, skipped = 0, fail = 0;
  const failures = [];

  for (const n of notes) {
    let emojiId = null;
    if (n.i != null) emojiId = byIdx.get(Number(n.i));
    else if (n.md5) emojiId = byMd5.get(String(n.md5).toUpperCase());
    if (!emojiId) {
      fail++;
      failures.push({ which: n.i ?? n.md5, error: '找不到对应 emoji_id（序号越界？）' });
      continue;
    }

    const cur = localById.get(emojiId);
    if (!args.overwrite && cur && cur.localNote) {
      skipped++;
      continue;
    }

    const body = { key, stickerId: emojiId, note: n.note ?? '' };
    if (Array.isArray(n.tags) && n.tags.length) body.tags = n.tags;
    if (n.usage) body.usage = n.usage;

    if (args.dryRun) {
      console.log(`  [dry] #${n.i} ${emojiId} → ${n.note}  [${(n.tags || []).join('/')}]`);
      ok++;
      continue;
    }

    try {
      // 控制台全局要求 x-console-token；端点内部还会校验 x-agent-token 的会话绑定。
      // 两个都要带，否则会被 401（控制台令牌）或 403（会话令牌）挡下。
      const agentToken = getAgentToken(key);
      const res = await fetch(`http://127.0.0.1:${consolePort}/api/socialV2/sticker-note`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-console-token': readConsoleToken(),
          'x-agent-token': agentToken,
        },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || JSON.stringify(j).slice(0, 150));
      ok++;
      if (ok % 10 === 0) console.log(`  …已写 ${ok}/${notes.length}`);
    } catch (e) {
      fail++;
      failures.push({ which: n.i, error: e.message });
    }
    if (args.delay !== 0) await sleep(60);
  }

  console.log(`\n完成：写入 ${ok}，跳过（已有认知）${skipped}，失败 ${fail}`);
  if (failures.length) {
    console.log('失败清单：');
    for (const f of failures.slice(0, 20)) console.log(`  #${f.which}  ${f.error}`);
    process.exitCode = 1;
  }
}

// 取会话的 agent token（从 social-v2.json 读，避免每次算）
function getAgentToken(key) {
  const p = path.join(BRIDGE_ROOT, 'state', 'social-v2.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const st = j.conversations?.[key];
  if (!st?.agentToken) throw new Error(`会话 ${key} 没有 agentToken`);
  return st.agentToken;
}

// 控制台令牌：所有 /api/* 请求的全局闸门
function readConsoleToken() {
  try {
    return fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

main().catch((e) => {
  console.error(`✘ ${e.message}`);
  process.exit(1);
});
