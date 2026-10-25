#!/usr/bin/env node
// mcp-voice-say.js —— 给 AI 一个「开口说话」的工具
//
// 为什么需要这个独立 MCP：
//   qq-bridge 自带的 qq_send_voice 只能发**语音库里已经存在的文件**，
//   qq_list_voices 也只能列出既有音频。也就是说 AI 想说话，得有人提前
//   把音频准备好放进去 —— 它没有「把一句话变成声音」的能力。
//
//   这个 server 补上那一环：接一句话 → 调本机 GPT-SoVITS 合成 →
//   存进桥接的语音库 → 调桥接的 /api/send/voice 发出去。
//
// 与 tts-say.mjs 的关系：逻辑同源，但那边是给人用的 CLI，
// 这边是给模型用的 MCP 工具（带完整的参数 schema 与错误回传）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function settings() {
  const cfg = loadConfig();
  const t = cfg.tts ?? {};
  return {
    baseUrl: (t.baseUrl || 'http://127.0.0.1:9880').replace(/\/+$/, ''),
    refAudio: path.resolve(ROOT, t.refAudio || 'audio-ref/reference-zh.wav'),
    promptText: t.promptText ?? '',
    promptLang: t.promptLang ?? 'zh',
    textLang: t.textLang ?? 'zh',
    speedFactor: Number(t.speedFactor ?? 0.92),
    temperature: Number(t.temperature ?? 1.05),
    topK: Number(t.topK ?? 15),
    topP: Number(t.topP ?? 0.95),
    repetitionPenalty: Number(t.repetitionPenalty ?? 1.35),
    textSplitMethod: t.textSplitMethod || 'cut2',
    consolePort: Number(t.consolePort ?? cfg.consolePort ?? 3100),
    voiceDir: path.join(ROOT, cfg.socialV2?.voice?.dir || 'audio'),
  };
}

