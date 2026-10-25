#!/usr/bin/env node
// install.mjs — 一键安装
//
// 目标：把「仓库内能自动化的部分」全部做完，剩下装不了的明确告诉你。
//
// 步骤：
//   1. 检查 Node 版本
//   2. 装依赖（npm ci / install）
//   3. 创建 config.json（从模板）
//   4. 生成 preset（编译 agent.cordis.yml → patch）
//   5. 挂载到 DSH profile（可选，需要 DSH 已安装）
//   6. 跑体检，把缺的东西全部列出来
//
// 用法：
//   node scripts/install.mjs
//   node scripts/install.mjs --skip-dsh     不挂 DSH（只装依赖和配置）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKIP_DSH = process.argv.includes('--skip-dsh');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const step = (n, s) => console.log(`\n${C.bold}${C.cyan}[${n}] ${s}${C.reset}`);
const done = (s) => console.log(`${C.green}  ✓${C.reset} ${s}`);
const skip = (s) => console.log(`${C.dim}  · ${s}${C.reset}`);
const fail = (s) => console.log(`${C.red}  ✗${C.reset} ${s}`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: true,
    encoding: 'utf8',
    ...opts,
  });
}

console.log(`
${C.bold}qq-dsh 一键安装${C.reset}
${C.dim}仓库：${ROOT}${C.reset}
`);

// ────────────────────────────────────────────────────────────────────────
step(1, '检查 Node.js 版本');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) {
  done(`Node.js ${process.versions.node}`);
} else {
  fail(`Node.js ${process.versions.node} 太旧，需要 ≥ 22.13`);
  console.log(`
${C.yellow}请先升级 Node.js：${C.reset}
  https://nodejs.org/  （下载 LTS 版，装完重开终端）

然后重新运行：${C.cyan}node scripts/install.mjs${C.reset}
`);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
step(2, '安装依赖');

if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
  // 已有 node_modules，检查是否完整
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = Object.keys(pkg.dependencies || {})
    .filter((d) => !fs.existsSync(path.join(ROOT, 'node_modules', d)));

  if (missing.length === 0) {
    done('依赖已完整');
  } else {
    console.log(`  缺 ${missing.length} 个依赖，重新安装…`);
    const r = run('npm', ['install']);
    if (r.status === 0) done('依赖已安装');
    else { fail('npm install 失败'); process.exit(1); }
  }
} else {
  const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
  console.log(`  执行 npm ${hasLock ? 'ci' : 'install'} …`);
  const r = run('npm', [hasLock ? 'ci' : 'install']);
  if (r.status === 0) done('依赖已安装');
  else { fail('安装失败'); process.exit(1); }
}

// playwright-core（抖音）
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core'))) {
  console.log('  安装 playwright-core（抖音功能需要）…');
  const r = run('npm', ['install', 'playwright-core', '--save-optional'], { quiet: false });
  if (r.status === 0) done('playwright-core 已安装');
  else skip('playwright-core 装失败，抖音功能会不可用（不影响其他）');
} else {
  done('playwright-core');
}

// ────────────────────────────────────────────────────────────────────────
step(3, '创建配置文件');

const cfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(cfgPath)) {
  done('config.json 已存在（不覆盖）');
} else {
  const example = path.join(ROOT, 'config.example.json');
  if (!fs.existsSync(example)) {
    fail('找不到 config.example.json');
    process.exit(1);
  }
  fs.copyFileSync(example, cfgPath);
  done('已从模板创建 config.json');
  console.log(`${C.yellow}  ⚠ 还需要你手动填这几项：${C.reset}`);
  console.log(`      dsh.baseUrl             DSH Desktop 地址`);
  console.log(`      snowluma.accessToken    OneBot HTTP token`);
  console.log(`      ownerQQ                 你自己的 QQ 号`);
  console.log(`      allow.private/groups    允许回复的 QQ / 群（默认空 = 不回复任何消息）`);
}

// ────────────────────────────────────────────────────────────────────────
step(4, '生成 agent preset');

const buildScript = path.join(ROOT, 'scripts', 'build-agent-preset-patches.mjs');
if (fs.existsSync(buildScript)) {
  const r = run('node', [buildScript], { quiet: true });
  if (r.status === 0) {
    done('preset patch 已生成');
  } else {
    fail('生成失败：' + (r.stderr || '').slice(0, 200));
  }
} else {
  skip('没有 build-agent-preset-patches.mjs');
}

// ────────────────────────────────────────────────────────────────────────
step(5, '挂载到 DSH');

if (SKIP_DSH) {
  skip('已跳过（--skip-dsh）');
} else {
  const DSH_HOME = process.env.DSH_HOME
    || (process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness')
      : path.join(os.homedir(), '.dsh'));
  const profile = process.env.DSH_PROFILE || 'web';

  if (!fs.existsSync(DSH_HOME)) {
    skip(`找不到 DSH_HOME（${DSH_HOME}）`);
    console.log(`${C.dim}     DSH Desktop 没装的话，先装它；装在别处就设 DSH_HOME${C.reset}`);
  } else {
    const setupScript = path.join(ROOT, 'scripts', 'setup-dsh.mjs');
    if (!fs.existsSync(setupScript)) {
      skip('没有 setup-dsh.mjs');
    } else {
      console.log(`  挂载到 profile "${profile}" …`);
      const r = run('node', [setupScript, profile]);
      if (r.status === 0) done('已挂载到 DSH');
      else {
        fail('挂载失败');
        console.log(`${C.dim}     可能原因：DSH 版本不匹配，或 profile 名不对${C.reset}`);
        console.log(`${C.dim}     手动重试：node scripts/setup-dsh.mjs ${profile}${C.reset}`);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
step(6, '安装技能');

const skillsScript = path.join(ROOT, 'scripts', 'install-skills.mjs');
if (fs.existsSync(skillsScript)) {
  const r = run('node', [skillsScript]);
  if (r.status === 0) done('技能已安装');
  else skip('技能安装失败（不影响主链路，可稍后手动装）');
} else {
  skip('没有 install-skills.mjs');
}

// ────────────────────────────────────────────────────────────────────────
step(7, '体检');

console.log('');
const doctor = spawnSync('node', [path.join(ROOT, 'scripts', 'doctor-full.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
});

// ────────────────────────────────────────────────────────────────────────
console.log(`
${C.bold}════════════════════════════════════════════════════════════${C.reset}
`);

if (doctor.status === 0) {
  console.log(`${C.green}${C.bold}装好了，可以启动：${C.reset}`);
  console.log(`  ${C.cyan}npm start${C.reset}    （前台）`);
  console.log(`  ${C.cyan}start.bat${C.reset}     （双击也行）`);
} else {
  console.log(`${C.yellow}${C.bold}安装完成，但还有阻断性问题要解决。${C.reset}`);
  console.log(`按上面「汇总」里的提示逐项处理，然后重跑：`);
  console.log(`  ${C.cyan}node scripts/doctor-full.mjs${C.reset}`);
}

console.log(`
${C.dim}常用命令：${C.reset}
  ${C.cyan}node scripts/doctor-full.mjs${C.reset}    体检（看还缺什么）
  ${C.cyan}npm start${C.reset}                       启动桥接
  ${C.cyan}npm run setup-dsh${C.reset}              重新挂载到 DSH
  ${C.cyan}node scripts/check-onebot-status.mjs${C.reset}  查 OneBot 连接

${C.dim}文档：README.md（能力清单/依赖）· HANDOVER.md（架构+18个踩坑）${C.reset}
`);
