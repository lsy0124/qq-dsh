#!/usr/bin/env node
// install-skills.mjs — 把仓库里的 skills/ 装到 DSH 的技能目录
//
// 为什么需要：DSH 的 skill 自动发现只认两个根目录
//   $DSH_HOME/skills
//   $DSH_HOME/redteam/skills
// 仓库里的 skills/ 不会被自动扫描，必须复制过去。
//
// 用法：
//   node scripts/install-skills.mjs
//   node scripts/install-skills.mjs --uninstall   删掉装过的

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'skills');
const UNINSTALL = process.argv.includes('--uninstall');

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

function ok(s) { console.log(`${C.green}  ✓${C.reset} ${s}`); }
function bad(s) { console.log(`${C.red}  ✗${C.reset} ${s}`); }
function info(s) { console.log(`${C.dim}    ${s}${C.reset}`); }

// DSH_HOME
const DSH_HOME = process.env.DSH_HOME
  || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness')
    : path.join(os.homedir(), '.dsh'));

const DEST = path.join(DSH_HOME, 'skills');

console.log(`\n${C.bold}${C.cyan}qq-dsh 技能安装${C.reset}\n`);
info(`来源：${SRC}`);
info(`目标：${DEST}`);
console.log('');

if (!fs.existsSync(DSH_HOME)) {
  bad(`找不到 DSH_HOME（${DSH_HOME}）`);
  info('DSH Desktop 没装？装在别处就设 DSH_HOME 环境变量。');
  process.exit(1);
}

if (!fs.existsSync(SRC)) {
  bad('仓库里没有 skills/ 目录');
  process.exit(1);
}

const skillFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.md'));

if (!skillFiles.length) {
  bad('skills/ 里没有 .md 文件');
  process.exit(1);
}

if (UNINSTALL) {
  console.log('卸载模式：删除已安装的技能\n');
  let n = 0;
  for (const f of skillFiles) {
    const target = path.join(DEST, f);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      ok(`已删除 ${f}`);
      n++;
    } else {
      info(`${f} 不存在，跳过`);
    }
  }
  console.log(`\n删除了 ${n} 个技能。重启 DSH 生效。\n`);
  process.exit(0);
}

// 安装
fs.mkdirSync(DEST, { recursive: true });

let installed = 0;
let skipped = 0;

for (const f of skillFiles) {
  const src = path.join(SRC, f);
  const dst = path.join(DEST, f);

  // 已存在且内容相同 → 跳过
  if (fs.existsSync(dst)) {
    const a = fs.readFileSync(src, 'utf8');
    const b = fs.readFileSync(dst, 'utf8');
    if (a === b) {
      info(`${f} 已是最新`);
      skipped++;
      continue;
    }
    // 内容不同 → 覆盖（但先备份）
    fs.copyFileSync(dst, dst + '.bak');
    info(`${f} 有更新，已备份原文件为 .bak`);
  }

  fs.copyFileSync(src, dst);
  ok(`${f}`);
  installed++;
}

console.log('');
if (installed) {
  console.log(`${C.green}${C.bold}装了 ${installed} 个技能${C.reset}${skipped ? `（${skipped} 个已是最新）` : ''}`);
} else {
  console.log(`${C.green}全部是最新的，无需安装${C.reset}`);
}

console.log(`
${C.yellow}重启 DSH 后生效。${C.reset}

验证：重启后在 DSH 里问「你有什么技能」，
      或者看系统注入的 <available_skills> 里有没有：
        · qq-voice          说话与唱歌
        · qq-social         说说与社交形象
        · douyin-publish    发抖音作品
        · douyin-interact   抖音互动

卸载：node scripts/install-skills.mjs --uninstall
`);
