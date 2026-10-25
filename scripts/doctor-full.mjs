#!/usr/bin/env node
// doctor-full.mjs — 一键体检：把「跑起来需要什么」全查一遍
//
// 为什么需要它：
//   qq-bridge 的依赖分成两类 ——
//     · 仓库内的（node_modules、配置文件、preset）
//     · 仓库外的（QQ、SnowLuma、DSH、Playwright、GPT-SoVITS...）
//   第二类没法 npm install，而且缺了往往要在运行时才炸。
//   这个脚本在启动前把所有依赖摸一遍，缺什么、怎么补、影响哪个功能，一次说清。
//
// 用法：
//   node scripts/doctor-full.mjs          只检查
//   node scripts/doctor-full.mjs --fix    能自动补的顺手补上

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIX = process.argv.includes('--fix');

// ── 输出 ────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (s) => console.log(`${C.green}  ✓${C.reset} ${s}`);
const bad = (s) => console.log(`${C.red}  ✗${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}  !${C.reset} ${s}`);
const info = (s) => console.log(`${C.dim}    ${s}${C.reset}`);
const head = (s) => console.log(`\n${C.bold}${C.cyan}${s}${C.reset}`);

const problems = [];   // 阻断性问题
const warnings = [];   // 不影响主链路

function fail(msg, hint) {
  problems.push({ msg, hint });
  bad(msg);
  if (hint) info(hint);
}
function soft(msg, hint) {
  warnings.push({ msg, hint });
  warn(msg);
  if (hint) info(hint);
}

// ── 工具 ────────────────────────────────────────────────────────────────
function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

/**
 * 自动发现外部工具。检查顺序：
 *   ① config.json 的 paths 段
 *   ② 环境变量
 *   ③ PATH
 *   ④ 仓库上级目录的常见布局（RVC/ GPT-SoVITS/ 等）
 *
 * 为什么要这样：很多人装了 RVC 但没加 PATH，
 * 只看 PATH 会误报「没装」，反而误导。
 */
function discover(cfg) {
  const parents = [
    path.resolve(ROOT, '..'),
    path.resolve(ROOT, '..', '..'),
  ];

  const findIn = (base, rels) => {
    for (const rel of rels) {
      const p = path.join(base, rel);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  // FFmpeg
  let ffmpeg = cfg?.paths?.ffmpeg || process.env.FFMPEG_PATH || which('ffmpeg');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    for (const base of parents) {
      const found = findIn(base, [
        'RVC/RVC20260718Nvidia50x0/ffmpeg.exe',
        'RVC/ffmpeg.exe',
        'ffmpeg/bin/ffmpeg.exe',
      ]);
      if (found) { ffmpeg = found; break; }
    }
  }

  // Python（ASR 用）
  let python = cfg?.paths?.python || process.env.ASR_PYTHON || process.env.TTS_PYTHON || which('python');
  if (!python || !fs.existsSync(python)) {
    for (const base of parents) {
      const found = findIn(base, [
        'GPT-SoVITS/GPT-SoVITS-v2pro-20250604-nvidia50/runtime/python.exe',
        'RVC/RVC20260718Nvidia50x0/runtime/python.exe',
      ]);
      if (found) { python = found; break; }
    }
  }

  // RVC 目录
  let rvc = cfg?.paths?.rvcDir || cfg?.rvc?.dir || process.env.RVC_DIR;
  if (!rvc || !fs.existsSync(rvc)) {
    for (const base of parents) {
      const found = findIn(base, ['RVC', 'rvc', 'RVC20260718Nvidia50x0']);
      if (found) { rvc = found; break; }
    }
  }

  // GPT-SoVITS 目录
  let gsv = cfg?.paths?.gptSovits || process.env.GPT_SOVITS_DIR;
  if (!gsv || !fs.existsSync(gsv)) {
    for (const base of parents) {
      const found = findIn(base, [
        'GPT-SoVITS/GPT-SoVITS-v2pro-20250604-nvidia50',
        'GPT-SoVITS',
      ]);
      if (found) { gsv = found; break; }
    }
  }

  return { ffmpeg, python, rvc, gsv };
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
    s.connect(port, host);
  });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── 1. 基础环境 ──────────────────────────────────────────────────────────
