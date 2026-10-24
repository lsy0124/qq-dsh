#!/usr/bin/env node
// tts-say.mjs —— 把一句话合成为语音并发到 QQ。
//
// 为什么需要这个文件：
//   qq-bridge 的 voice-core.js 只会**发送已经存在的音频文件**，它不合成语音；
//   GPT-SoVITS（本机 127.0.0.1:9880）会合成，但它不知道 QQ 的存在。
//   两者之间原先没有任何连接 —— 这就是"装了 GPT-SoVITS 也发不出语音"的根因。
//   本文件是那条缺失的桥：text → GPT-SoVITS /tts → wav → 桥接 /api/send/voice。
//
// 用法：
//   node scripts/tts-say.mjs say "你好呀" --to group:123456
//   node scripts/tts-say.mjs say "你好呀" --to private:322006747 --ref <参考音频>
//   node scripts/tts-say.mjs status
//
// 设计约束：
//   - 合成产物落在 audio/ 语音库里再发，走的是桥接既有的白名单/限流/审计路径，
//     和 AI 自己调 qq_send_voice 完全同一条链路（不给自己开后门）；
//   - 参考音频必须 3~10 秒，这是 GPT-SoVITS 的硬约束，超范围它会直接 400；
//   - 默认音色取 audio-ref/ 下第一段合规音频，可通过 config.json 的 tts 段覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function ttsSettings() {
  const cfg = loadConfig();
  const t = cfg.tts ?? {};
  return {
    baseUrl: (t.baseUrl || process.env.GPT_SOVITS_URL || 'http://127.0.0.1:9880').replace(/\/+$/, ''),
    refAudio: t.refAudio || process.env.GPT_SOVITS_REF || '',
    promptText: t.promptText ?? 'The quick brown fox jumps over the lazy dog.',
    promptLang: t.promptLang ?? 'en',
    textLang: t.textLang ?? 'zh',
    consolePort: Number(t.consolePort ?? cfg.consolePort ?? 3100),
    voiceDir: path.join(ROOT, cfg.socialV2?.voice?.dir || 'audio'),
    // 自然度参数：默认值偏向「自然口语」而非 GPT-SoVITS 原生默认。
    // 原生默认（1.0 / temp 1.0 / cut5）合成偏播报腔，是 AI 味的主要来源。
    speedFactor: Number(t.speedFactor ?? 0.92),
    temperature: Number(t.temperature ?? 1.05),
    topK: Number(t.topK ?? 15),
    topP: Number(t.topP ?? 0.95),
    repetitionPenalty: Number(t.repetitionPenalty ?? 1.35),
    textSplitMethod: t.textSplitMethod || 'cut2',
  };
}

function consoleToken() {
  const cfg = loadConfig();
  const configured = String(cfg.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

/** 参考音频时长检查：GPT-SoVITS 只接受 3~10 秒，越界它会 400（错误信息还很不直观）。 */
function wavDuration(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 44) return null;
    // 极简 WAV 解析：找 fmt 与 data 块。
    let pos = 12;
    let byteRate = null;
    let dataSize = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16);
      if (id === 'data') { dataSize = size; break; }
      pos += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch {
    return null;
  }
}

function pickReference(explicit, settings) {
  if (explicit) return path.resolve(explicit);
  if (settings.refAudio) return path.resolve(ROOT, settings.refAudio);
  const refDir = path.join(ROOT, 'audio-ref');
  try {
    const files = fs.readdirSync(refDir).filter((f) => f.toLowerCase().endsWith('.wav'));
    for (const f of files) {
      const full = path.join(refDir, f);
      const d = wavDuration(full);
      if (d !== null && d >= 3 && d <= 10) return full;
    }
    if (files.length) return path.join(refDir, files[0]);
  } catch {}
  return null;
}

/**
 * 合成语音。
 *
 * 这些参数决定「像不像人说话」，默认值都是 GPT-SoVITS 的原生默认（偏机械）：
 *   speed_factor       语速。1.0 是原速；0.9~0.95 明显更松弛，机械感大幅下降。
 *   temperature        采样温度。越高语调起伏越大、越像真人；太高会含糊甚至念错。
 *   top_k / top_p      采样范围。配合 temperature 一起调。
 *   repetition_penalty 重复惩罚。调低会让语气更连贯，但过低会结巴。
 *   text_split_method  切句方式。cut5 按标点切，长句被硬切会显得赶；
 *                      cut2 按逗号切，停顿更自然（这是去 AI 味最有效的一项）。
 * 全部可由 config.json 的 tts 段覆盖，也可用 CLI 参数临时覆盖。
 */
