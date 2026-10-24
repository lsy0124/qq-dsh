import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getRuntimePaths } from './core/runtime-config.mjs';
import { runMediaProcess as run } from './core/media-process.mjs';
import { scoreItem } from './core/song-selection.mjs';

// 点歌自动化：歌名 → 搜索 → 挑素材 → 下载 → （必要时分离人声）→ RVC 换音色 → 发 QQ
//
// 设计要点：
//   1. 搜索走 bilibili-api-python（元数据完整），下载走 yt-dlp（流处理强）
//   2. **优先选「清唱」素材** —— 清唱不需要人声分离，省一大步，而且质量更好
//   3. 没有清唱才下原曲，再用 pymss 分离人声
//   4. 打分排序：标题含「清唱」+时长合适+播放量高

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// bili 虚拟环境的 python（跑 sing_search.py 用）。
// 优先读 config.json 的 paths.biliPython，其次环境变量 BILI_PYTHON，最后回退到常见位置。
const runtimePaths = getRuntimePaths();
const BILI_PY = runtimePaths.biliPython;
const RVC_APP = runtimePaths.rvcDir;
const RVC_PY = runtimePaths.rvcPython;
const RVC_CWD = RVC_APP;
const DOWNLOAD_DIR = path.join(ROOT, 'state', 'sing-dl');
const SEARCH_SCRIPT = path.join(HERE, 'sing_search.py');

/** Compatibility: only the current job's owned children may be terminated. */
export async function killStalePython() { return { skipped: true }; }

function log(...a) {
  console.error('[song]', ...a);
}

/** 搜索 B 站 */
export async function searchSongs(keyword) {
  const r = await run(BILI_PY, [SEARCH_SCRIPT, 'search', keyword], { timeoutMs: 120000 });
  const line = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`搜索失败：${(r.stderr || '').slice(-300)}`);

  let data;
  try { data = JSON.parse(line); } catch { throw new Error('搜索返回无法解析'); }
  if (!data.ok) throw new Error(`搜索失败：${data.error}`);

  const ranked = (data.items || [])
    .map((it) => ({ ...it, ...scoreItem(it), hasVocalOnly: /清唱|无伴奏|人声/.test(it.title || '') }))
    .sort((a, b) => b.score - a.score);

  return ranked;
}

/** 下载某个 BV */
export async function downloadSong(bvid) {
  const r = await run(BILI_PY, [SEARCH_SCRIPT, 'download', bvid], { timeoutMs: 600000 });
  const line = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`下载失败：${(r.stderr || '').slice(-300)}`);
  const data = JSON.parse(line);
  if (!data.ok) throw new Error(`下载失败：${data.error}`);
  return data;
}

/**
 * 分离人声（只有下的是原曲、带伴奏时才需要）。
 * 用 pymss 的 karaoke 模型，输出 vocals / instrumental。
 */
export async function separateVocals(wavPath, tag) {
  const outDir = path.join(DOWNLOAD_DIR, `stem_${tag}`);
  fs.mkdirSync(outDir, { recursive: true });

  // 走 RVC 目录下的封装脚本 —— 它处理了三个坑：
  //   1. pymss 默认往 ~/.cache 写模型，本机那个目录是软链、写不进去 → 内部用 model-dir
  //   2. 系统 PATH 没 ffmpeg → 脚本内自动加
  //   3. **显存不足时报的是误导性的 'utf-8 codec' 错误** → 内部 cuda 失败自动回退 cpu
  const script = path.join(runtimePaths.rvcScriptsDir, 'separate_vocals.py');
  if (!fs.existsSync(script)) {
    throw new Error(`找不到人声分离脚本: ${script}`);
  }

  log('分离人声（GPU 吃不住会自动转 CPU，可能慢几分钟）…');
  const r = await run(RVC_PY, [script, wavPath, outDir], { timeoutMs: 1800000 });

  const line = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) {
    throw new Error(`人声分离无输出：${(r.stderr || '').slice(-400)}`);
  }

  let data;
  try { data = JSON.parse(line); } catch { throw new Error('人声分离输出无法解析'); }
  if (!data.ok) {
    throw new Error(`人声分离失败：${data.error}`);
  }

  log(`人声分离完成（device=${data.device}）`);
  return data.vocals;
}

/**
 * 检测音频基频，判断男声/女声，给出建议变调。
 *
 * 走 detect_pitch.py（自相关法估中位数基频，比平均值稳健）。
 * 结果用于两件事：
 *   1. 男声素材 → 优先换女声版，而不是硬转
 *   2. 确定 f0 变调量
 */