head('1. 基础环境');

const nodeVer = process.versions.node;
const [major, minor] = nodeVer.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) {
  ok(`Node.js ${nodeVer}`);
} else {
  fail(`Node.js ${nodeVer}，需要 ≥ 22.13`, '去 https://nodejs.org 装 LTS 版');
}

const npmVer = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (npmVer.status === 0) ok(`npm ${npmVer.stdout.trim()}`);
else fail('npm 不可用', '重装 Node.js（勾选 npm）');

// ── 2. 仓库依赖 ──────────────────────────────────────────────────────────
head('2. 仓库依赖');

if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const missing = [];
  for (const dep of Object.keys(pkg?.dependencies || {})) {
    if (!fs.existsSync(path.join(ROOT, 'node_modules', dep))) missing.push(dep);
  }
  if (missing.length === 0) {
    ok('dependencies 完整');
  } else {
    fail(`缺少 ${missing.length} 个依赖：${missing.join(', ')}`, '运行 npm install');
    if (FIX) {
      console.log('    正在执行 npm install…');
      const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status === 0) ok('已补上');
    }
  }
} else {
  fail('没有 node_modules', '运行 npm ci 或 npm install');
}

// playwright-core（抖音需要）
if (fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core'))) {
  ok('playwright-core（抖音依赖）');
} else {
  soft('没有 playwright-core —— 抖音功能不可用', '运行 npm install playwright-core');
}

// ── 3. 配置文件 ──────────────────────────────────────────────────────────
head('3. 配置文件');

const cfgPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(cfgPath)) {
  fail('没有 config.json', '运行 npm run init（复制 config.example.json）');
  if (FIX) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), cfgPath);
    ok('已从模板创建 config.json');
  }
} else {
  const cfg = readJson(cfgPath);
  if (!cfg) {
    fail('config.json 无法解析（JSON 语法错误）');
  } else {
    ok('config.json 存在且可解析');

    // 关键字段
    const dshUrl = cfg.dsh?.baseUrl;
    if (!dshUrl || dshUrl.includes('example') || dshUrl === 'http://127.0.0.1:43129') {
      info(`dsh.baseUrl = ${dshUrl || '(空)'} —— 确认这是你 DSH 的实际地址`);
    } else {
      ok(`dsh.baseUrl = ${dshUrl}`);
    }

    const tok = cfg.snowluma?.accessToken;
    if (!tok) fail('snowluma.accessToken 为空', '从 SnowLuma 控制台 → 网络配置 → HTTP accessToken');
    else if (/^<.*>$/.test(tok)) fail('snowluma.accessToken 还是占位符', '填真实的 OneBot HTTP token');
    else ok('snowluma.accessToken 已填');

    const allow = cfg.allow || {};
    const priv = (allow.private || []).filter(Boolean);
    const grp = (allow.groups || []).filter(Boolean);
    if (!priv.length && !grp.length) {
      fail('白名单为空 —— 桥接不会回复任何 QQ', '在 config.json 的 allow.private / allow.groups 填 QQ 号');
    } else {
      ok(`白名单：私聊 ${priv.length} 个，群 ${grp.length} 个`);
    }

    const owner = cfg.ownerQQ;
    if (!owner || owner === 100000000) fail('ownerQQ 还是占位符', '填你自己的 QQ 号');
    else ok(`ownerQQ = ${owner}`);
  }
}

// ── 4. 外部服务 ──────────────────────────────────────────────────────────
head('4. 外部服务（这些装不了，只能你自己装）');

const cfg = readJson(cfgPath) || {};

// DSH
const dshUrl = cfg.dsh?.baseUrl || 'http://127.0.0.1:43129';
const dshPort = Number((dshUrl.match(/:(\d+)/) || [])[1] || 43129);
if (await portOpen(dshPort)) {
  ok(`DSH Desktop 在线（:${dshPort}）`);
} else {
  fail(`DSH Desktop 未启动（:${dshPort} 不开）`, '先打开 DSH Desktop；端口不对就改 config.json 的 dsh.baseUrl');
}

