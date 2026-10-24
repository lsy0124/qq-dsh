import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getRuntimePaths, readLocalConfig } from './core/runtime-config.mjs';
import { runMediaProcess as run } from './core/media-process.mjs';

// 唱歌模块：把一段歌声音频转成麻勒勒的音色，然后发到 QQ。
//
// 能力边界（必须先说清楚，避免误期待）：
//   ✅ 有现成演唱的音频 → 换成目标音色
//   ❌ 凭空唱一首指定歌曲（那需要歌声合成 SVS + 目标人的歌声训练数据）
//
// 流程：
//   1. 输入音频（本地路径 / URL）
//   2. ffmpeg 统一成 40k/单声道 wav（RVC 要求的格式）
//   3. 调 RVC 推理脚本（rvc_infer.py，用环境变量传参）
//   4. ffmpeg 做响度归一化 + 转 mp3
//   5. 复制到桥接语音库，走 /api/send/voice 发出去

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const runtimePaths = getRuntimePaths();
const RVC_DIR = runtimePaths.rvcScriptsDir;
const RVC_APP = runtimePaths.rvcDir;
const RVC_OUT = runtimePaths.rvcOutputDir;
const FFMPEG = runtimePaths.ffmpeg;
const PYTHON = runtimePaths.rvcPython;
const INFER_SCRIPT = runtimePaths.rvcInferScript;
const VOICE_LIB = runtimePaths.voiceLibrary;

/**
 * 杀掉整个进程树（Windows）。
 *
 * 为什么必须这么做：p.kill() 只杀直接子进程，Python 派生的 CUDA 上下文会活下来
 * 继续占显存。实测三次中断就能吃满 8GB 卡，之后 RVC 从 GPU 掉到 CPU，
 * 合成耗时从 7 秒变成 485 秒。
 */
/**
 * 跑重任务前的环境准备。
 *
 * 为什么必须有这一步：RVC 中断后会残留 Python 进程占着显存，
 * 8GB 卡三次就满了，之后所有推理静默掉到 CPU，慢 70 倍。
 * 这个函数把「清理残留 + 检查显存」做成每次必跑的前置步骤。
 */
async function prepareGpu({ minFreeMB = 2200 } = {}) {
  const { spawn } = await import('node:child_process');

  // The shared runner terminates only this request's owned child on timeout.
  // 2. 查空闲显存（抽成函数，因为可能要查两次）
  const readFree = async () => {
    try {
      const probe = await run('nvidia-smi', ['--query-gpu=memory.free','--format=csv,noheader,nounits'], {timeoutMs:10000,maxOutputBytes:65536});
      const out = probe.stdout;
      const n = parseInt(String(out).trim().split('\n')[0], 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };

  let freeMB = await readFree();

  // 3. 不够就先让 ComfyUI 释放缓存，再查一次
  // 实测这台 8GB 卡：RVC 推理峰值要吃 2.6GB，空闲 2857MB 就够跑。
  // 所以门槛定 2200MB。不够时先尝试释放，而不是直接拒绝。
  if (freeMB !== null && freeMB < minFreeMB) {
    log(`显存不足（${freeMB}MB < ${minFreeMB}MB），尝试让 ComfyUI 释放缓存…`);
    const r = await tryFreeComfy();
    if (r.ok) {
      await new Promise((x) => setTimeout(x, 1200));
      freeMB = await readFree();
      log(`释放后空闲: ${freeMB}MB`);
    } else {
      log(`释放失败: ${r.reason}`);
    }
  }

  return { freeMB, enough: freeMB === null ? null : freeMB >= minFreeMB, minFreeMB };
}

/**
 * 显存不够时尝试让 ComfyUI 释放缓存（它有 /free 接口）。
 * 只释放模型缓存，不杀进程，之后 ComfyUI 还能继续用。
 */
async function tryFreeComfy() {
  try {
    const config=readLocalConfig();
    const base=String(process.env.COMFYUI_URL || config.comfyui?.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    const response=await fetch(base+'/free',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unload_models:true,free_memory:true}),signal:AbortSignal.timeout(15000)});
    return {ok:response.ok,reason:response.ok?'':`ComfyUI HTTP ${response.status}`};
  } catch { return {ok:false,reason:'ComfyUI is unavailable or timed out'}; }
}

/** Compatibility: never sweep unrelated Python processes. */
export async function killStalePython() { return { skipped: true }; }

function log(...a) {
  console.error('[sing]', ...a);
}

/**
 * 把音频转成 RVC 能吃的样子：单声道、40kHz、wav。
 * m4a/mp3/带视频的文件都先过这一步，避免 ffmpeg 在 RVC 内部报错。
 */
/**
 * 从音频里裁一段出来。
 *
 * 为什么这一步很重要：RVC 的耗时跟音频长度几乎线性相关。
 * 整首 3 分钟要 30 秒转换 + 可能的分离；只裁 30 秒就只要 5-8 秒。
 * 而且 QQ 单条语音约 60 秒上限，整首根本发不出去。
 *
 * @param {string} srcPath 输入
 * @param {number} startSec 起点（默认从 8 秒开始，跳过前奏/空白）
 * @param {number} durationSec 长度
 */