async function synthesize(text, settings, refAudio) {
  const body = JSON.stringify({
    text,
    text_lang: settings.textLang,
    ref_audio_path: refAudio,
    prompt_text: settings.promptText,
    prompt_lang: settings.promptLang,
    media_type: 'wav',
    streaming_mode: false,
    // —— 自然度参数 ——
    speed_factor: settings.speedFactor,
    temperature: settings.temperature,
    top_k: settings.topK,
    top_p: settings.topP,
    repetition_penalty: settings.repetitionPenalty,
    text_split_method: settings.textSplitMethod,
  });
  const res = await fetch(`${settings.baseUrl}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    throw new Error(`GPT-SoVITS 合成失败 HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`GPT-SoVITS 返回的音频过小（${buf.length} 字节），可能合成失败`);
  return buf;
}

async function sendVoice(file, target, settings) {
  const [scope, id] = String(target).split(':');
  if (!['group', 'private'].includes(scope) || !id) {
    throw new Error(`目标必须是 group:<群号> 或 private:<QQ号>，收到 ${JSON.stringify(target)}`);
  }
  // 端点只有一个：/api/send/voice，群/私聊由 body 里的 key 区分（不是两条路径）。
  const endpoint = '/api/send/voice';
  const token = consoleToken();
  const res = await fetch(`http://127.0.0.1:${settings.consolePort}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-console-token': token } : {}),
      'x-agent-call': '1',
    },
    body: JSON.stringify({
      key: target,
      file: path.basename(file),
    }),
    signal: AbortSignal.timeout(180000),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.ok === false) {
    throw new Error(`桥接发语音失败 HTTP ${res.status}: ${JSON.stringify(payload?.error ?? payload).slice(0, 400)}`);
  }
  return payload;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const settings = ttsSettings();
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === 'status') {
    let online = false;
    let info = null;
    try {
      const r = await fetch(`${settings.baseUrl}/`, { signal: AbortSignal.timeout(6000) });
      online = true;
      info = `HTTP ${r.status}`;
    } catch (error) {
      info = String(error?.message ?? error);
    }
    const ref = pickReference(flag('ref'), settings);
    console.log(JSON.stringify({
      gptSovits: settings.baseUrl,
      online,
      detail: info,
      referenceAudio: ref,
      referenceDuration: ref ? wavDuration(ref) : null,
      voiceDir: settings.voiceDir,
    }, null, 2));
    return;
  }

  if (cmd !== 'say') {
    console.error('用法: node scripts/tts-say.mjs say "<文本>" --to group:<群号>|private:<QQ号> [--ref <wav>]');
    console.error('      node scripts/tts-say.mjs status');
    process.exit(2);
  }

  const text = rest[0];
  const target = flag('to');
  if (!text) throw new Error('缺少要合成的文本');
  if (!target) throw new Error('缺少 --to group:<群号> 或 private:<QQ号>');

  const refAudio = pickReference(flag('ref'), settings);
  if (!refAudio || !fs.existsSync(refAudio)) {
    throw new Error('找不到参考音频。GPT-SoVITS 需要一段 3~10 秒的人声样本：把 wav 放进 qq-bridge/audio-ref/ 即可。');
  }
  const dur = wavDuration(refAudio);
  if (dur !== null && (dur < 3 || dur > 10)) {
    throw new Error(`参考音频 ${path.basename(refAudio)} 时长 ${dur.toFixed(2)}s，GPT-SoVITS 只接受 3~10 秒。`);
  }

  console.log(`[tts] 合成中（参考: ${path.basename(refAudio)}）…`);
  const wav = await synthesize(text, settings, refAudio);

  fs.mkdirSync(settings.voiceDir, { recursive: true });
  const name = `tts-${Date.now()}.wav`;
  const outFile = path.join(settings.voiceDir, name);
  fs.writeFileSync(outFile, wav);
  console.log(`[tts] 已生成 ${name}（${Math.round(wav.length / 1024)} KB）`);

  const sent = await sendVoice(outFile, target, settings);
  console.log(`[tts] 已发送到 ${target}`);
  console.log(JSON.stringify(sent ?? {}, null, 2));
}

main().catch((error) => {
  console.error(`[tts] 失败: ${error?.message ?? error}`);
  process.exit(1);
});
