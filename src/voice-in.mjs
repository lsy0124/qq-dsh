import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, getRuntimePaths } from './core/runtime-config.mjs';

// 让 AI「听见」语音消息：收到 record 段时，自动下载 + 转写成文字。
//
// 现状：桥接把语音显示成 [语音] 占位符，模型完全不知道里面说了什么。
//
// 链路：
//   record 段（含 file/file_id）
//     → SnowLuma get_record(out_format=wav) 拿到 base64
//     → 写成临时 wav
//     → FunASR（GPT-SoVITS 自带模型）转文字
//     → 文本塞回消息内容
//
// 为什么用 FunASR 而不是在线 ASR：本地、免费、中文准确率高，
// 而且之前验证过（转抖音视频口播那套）。

const ROOT = PROJECT_ROOT;
const TRANSCRIBE_SCRIPT = getRuntimePaths().asrScript;
const PYTHON = getRuntimePaths().asrPython;
const TEMP_DIR = path.join(ROOT, 'state', 'voice-in');

function log(...a) {
  console.error('[voice-in]', ...a);
}

/** 从桥接配置读 OneBot 地址与 token */
function onebotConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return {
      httpUrl: (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      token: cfg.snowluma?.accessToken || '',
    };
  } catch {
    return { httpUrl: 'http://127.0.0.1:3000', token: '' };
  }
}

/** 调 OneBot 的 get_record，拿 base64 音频 */
async function fetchRecordBase64(fileOrId, outFormat = 'wav') {
  const { httpUrl, token } = onebotConfig();
  const res = await fetch(`${httpUrl}/get_record`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ file: fileOrId, file_id: fileOrId, out_format: outFormat }),
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok || json?.status !== 'ok') {
    throw new Error(`get_record 失败 HTTP ${res.status}: ${(json?.message || text).slice(0, 200)}`);
  }

  const data = json.data ?? {};
  // 有的实现把 base64 放在 data.base64，有的直接 data
  const b64 = data.base64 || (typeof data === 'string' ? data : null);
  if (!b64) throw new Error('get_record 没返回 base64 音频');
  return { base64: b64, meta: data };
}

/** 用 FunASR 转写音频文件 */
function transcribeFile(wavPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
      resolve({ ok: false, error: '转写脚本不存在' });
      return;
    }

    const p = spawn(PYTHON, [TRANSCRIBE_SCRIPT, wavPath], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      resolve({ ok: false, error: '转写超时' });
    }, 180000);

    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) {
        resolve({ ok: false, error: (err || out).slice(-300) });
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: '输出无法解析' });
      }
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e?.message ?? e) });
    });
  });
}

/**
 * 把一条语音消息转成文字。
 * @param {object} seg record 段的数据 { file, file_id, url, ... }
 * @returns {{ ok, text, error, seconds }}
 */
export async function transcribeVoiceSegment(seg) {
  const fileOrId = seg?.file_id || seg?.file || seg?.url || '';
  if (!fileOrId) {
    return { ok: false, error: 'record 段里没有可用的 file/file_id' };
  }

  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const name = `vin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`;
    const wavPath = path.join(TEMP_DIR, name);

    log('下载语音:', String(fileOrId).slice(0, 40));
    const { base64 } = await fetchRecordBase64(fileOrId, 'wav');
    fs.writeFileSync(wavPath, Buffer.from(base64, 'base64'));

    const sizeMb = fs.statSync(wavPath).size / 1024 / 1024;
    log(`已下载 ${sizeMb.toFixed(2)}MB，开始转写`);

    const r = await transcribeFile(wavPath);

    // 转写完删临时文件，别堆垃圾
    try { fs.unlinkSync(wavPath); } catch {}

    if (!r.ok) {
      return { ok: false, error: r.error || '转写失败' };
    }
    return { ok: true, text: (r.text || '').trim(), chars: r.chars };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export default { transcribeVoiceSegment };