export async function detectPitch(audioPath) {
  const script = path.join(runtimePaths.rvcScriptsDir, 'detect_pitch.py');
  if (!fs.existsSync(script)) {
    return { ok: false, error: 'detect_pitch.py 不存在' };
  }
  const r = await run(RVC_PY, [script, audioPath], { timeoutMs: 180000 });
  const line = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) return { ok: false, error: '音高检测无输出' };
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: '音高检测输出无法解析' };
  }
}

/**
 * 完整点歌流程。
 *
 * 重要原则：**只用清唱素材**。
 *
 * 带伴奏的素材即使做了人声分离，音质也已经毁了：
 *   分离会削掉齿音和高频泛音（人声和伴奏在这部分重叠，分不干净）
 *   再走 RVC 转换等于在残骸上二次加工，出来的声音发闷、发糊、听不清词
 * 而清唱本身就是干声，转换后能保留细节。
 *
 * 所以宁可告诉对方「没找到清唱的版本」，也不要拿伴奏版糊弄。
 *
 * @returns {{ picked, audioPath, separated, stage }}
 */
export async function fetchSongAudio(songName, { preferVocalOnly = true } = {}) {
  // 从查询里剥出「真正的歌名」，去掉歌手名、描述词、清唱之类的修饰。
  // 这个歌名要用来校验搜索结果标题 —— B 站的搜索结果会掺进同歌手/同风格的歌，
  // 不校验就会出现「点《雨爱》唱出《我不难过》」这种事故。
  const rawQuery = String(songName).trim();
  const titleProbe = rawQuery
    .replace(/清唱|无伴奏|纯人声|干声|翻唱|完整版|现场|版/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 提取核心歌名：去掉歌手名（通常第二个词开始就是歌手或修饰）
  // 简化处理：如果 probe 里有多段，取第一段作为歌名候选
  const coreToken = titleProbe.split(/\s+/)[0] || titleProbe;

  const matchesSong = (title) => {
    if (!title) return false;
    // 歌名本身出现在标题里就算命中（去掉标点比较）
    const norm = String(title).replace(/[\s《》「」【】()（）\-—_·.,，:：!！?？"'"'']/g, '');
    const core = coreToken.replace(/[\s《》「」【】()（）\-—_·.,，:：!！?？]/g, '');
    if (!core) return true;
    return norm.includes(core);
  };

  let results = [];
  let usedQuery = rawQuery;

  if (preferVocalOnly) {
    // 搜索词带上「清唱」—— 只搜歌名基本都是伴奏/成品曲。
    // 依次尝试变体，第一个既能找到清唱、标题又真的对得上歌名的就采用。
    const base = titleProbe || rawQuery;
    const variants = [
      `${base} 清唱`,
      `${base} 无伴奏`,
      `${base} 纯人声`,
      base,
    ];

    let fallback = [];

    for (const q of variants) {
      log(`搜索（${q}）…`);
      try {
        const r = await searchSongs(q);
        if (!r.length) continue;

        // 只保留标题里确实提到这首歌的
        const relevant = r.filter((x) => matchesSong(x.title));
        log(`  命中歌名 ${relevant.length}/${r.length} 条`);

        if (relevant.some((x) => x.isVocalOnly)) {
          results = relevant;
          usedQuery = q;
          break;
        }
        if (!fallback.length && relevant.length) {
          fallback = relevant;
          usedQuery = q;
        }
      } catch (e) {
        log(`  搜索「${q}」失败: ${e?.message ?? e}`);
      }
    }

    if (!results.length) results = fallback;
    if (!results.length) {
      throw new Error(
        `没找到「${rawQuery}」的演唱素材。可能是歌名写得太生僻，或者 B 站没有对应的清唱。`
        + `\n换个说法再试（比如只留歌名、去掉歌手名），或者换一首。`,
      );
    }
  } else {
    results = await searchSongs(rawQuery);
  }

  if (!results.length) throw new Error(`没搜到「${songName}」`);
  log(`实际用的搜索词: ${usedQuery}`);

  let target = null;

  if (preferVocalOnly) {
    // 硬性过滤：只接受「清唱/弹唱 + 时长合理」的素材。
    // 超长（>5分钟）的一律排除 —— 片段裁剪只要 30 秒，长素材纯粹是浪费下载和转换时间，
    // 而且多半是合集/现场/教学。
    const usable = results.filter((r) => r.isVocalOnly && r.dur >= 15 && r.dur <= 300);

    // 第一优先：时长最舒服的（45s~3min）
    target = usable.find((r) => r.dur >= 45 && r.dur <= 180);
    // 第二优先：其他可用的
    if (!target) target = usable[0];

    if (!target) {
      const top = results.slice(0, 3).map((r) => `「${r.title}」(${r.duration})`).join('、');
      const err = new Error(
        `没找到「${songName}」能用的清唱素材。`
        + `带伴奏的版本分离人声后音质会明显变差（发闷、听不清词），所以不做。`
        + `\n可以换个说法再搜（比如只留歌名、去掉歌手名），或者换一首歌。`
        + (top ? `\n搜到的都不合适：${top}` : ''),
      );
      err.code = 'NO_VOCAL_ONLY';
      throw err;
    }
  } else {
    // 显式要求才允许用原曲，但仍然避开超长的
    target = results.find((r) => r.dur > 0 && r.dur <= 300) || results[0];
  }

  log('选中:', target.title, '|', target.duration, '| 分数', Math.round(target.score));

  log('下载…');
  const dl = await downloadSong(target.bvid);
  let audioPath = dl.path;
  let separated = false;

  // 不是清唱 → 分离人声
  if (!target.hasVocalOnly) {
    log('这条不是清唱，需要分离人声');
    audioPath = await separateVocals(audioPath, target.bvid);
    separated = true;
  }

  // ── 音高检测：男声素材优先换女声版 ──
  //
  // 为什么要换：RVC 能把基频抬上去，但共振峰抬不上去（男声声道长度决定的物理属性）。
  // 男声升调后变成「音调被拉高的女声 + 男声共鸣腔」，音色必然失真。
  // 实测：男声 180 Hz 要升 6 半音，女声 286 Hz 只要降 2 半音，后者保留得好得多。
  let pitch = null;
  let swapped = false;

  try {
    pitch = await detectPitch(audioPath);
    if (pitch?.ok && pitch.f0_hz) {
      log(`素材音高 ${pitch.f0_hz} Hz（${pitch.type}）`);

      // 低于 215 Hz 视为偏男声 → 找女声版替换
      if (pitch.f0_hz < 215) {
        log('素材偏男声，尝试换女声版本…');
        const altQueries = [
          `${titleProbe} 女声 清唱`,
          `${titleProbe} 女生 清唱`,
          `${titleProbe} 清唱`,
        ];

        for (const q of altQueries) {
          try {
            const alt = await searchSongs(q);
            // 只要清唱、时长合理、且不是当前这条
            const cands = alt.filter((x) =>
              x.isVocalOnly && x.bvid !== target.bvid && x.dur >= 20 && x.dur <= 300);

            for (const cand of cands.slice(0, 3)) {
              try {
                log(`  试听候选: ${cand.title.slice(0, 40)}`);
                const cdl = await downloadSong(cand.bvid);
                const cp = await detectPitch(cdl.path);

                if (cp?.ok && cp.f0_hz >= 215) {
                  // 找到女声了
                  log(`  ✓ 换成女声版（${cp.f0_hz} Hz）`);
                  audioPath = cdl.path;
                  target = cand;
                  separated = false;
                  pitch = cp;
                  swapped = true;
                  break;
                }
                log(`    这条也是 ${cp?.f0_hz ?? '?'} Hz，继续找`);
              } catch (e) {
                log(`    候选失败: ${e?.message ?? e}`);
              }
            }
            if (swapped) break;
          } catch (e) {
            log(`  搜索「${q}」失败: ${e?.message ?? e}`);
          }
        }

        if (!swapped) {
          log('  没找到女声版，只能用当前素材（音色会有偏差）');
        }
      }
    }
  } catch (e) {
    log('音高检测失败（继续）:', e?.message ?? e);
  }

  return {
    picked: {
      bvid: target.bvid,
      title: target.title,
      author: target.author,
      duration: target.duration,
      play: target.play,
      score: Math.round(target.score),
      reasons: target.reasons,
    },
    audioPath,
    separated,
    // 音高信息 + 建议变调，给 renderSing 用
    pitch: pitch?.ok ? {
      f0_hz: pitch.f0_hz,
      type: pitch.type,
      suggestedShift: pitch.suggested_f0_shift,
    } : null,
    swappedToFemale: swapped,
    candidates: results.slice(0, 5).map((r) => ({
      bvid: r.bvid, title: r.title, dur: r.duration, score: Math.round(r.score),
    })),
  };
}

export default { searchSongs, downloadSong, separateVocals, fetchSongAudio, detectPitch };