// SnowLuma / OneBot
const obUrl = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const obPort = Number((obUrl.match(/:(\d+)/) || [])[1] || 3000);
const wsUrl = cfg.snowluma?.wsUrl || 'ws://127.0.0.1:3001';
const wsPort = Number((wsUrl.match(/:(\d+)/) || [])[1] || 3001);

const obUp = await portOpen(obPort);
const wsUp = await portOpen(wsPort);

if (obUp && wsUp) {
  ok(`SnowLuma / OneBot 在线（HTTP :${obPort}，WS :${wsPort}）`);

  // 验证 token 有效
  const tok = cfg.snowluma?.accessToken;
  if (tok && !/^<.*>$/.test(tok)) {
    try {
      const res = await fetch(`${obUrl}/get_login_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const t = await res.text();
      if (t.includes('"status":"ok"')) {
        const m = t.match(/"nickname":"([^"]+)"/);
        ok(`OneBot token 有效${m ? `（账号：${m[1]}）` : ''}`);
      } else {
        fail('OneBot token 无效或账号未登录', '检查 accessToken；QQ 没登录就先去登录');
      }
    } catch (e) {
      warn(`OneBot HTTP 无法验证：${String(e.message).slice(0, 50)}`);
    }
  }
} else {
  if (!obUp) fail(`OneBot HTTP 未监听（:${obPort}）`, '启动 SnowLuma 并确认它已注入 QQ');
  if (!wsUp) fail(`OneBot WS 未监听（:${wsPort}）`, '同上一行：WS 不开通常意味着 QQ 没登录');
}

// QQ
const qqProcs = spawnSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe'], { encoding: 'utf8' });
if ((qqProcs.stdout || '').includes('QQ.exe')) {
  ok('QQ 进程在运行');
} else {
  fail('QQ 没在运行', '启动 QQ 并登录（SnowLuma 需要它才能注入）');
}

// ── 5. 可选能力 ──────────────────────────────────────────────────────────
head('5. 可选能力（缺了不影响聊天，只是对应功能不可用）');

const found = discover(cfg);
if (found.ffmpeg || found.python || found.rvc) {
  info('（以下路径为自动发现，不一定在 PATH 里）');
}

// ComfyUI
const comfyUrl = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const comfyPort = Number((comfyUrl.match(/:(\d+)/) || [])[1] || 8188);
if (await portOpen(comfyPort)) ok(`ComfyUI 在线（:${comfyPort}）—— 画图/视频可用`);
else soft(`ComfyUI 未启动（:${comfyPort}）`, '需要画图/视频时再开');

// GPT-SoVITS
if (await portOpen(9880)) ok('GPT-SoVITS 在线（:9880）—— 说话/唱歌可用');
else soft('GPT-SoVITS 未启动（:9880）', '需要发语音时再开');

// FFmpeg
const ff = found.ffmpeg;
if (ff && fs.existsSync(ff)) {
  ok(`FFmpeg：${ff}`);
  const enc = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', shell: false });
  const has264 = /h264_mf|h264_nvenc|h264_qsv|libx264/.test(enc.stdout || '');
  if (has264) ok('  h264 编码器可用（生成视频需要）');
  else soft('  FFmpeg 没有 h264 编码器 —— 视频生成会失败');
} else {
  soft('找不到 FFmpeg', '语音、点歌、视频都要它。装一个，或在 config.json 的 paths.ffmpeg 指定路径');
}

// Python / ASR
const py = found.python;
if (py && (fs.existsSync(py) || which(py))) {
  ok(`Python：${py}`);
} else {
  soft('找不到 Python', '语音转文字、点歌搜素材需要。或用 config.json 的 paths.python 指定');
}

// 音色模型
const rvcDir = found.rvc;
if (rvcDir && fs.existsSync(rvcDir)) {
  // 容错：不同 RVC 分发包目录结构不一样，可能没有 assets/weights
  let hasPth = false;
  let hasIndex = false;
  try {
    const weightsDir = path.join(rvcDir, 'assets', 'weights');
    if (fs.existsSync(weightsDir)) {
      hasPth = fs.readdirSync(weightsDir).some((f) => f.toLowerCase().endsWith('.pth'));
    }
    // 兜底：整个 RVC 目录搜一遍 .pth / .index（限制深度，别扫太久）
    if (!hasPth) {
      const scan = (dir, depth) => {
        if (depth > 3 || hasPth) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) scan(p, depth + 1);
          else if (e.name.toLowerCase().endsWith('.pth')) hasPth = true;
          else if (e.name.toLowerCase().endsWith('.index')) hasIndex = true;
        }
      };
      scan(rvcDir, 0);
    } else {
      try { hasIndex = fs.readdirSync(path.join(rvcDir, 'logs'), { recursive: true }).some((f) => String(f).endsWith('.index')); } catch {}
    }
  } catch {}

  if (hasPth) ok('RVC 音色模型（.pth）');
  else soft('RVC 目录里没有 .pth 模型 —— 唱歌不可用', '把训练好的 .pth 放到 <RVC>/assets/weights/');
  if (hasPth && !hasIndex) soft('没有 .index 索引 —— 唱歌音色会跑偏（详见 HANDOVER.md 4.4）', '用 RVC 的 train 功能补生成');
} else {
  soft('没配 RVC 目录', '唱歌功能需要：RVC_DIR 或 config.json 的 rvc.dir');
}

// 抖音登录态
const douyinProfile = path.join(ROOT, 'src', 'douyin', '.profile');
if (fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core'))) {
  if (fs.existsSync(douyinProfile)) ok('抖音浏览器 profile 存在');
  else soft('没有抖音浏览器 profile', '首次运行抖音功能会自动创建，需要扫码登录一次');
} else {
  info('（缺 playwright-core，抖音整块跳过）');
}

// 抖音写操作开关
const allowWrites = process.env.DOUYIN_ALLOW_WRITES === '1';
if (allowWrites) {
  warn('DOUYIN_ALLOW_WRITES=1 —— AI 可以发评论/作品/私信了');
  info('这是公开发布，删不干净。确认白名单配好了再保持开启。');
} else {
  ok('抖音写操作已禁用（只读模式）');
  info('要允许 AI 发作品/评论：设 DOUYIN_ALLOW_WRITES=1');
}

// ── 6. preset 是否装好 ───────────────────────────────────────────────────
head('6. DSH preset');

const DSH_HOME = process.env.DSH_HOME
  || (process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness')
    : path.join(os.homedir(), '.dsh'));

if (fs.existsSync(DSH_HOME)) {
  ok(`DSH_HOME：${DSH_HOME}`);
  const profile = process.env.DSH_PROFILE || 'web';
  const patchFile = path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const content = fs.readFileSync(patchFile, 'utf8');
    if (/qq-agent-presets|mcp-snowluma/.test(content)) ok(`profile "${profile}" 已挂载桥接插件`);
    else soft(`profile "${profile}" 里没看到桥接插件`, '运行 npm run setup-dsh（或 node scripts/setup-dsh.mjs ' + profile + '）');
  } else {
    soft(`profile "${profile}" 没有 cordis.patch.yml`, '运行 npm run setup-dsh');
  }
} else {
  soft(`找不到 DSH_HOME（${DSH_HOME}）`, 'DSH Desktop 没装，或者装在了别处 → 设 DSH_HOME');
}

// ── 汇总 ────────────────────────────────────────────────────────────────
head('汇总');

if (problems.length === 0) {
  console.log(`\n${C.green}${C.bold}  阻断性问题：0 个${C.reset}`);
  console.log(`${C.green}  可以启动了：npm start${C.reset}\n`);
} else {
  console.log(`\n${C.red}${C.bold}  阻断性问题：${problems.length} 个${C.reset}`);
  problems.forEach((p, i) => {
    console.log(`\n  ${i + 1}. ${p.msg}`);
    if (p.hint) console.log(`     ${C.dim}→ ${p.hint}${C.reset}`);
  });
  console.log('');
}

if (warnings.length) {
  console.log(`${C.yellow}  可选能力提示：${warnings.length} 个（不影响主链路）${C.reset}\n`);
}

process.exit(problems.length ? 1 : 0);