function consoleToken() {
  const cfg = loadConfig();
  const configured = String(cfg.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

function log(...a) {
  // stdio MCP：stdout 是协议通道，调试只能走 stderr
  console.error('[voice-say]', ...a);
}

/** 合成到语音库，返回文件名 */
async function synthesize(text, s) {
  if (!fs.existsSync(s.refAudio)) {
    throw new Error(`参考音频不存在：${s.refAudio}（GPT-SoVITS 需要 3~10 秒干净人声）`);
  }
  const body = JSON.stringify({
    text,
    text_lang: s.textLang,
    ref_audio_path: s.refAudio,
    prompt_text: s.promptText,
    prompt_lang: s.promptLang,
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: s.speedFactor,
    temperature: s.temperature,
    top_k: s.topK,
    top_p: s.topP,
    repetition_penalty: s.repetitionPenalty,
    text_split_method: s.textSplitMethod,
  });
  const res = await fetch(`${s.baseUrl}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    let d = '';
    try { d = await res.text(); } catch {}
    throw new Error(`GPT-SoVITS 合成失败 HTTP ${res.status}: ${d.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`合成结果过小（${buf.length} 字节），可能失败`);

  fs.mkdirSync(s.voiceDir, { recursive: true });
  const name = `say-${Date.now()}.wav`;
  fs.writeFileSync(path.join(s.voiceDir, name), buf);
  return { name, bytes: buf.length };
}

/** 让桥接把它当语音发出去 */
async function send(key, voiceName, s, { label, token, verify = true }) {
  const [scope, id] = String(key).split(':');
  if (!['group', 'private'].includes(scope) || !id) {
    throw new Error(`key 必须是 group:<群号> 或 private:<QQ号>，收到 ${JSON.stringify(key)}`);
  }
  const ct = consoleToken();
  const headers = {
    'content-type': 'application/json',
    'x-agent-call': '1',
    ...(ct ? { 'x-console-token': ct } : {}),
    ...(token ? { 'x-agent-token': token } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${s.consolePort}/api/send/voice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      key,
      file: voiceName,
      label: label || '',
      verify: verify !== false,
      ...(token ? { token } : {}),
    }),
    signal: AbortSignal.timeout(200000),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.ok === false) {
    throw new Error(`桥接发语音失败 HTTP ${res.status}: ${JSON.stringify(payload?.error ?? payload).slice(0, 300)}`);
  }
  return payload;
}

const server = new McpServer({ name: 'voice-say', version: '1.0.0' });

server.tool(
  'qq_say',
  '把一句话用本机 TTS 合成为语音并直接发到 QQ。'
  + '适合「想用说的」的场合：晚安、撒娇、语气词、短句情绪表达。'
  + '合成需要几秒到几十秒；文本别太长（建议 60 字以内），太长会拖慢且不自然。'
  + '返回 verified=true 才代表语音真的发出去了。',
  {
    key: z.string().describe('会话 key，group:<群号> 或 private:<QQ号>'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().min(1).max(200).describe('要说的内容（口语化短句，别写书面语/列表/代码）'),
    label: z.string().optional().describe('可选：会话记录里的说明，如「说了句晚安」'),
    // 下面三个是「按情境调整」的旋钮。默认值偏向自然口语，
    // 只在语气明显需要变化时才改，别每条都乱调。
    mood: z.enum(['soft', 'normal', 'lively', 'sleepy']).optional()
      .describe('语气倾向。soft=温柔安抚（语速慢、更平稳）；normal=日常；lively=轻快兴奋（语速快些、起伏大）；sleepy=困倦低语（最慢）'),
    speed: z.number().min(0.7).max(1.25).optional()
      .describe('语速倍率，覆盖 mood 的默认值。0.85 明显更慢更软，1.1 偏脆偏快'),
    emphasis: z.string().optional().describe('可选：希望强调的感觉，如「撒娇」「有点委屈」，只作表述提示，不改变音色'),
  },
  async ({ key, token, text, label, mood, speed, emphasis }) => {
    const s = settings();

    // mood → 参数映射。这是「让声音不像机器念稿」的主要手段：
    // 真人说话的快慢本来就跟情绪走，固定语速必然显得呆板。
    const MOOD_PRESETS = {
      soft: { speed: 0.88, temperature: 1.08, topP: 0.94 },
      normal: { speed: 0.94, temperature: 1.05, topP: 0.95 },
      lively: { speed: 1.06, temperature: 1.15, topP: 0.92 },
      sleepy: { speed: 0.82, temperature: 1.02, topP: 0.96 },
    };
    const preset = MOOD_PRESETS[mood] ?? MOOD_PRESETS.normal;
    const tuned = {
      ...s,
      speedFactor: speed ?? preset.speed,
      temperature: preset.temperature,
      topP: preset.topP,
    };

    try {
      log('合成:', text.slice(0, 40), 'mood=', mood ?? 'normal', 'speed=', tuned.speedFactor);
      const { name, bytes } = await synthesize(text, tuned);
      log('已生成', name, Math.round(bytes / 1024), 'KB');

      const sent = await send(key, name, s, { label, token, verify: true });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            file: name,
            bytes,
            verified: sent?.verified ?? null,
            messageId: sent?.messageId ?? null,
            duration: sent?.duration ?? null,
            used: { mood: mood ?? 'normal', speed: tuned.speedFactor, temperature: tuned.temperature },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `发语音失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'qq_tts_status',
  '只读：检查本机 TTS（GPT-SoVITS）是否在线、当前音色参考音频是什么。发语音前可以先确认。',
  {},
  async () => {
    const s = settings();
    let online = false;
    let detail = '';
    try {
      const r = await fetch(`${s.baseUrl}/`, { signal: AbortSignal.timeout(6000) });
      online = true;
      detail = `HTTP ${r.status}`;
    } catch (e) {
      detail = String(e?.message ?? e);
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          online,
          detail,
          endpoint: s.baseUrl,
          referenceAudio: path.basename(s.refAudio),
          referenceExists: fs.existsSync(s.refAudio),
          voiceDir: s.voiceDir,
          params: {
            speed: s.speedFactor,
            temperature: s.temperature,
            split: s.textSplitMethod,
          },
        }, null, 2),
      }],
    };
  },
);

// ── 唱歌 ──────────────────────────────────────────────────────────────────
// 能力边界必须说清楚：这不是「凭空唱一首歌」，而是
// 「拿一段现成的演唱，换成麻勒勒的音色」。
// 想让它自由唱新旋律，需要歌声合成（SVS）+ 目标人的歌声训练数据，
// 那是另一个工程量级，这个工具做不到。
server.tool(
  'qq_sing',
  '把一段歌声音频转成「麻勒勒」的音色并发到 QQ。'
  + '需要你提供现成的演唱音频（本地路径或直链），因为它做的是音色转换，不是凭空作曲。'
  + '耗时较长：1 分钟的歌约 2-3 分钟转换，3 分钟的歌约 10 分钟。'
  + '转换完成会自动发到当前会话。',
  {
    key: z.string().describe('会话 key，group:<群号> 或 private:<QQ号>'),
    token: z.string().describe('会话令牌'),
    audio_path: z.string().min(1).describe('歌声音频的本地绝对路径'),
    f0: z.number().int().min(-24).max(24).optional()
      .describe('升降调（半音）。原唱是女声且目标也是女声就用 0；男声转女声建议 +12'),
    clip_seconds: z.number().int().min(18).max(180).optional()
      .describe('总共唱多少秒。唱几句传 20-30；唱一首传 100-150（会自动切成 2-3 条语音，每段 ≤55 秒）。默认 35'),
    clip_start: z.number().int().min(0).max(300).optional()
      .describe('从第几秒开始唱（默认 8，跳过前奏）'),
    label: z.string().optional().describe('会话记录里的说明，如「唱了段雨爱」'),
  },
  async ({ key, token, audio_path, f0, clip_seconds, clip_start, label }) => {
    const s = settings();
    try {
      const { renderSing } = await import('./sing.mjs');
      const r = await renderSing(String(audio_path), {
        f0: f0 ?? 0,
        clipSec: clip_seconds ?? 45,
        clipStart: clip_start ?? 8,
      });

      // 多段发送：唱一首会切成 2-3 段，每段一条语音，段间稍停避免被判刷屏
      const sentList = [];
      const segs = r.segments || [{ file: r.file, seconds: r.seconds }];
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const segLabel = segs.length > 1
          ? `${label || '唱'}${si + 1}/${segs.length}（${seg.seconds ?? '?'} 秒）`
          : (label || `唱了一段（${seg.seconds ?? '?'} 秒）`);
        try {
          await send(key, seg.file, s, { label: segLabel, token, verify: true });
          sentList.push({ ok: true, index: si });
        } catch (e) {
          sentList.push({ ok: false, index: si, error: String(e?.message ?? e).slice(0, 100) });
        }
        if (si < segs.length - 1) await new Promise((r2) => setTimeout(r2, 1500));
      }
      const sent = sentList.every((x) => x.ok) ? { verified: true } : { verified: false };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            总时长秒: r.totalSeconds ?? r.seconds,
            分几段: (r.segments || []).length,
            每段: (r.segments || []).map((x) => `${x.seconds}s`).join(' + '),
            大小MB: r.sizeMB,
            变调: r.f0,
            已发送: sent?.verified ?? sent?.ok ?? null,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `唱歌失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  },
);

// ── 点歌 ──────────────────────────────────────────────────────────────────
// 全自动：歌名 → B站搜素材（优先清唱）→ 下载 →（原曲则分离人声）→ RVC 换音色 → 发出去。
// 这一步能成立是因为「清唱素材」本身就是干声，省掉了人声分离；
// 找不到清唱才下原曲再分离，那条路慢很多。
server.tool(
  'qq_song',
  '点歌：告诉它歌名，它自己上网找演唱素材，换成「麻勒勒」的音色后发到 QQ。'
  + '优先挑清唱素材；没有清唱就下原曲并自动分离人声。'
  + '全程无人值守，但比较慢：1-2 分钟的歌约 2-4 分钟，长歌或需要分离人声要 5-10 分钟。',
  {
    key: z.string().describe('会话 key，group:<群号> 或 private:<QQ号>'),
    token: z.string().describe('会话令牌'),
    song: z.string().min(1).describe('歌名。只写歌名效果最好（如「雨爱」）；带歌手名反而搜不到清唱，只有搜不到时才加歌手'),
    artist: z.string().optional().describe('歌手名（可选，会拼进搜索词）'),
    f0: z.number().int().min(-24).max(24).optional()
      .describe('升降调。原唱女声→目标女声用 0；男声→女声建议 +12'),
    prefer_vocal_only: z.boolean().optional()
      .describe('是否优先清唱素材，默认 true。设 false 则直接用原曲（需要分离人声，更慢）'),
    clip_seconds: z.number().int().min(18).max(180).optional()
      .describe('总共唱多少秒。唱几句传 20-30；唱一首传 100-150（会自动切成 2-3 条语音，每段 ≤55 秒）。默认 35'),
    clip_start: z.number().int().min(0).max(300).optional()
      .describe('从第几秒开始唱（默认 8，跳过前奏）'),
    label: z.string().optional().describe('会话记录里的说明'),
  },
  async ({ key, token, song, artist, f0, prefer_vocal_only, clip_seconds, clip_start, label }) => {
    const s = settings();
    const steps = [];
    try {
      const { fetchSongAudio } = await import('./song.mjs');
      const { renderSing } = await import('./sing.mjs');

      const query = artist ? `${song} ${artist}` : String(song);
      steps.push('搜索：' + query);
      const found = await fetchSongAudio(query, {
        preferVocalOnly: prefer_vocal_only !== false,
      });
      steps.push('选中：' + found.picked.title + '（' + found.picked.duration + '）');
      if (found.separated) steps.push("已分离人声（原曲带伴奏）");

      // 智能推断时长：AI 没传 clip_seconds 时，按歌名/上下文猜
      // （用户反馈「唱歌固定 30 秒」——因为 AI 经常不传参数就落到默认值）
      let effectiveClip = clip_seconds;
      if (effectiveClip === undefined || effectiveClip === null) {
        const q = String(song || '') + ' ' + String(label || '');
        if (/完整|整首|全曲|full/i.test(q)) {
          effectiveClip = 130;          // 「唱完整首」
        } else if (/几句|两句|一段|一小段/i.test(q)) {
          effectiveClip = 25;           // 「唱几句」
        } else {
          effectiveClip = 45;           // 默认：一条语音，够听副歌
        }
        steps.push(`按歌名推断时长：${effectiveClip} 秒`);
      }

      // 变调优先级：用户显式指定 > 自动检测 > 0
      const autoShift = found.pitch?.suggestedShift;
      const useF0 = (f0 !== undefined && f0 !== null) ? f0 : (autoShift ?? 0);

      if (found.pitch?.f0_hz) {
        steps.push(`素材音高 ${found.pitch.f0_hz} Hz（${found.pitch.type}）`);
      }
      if (found.swappedToFemale) {
        steps.push('已换成女声版素材');
      } else if (autoShift && autoShift !== 0) {
        steps.push(`自动变调 ${autoShift > 0 ? '+' : ''}${autoShift} 半音`);
      }

      steps.push('转换音色中…');
      const r = await renderSing(found.audioPath, {
        f0: useF0,
        clipSec: effectiveClip,
        clipStart: clip_start ?? 8,
      });

      steps.push('发送中…');
      // 多段发送：唱一首会切成 2-3 段，每段一条语音，段间稍停避免被判刷屏
      const sentList = [];
      const segs = r.segments || [{ file: r.file, seconds: r.seconds }];
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const segLabel = segs.length > 1
          ? `${label || '唱'}${si + 1}/${segs.length}（${seg.seconds ?? '?'} 秒）`
          : (label || `唱了一段（${seg.seconds ?? '?'} 秒）`);
        try {
          await send(key, seg.file, s, { label: segLabel, token, verify: true });
          sentList.push({ ok: true, index: si });
        } catch (e) {
          sentList.push({ ok: false, index: si, error: String(e?.message ?? e).slice(0, 100) });
        }
        if (si < segs.length - 1) await new Promise((r2) => setTimeout(r2, 1500));
      }
      const sent = sentList.every((x) => x.ok) ? { verified: true } : { verified: false };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            歌名: song,
            用的素材: found.picked.title,
            素材作者: found.picked.author,
            素材来源: found.picked.bvid,
            总时长秒: r.totalSeconds ?? r.seconds,
            大小MB: r.sizeMB,
            变调: r.f0,
            分离过人声: found.separated,
            素材音高: found.pitch ? `${found.pitch.f0_hz} Hz（${found.pitch.type}）` : '未检测',
            换过素材: found.swappedToFemale || false,
            已发送: sent?.verified ?? sent?.ok ?? null,
            流程: steps,
            其他候选: found.candidates.slice(1, 4),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `点歌失败：${error?.message ?? error}\n已完成步骤：${steps.join(' → ')}`,
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  'qq_song_search',
  '只搜不下：看看某个歌名的候选素材有哪些（标题/时长/播放量）。'
  + '想在点歌前先确认素材质量，或者用户问「你能找到什么版本」时用。',
  {
    song: z.string().min(1).describe('歌名'),
    artist: z.string().optional().describe('歌手名（可选）'),
  },
  async ({ song, artist }) => {
    try {
      const { searchSongs } = await import('./song.mjs');
      const query = artist ? `${song} ${artist}` : String(song);
      const list = await searchSongs(query);
      if (!list.length) {
        return { content: [{ type: 'text', text: `没搜到「${query}」` }] };
      }
      const text = list.slice(0, 8).map((it, i) =>
        `${i + 1}. [${it.hasVocalOnly ? "清唱" : "原曲"}] ${it.title}\n`
        + `   ${it.author} · ${it.duration} · ${it.play} 播放 · 分数 ${Math.round(it.score)}`).join("\n");
      return { content: [{ type: "text", text: `「${query}」候选：\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('voice-say MCP 就绪');