async function trimAudio(srcPath, { startSec = 8, durationSec = 30, tag } = {}) {
  const out = path.join(RVC_OUT, `_trim_${tag}.wav`);
  fs.mkdirSync(RVC_OUT, { recursive: true });

  // 先探测总时长，避免起点超出范围
  const probe = await run(FFMPEG, ['-i', srcPath, '-hide_banner'], { timeoutMs: 20000 });
  const dm = (probe.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  let totalSec = 0;
  if (dm) totalSec = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);

  // 起点自适应：短音频从头开始，长音频跳过前奏
  let start = startSec;
  if (totalSec > 0) {
    if (totalSec <= durationSec + 5) {
      start = 0;                                    // 本来就不长，别裁掉内容
    } else if (start + durationSec > totalSec) {
      start = Math.max(0, totalSec - durationSec);  // 尾巴不够就往前挪
    }
  }

  const r = await run(FFMPEG, [
    '-y', '-ss', String(start), '-i', srcPath,
    '-t', String(durationSec),
    '-vn', '-ac', '1', '-ar', '40000', '-c:a', 'pcm_s16le',
    out,
  ], { timeoutMs: 120000 });

  if (!fs.existsSync(out)) {
    throw new Error(`裁剪失败: ${(r.stderr || '').slice(-200)}`);
  }
  return { path: out, start, duration: durationSec, total: Math.round(totalSec) };
}

/**
 * 从音频里切出一段或多段（支持「唱一首」分成几条语音发）。
 *
 * 规则按 QQ 语音 60 秒上限倒推：每段最长 55 秒（留 5 秒余量给转码），
 * 段间连续不留空档，最后一段不足 8 秒丢掉（太短像卡带）。
 */
async function trimSegments(srcPath, { startSec = 8, totalSec = 30, tag } = {}) {
  fs.mkdirSync(RVC_OUT, { recursive: true });

  const probe = await run(FFMPEG, ['-i', srcPath, '-hide_banner'], { timeoutMs: 20000 });
  const dm = (probe.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  let srcTotal = 0;
  if (dm) srcTotal = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);

  let start = startSec;
  if (srcTotal > 0) {
    if (srcTotal <= totalSec + 5) start = 0;
    else if (start + totalSec > srcTotal) start = Math.max(0, srcTotal - totalSec);
  }

  const available = srcTotal > 0 ? Math.max(0, srcTotal - start) : totalSec;
  const wantTotal = Math.min(totalSec, available);
  const MAX_SEG = 55;
  const MIN_SEG = 8;

  const segments = [];
  let offset = 0;
  let idx = 0;

  while (offset < wantTotal - MIN_SEG + 1) {
    const remain = wantTotal - offset;
    const segLen = remain <= MAX_SEG ? remain : MAX_SEG;
    const out = path.join(RVC_OUT, `_seg_${tag}_${idx}.wav`);
    const segStart = start + offset;

    await run(FFMPEG, [
      '-y', '-ss', String(segStart), '-i', srcPath,
      '-t', String(segLen),
      '-vn', '-ac', '1', '-ar', '40000', '-c:a', 'pcm_s16le',
      out,
    ], { timeoutMs: 120000 });

    if (fs.existsSync(out)) {
      segments.push({ path: out, start: Math.round(segStart * 10) / 10, duration: Math.round(segLen * 10) / 10, index: idx });
    }
    offset += segLen;
    idx++;
    if (idx > 10) break;
  }

  if (!segments.length) throw new Error('切片失败：没有产出片段');
  return segments;
}

async function prepareInput(srcPath, tag) {
  const out = path.join(RVC_OUT, `_prep_${tag}.wav`);
  fs.mkdirSync(RVC_OUT, { recursive: true });
  const r = await run(FFMPEG, [
    '-y', '-i', srcPath,
    '-vn',                    // 丢掉视频轨
    '-ac', '1',               // 单声道
    '-ar', '40000',           // RVC 模型是 40k
    '-c:a', 'pcm_s16le',
    out,
  ], { timeoutMs: 300000 });

  if (!fs.existsSync(out)) {
    throw new Error(`音频预处理失败: ${(r.stderr || '').slice(-300)}`);
  }
  return out;
}

/**
 * 调 RVC 做音色转换。
 * rvc_infer.py 用环境变量传参 —— 因为 configs/config.py 在 import 时
 * 就执行 argparse.parse_args()，会截走命令行参数。
 */
