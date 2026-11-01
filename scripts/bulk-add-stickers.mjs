#!/usr/bin/env node
// 批量给 QQ 号添加收藏表情（custom face）
//
// 用法:
//   node scripts/bulk-add-stickers.mjs <图片文件夹> [选项]
//
// 选项:
//   --desc-file <json>    可选：{ "文件名或md5": "备注文字", ... }，加完自动改备注
//   --limit <n>           最多处理 n 张（调试用）
//   --concurrency <n>     并发数，默认 2（QQ 侧有频率限制，别超过 3）
//   --delay <ms>          每张之间额外等待，默认 800
//   --dry-run             只列出将要做的事，不真上传
//   --no-skip             不跳过已存在的（默认按 md5 跳过重复）
//
// 例:
//   node scripts/bulk-add-stickers.mjs "D:\表情包\鲸鱼"
//   node scripts/bulk-add-stickers.mjs "D:\表情包\鲸鱼" --desc-file desc.json
//
// 说明:
//   · 走 SnowLuma 的 OneBot HTTP（默认 127.0.0.1:3000，token 从 config.json 读）
//   · 支持 png / jpg / jpeg / gif / webp
//   · 已存在的表情按 md5 跳过，重复跑不会堆一堆重复图
//   · 上传后如果给了 --desc-file，会调 modify_custom_face 写备注

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(BRIDGE_ROOT, 'config.json');

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function parseArgs(argv) {
  const args = { dir: '', descFile: '', limit: 0, concurrency: 2, delay: 800, dryRun: false, skip: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--desc-file') args.descFile = argv[++i] ?? '';
    else if (a === '--limit') args.limit = Number(argv[++i] ?? 0) || 0;
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i] ?? 2) || 2);
    else if (a === '--delay') args.delay = Math.max(0, Number(argv[++i] ?? 800) || 0);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-skip') args.skip = false;
    else if (a.startsWith('--')) throw new Error(`未知选项: ${a}`);
    else rest.push(a);
  }
  args.dir = rest[0] ?? '';
  return args;
}

function loadEndpoint() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const httpUrl = (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = cfg.snowluma?.accessToken || '';
  if (!token) throw new Error('config.json 里没有 snowluma.accessToken');
  return { httpUrl, token };
}

async function callApi(endpoint, action, payload) {
  const res = await fetch(`${endpoint.httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${action} 返回非 JSON: ${text.slice(0, 200)}`);
  }
  if (json.status !== 'ok' && json.retcode !== 0) {
    throw new Error(`${action} 失败: ${json.wording || json.message || text.slice(0, 200)}`);
  }
  return json.data;
}

function md5Of(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function listImages(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && EXTS.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('用法: node scripts/bulk-add-stickers.mjs <图片文件夹> [--desc-file desc.json] [--limit n] [--concurrency n] [--delay ms] [--dry-run]');
    process.exit(1);
  }
  const absDir = path.resolve(args.dir);
  if (!fs.existsSync(absDir)) throw new Error(`文件夹不存在: ${absDir}`);

  const endpoint = loadEndpoint();
  const files = listImages(absDir);
  if (!files.length) {
    console.log(`文件夹里没有可用的图片: ${absDir}`);
    return;
  }

  let descMap = {};
  if (args.descFile) {
    descMap = JSON.parse(fs.readFileSync(path.resolve(args.descFile), 'utf8'));
  }

  // 拉现有收藏，按 md5 去重
  const existing = await callApi(endpoint, 'fetch_custom_face_detail', { count: 1000 });
  const existingMd5 = new Set((existing ?? []).map((e) => String(e.md5 || '').toUpperCase()));
  console.log(`现有收藏 ${existingMd5.size} 个；待处理图片 ${files.length} 张`);

  const todo = [];
  let skipped = 0;
  for (const f of files) {
    const md5 = md5Of(f);
    if (args.skip && existingMd5.has(md5)) {
      skipped++;
      continue;
    }
    todo.push({ file: f, md5, name: path.basename(f) });
    if (args.limit && todo.length >= args.limit) break;
  }

  console.log(`跳过重复 ${skipped} 张，实际上传 ${todo.length} 张`);
  if (args.dryRun) {
    for (const t of todo) console.log(`  [dry] ${t.name}  ${t.md5}`);
    return;
  }
  if (!todo.length) return;

  let ok = 0;
  let fail = 0;
  const failures = [];
  let cursor = 0;

  const worker = async (wid) => {
    while (true) {
      const idx = cursor++;
      if (idx >= todo.length) return;
      const item = todo[idx];
      try {
        const data = await callApi(endpoint, 'add_custom_face', { file: item.file });
        const emojiId = data?.emoji_id ?? data;
        ok++;
        existingMd5.add(item.md5);

        // 备注：优先按文件名，其次按 md5
        const desc = descMap[item.name] ?? descMap[item.md5] ?? '';
        if (desc) {
          try {
            await callApi(endpoint, 'modify_custom_face', { emoji_id: emojiId, desc });
          } catch (e) {
            console.warn(`  ⚠ 备注失败 ${item.name}: ${e.message}`);
          }
        }
        console.log(`  ✔ [${wide(wid)}] ${String(ok + fail).padStart(3)}/${todo.length} ${item.name} → ${emojiId}${desc ? ` (${desc})` : ''}`);
      } catch (e) {
        fail++;
        failures.push({ file: item.file, error: e.message });
        console.error(`  ✘ [${wide(wid)}] ${item.name}: ${e.message}`);
      }
      if (args.delay) await sleep(args.delay);
    }
  };

  // 固定并发池
  await Promise.all(Array.from({ length: Math.min(args.concurrency, todo.length) }, (_, i) => worker(i + 1)));

  console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
  if (failures.length) {
    console.log('失败清单:');
    for (const f of failures) console.log(`  ${f.file}  ←  ${f.error}`);
    process.exitCode = failures.length ? 1 : 0;
  }
}

const wide = (n) => String(n).padStart(2, '0');

main().catch((e) => {
  console.error(`✘ ${e.message}`);
  process.exit(1);
});