async function convertVoice(wavPath, { f0 = 0, tag }) {
  const outName = `${tag}_malele_f0${f0 >= 0 ? '+' : ''}${f0}.wav`;
  const outPath = path.join(RVC_OUT, outName);

  // 已存在就直接用（避免重复跑几分钟）
  if (fs.existsSync(outPath)) {
    log('已存在，跳过转换:', outName);
    return outPath;
  }

  const r = await run(PYTHON, [INFER_SCRIPT], {
    env: {
      RVC_SRC: wavPath,
      RVC_F0: String(f0),
      RVC_TAG: tag,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    timeoutMs: 1800000,   // 长歌可能跑十几分钟
  });

  // 解析脚本输出的 JSON
  const lines = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
  let result = null;
  for (const l of lines.reverse()) {
    try { result = JSON.parse(l); break; } catch {}
  }

  if (!result?.ok) {
    throw new Error(`RVC 转换失败: ${result?.error ?? (r.stderr || '').slice(-300)}`);
  }
  return result.out;
}

/** 响度归一化 + 转 mp3 */
async function normalizeToMp3(wavPath, tag) {
  const out = path.join(RVC_OUT, `${tag}_malele_norm.mp3`);
  const r = await run(FFMPEG, [
    '-y', '-i', wavPath,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', '44100', '-b:a', '192k',
    out,
  ], { timeoutMs: 300000 });

  if (!fs.existsSync(out)) {
    throw new Error(`响度处理失败: ${(r.stderr || '').slice(-300)}`);
  }
  return out;
}

/**
 * 完整流程：音频 → 麻勒勒音色 → 放进语音库。
 * 返回 { file（语音库文件名）, seconds, detail }
 */
export async function renderSing(inputPath, { f0 = 0, clipSec = 30, clipStart = 8 } = {}) {
  if (!fs.existsSync(inputPath)) throw new Error('Singing input audio does not exist.');
  if (!fs.existsSync(INFER_SCRIPT) || !fs.existsSync(PYTHON)) throw new Error('Optional RVC adapter is missing. Configure paths.rvcInferScript and paths.rvcPython.');
  // 前置：清残留 + 查显存。不够就直接说明，别默默降到 CPU 跑十分钟
  const gpu = await prepareGpu({ minFreeMB: 2200 });
  if (gpu.freeMB !== null && !gpu.enough) {
    throw new Error(
      `显存不足（空闲 ${gpu.freeMB}MB，需要至少 ${gpu.minFreeMB}MB）。` +
      '请先关掉 ComfyUI 或 GPT-SoVITS 释放显存，否则转换会慢十倍以上。'
    );
  }
  if (!fs.existsSync(inputPath)) throw new Error(`文件不存在: ${inputPath}`);

  const tag = `sing_${Date.now()}`;
  // 先裁片段再转换 —— RVC 耗时跟长度成正比，先裁能省掉大部分时间；
  // 而且 QQ 单条语音约 60 秒上限，整首必须分段发。
  //
  // clipSec 语义：总共要唱多少秒（不是单段长度）。
  //   · 「唱几句」→ 20-30 秒，一段
  //   · 「唱一首」→ 100-150 秒，自动切成 2-3 段，每段 40-55 秒
  const segments = await trimSegments(inputPath, {
    startSec: clipStart,
    totalSec: clipSec > 0 ? clipSec : 30,
    tag,
  });

  log(`切成 ${segments.length} 段：${segments.map((s) => `${s.duration}s`).join(" + ")}`);

  const outputs = [];

  for (const seg of segments) {
    const segTag = `${tag}_p${seg.index}`;
    log(`--- 第 ${seg.index + 1}/${segments.length} 段（${seg.duration}s）---`);

    log('1/4 预处理…');
    const wav = await prepareInput(seg.path, segTag);

    log('2/4 RVC 转换…');
    const converted = await convertVoice(wav, { f0, tag: segTag });

    log('3/4 响度归一化…');
    const mp3 = await normalizeToMp3(converted, segTag);

    log('4/4 入语音库…');
    fs.mkdirSync(VOICE_LIB, { recursive: true });
    const finalName = `${segTag}.mp3`;
    fs.copyFileSync(mp3, path.join(VOICE_LIB, finalName));

    const stat = fs.statSync(mp3);
    const detail = await run(FFMPEG, ['-i', mp3, '-hide_banner'], { timeoutMs: 20000 });
    const m = (detail.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    const sec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;

    outputs.push({
      file: finalName,
      mp3Path: mp3,
      seconds: sec ? Math.round(sec * 10) / 10 : null,
      sizeMB: Math.round((stat.size / 1024 / 1024) * 10) / 10,
      index: seg.index,
      start: seg.start,
      duration: seg.duration,
    });
  }

  // 兼容旧调用方：file/seconds 取第一段，另外给出 segments 数组
  return {
    file: outputs[0].file,
    mp3Path: outputs[0].mp3Path,
    seconds: outputs[0].seconds,
    sizeMB: outputs.reduce((a, o) => a + o.sizeMB, 0),
    f0,
    segments: outputs,
    totalSeconds: outputs.reduce((a, o) => a + (o.seconds || 0), 0),
    clip: { total: segments.reduce((a, s) => a + s.duration, 0) },
  };
}

export default { renderSing };
