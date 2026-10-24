/** 解析 "3:12" / "59:33" / "1:02:03" 成秒 */
export function parseDuration(s) {
  if (s === null || s === undefined || String(s).trim() === '') return 0;
  const raw = String(s).trim();
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(raw)) return 0;
  const parts = raw.split(':').map(Number);
  if (!parts.every(Number.isSafeInteger) || parts.slice(1).some(n => n >= 60)) return 0;
  const seconds = parts.reduce((total,n) => total * 60 + n,0);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

/**
 * 给搜索结果打分。目标是挑「最适合换音色」的那条：
 *   · 清唱/无伴奏 > 原曲（省掉分离，音质也更干净）
 *   · 时长 40 秒 ~ 5 分钟（太短没内容，太长转换慢）
 *   · 播放量高说明质量可信
 */
// [优化] 素材打分 v4
//
// 核心原则：**只有清唱能用**。
//
// 带伴奏的素材即使做分离，齿音和高频泛音也补不回来（人声和伴奏在那段频谱重叠），
// 再走 RVC 就是二次损伤，成品发闷、糊、听不清词。所以伴奏版不是「次优」，
// 而是「不能用」——打分上直接压到负分，让选材逻辑永远碰不到它。
//
// v4 修的坑：上次「雨爱 杨丞琳」选中了「尤克里里弹唱教学」14:09 ——
// 「弹唱」被当成了清唱，但那是带吉他伴奏的教学视频，又长又吵。
// 所以：弹唱单独区分，教学/tutorial 直接排除，超长一律不要。
const VOCAL_ONLY_RE = /清唱|无伴奏|纯人声|干声|acapella|acappella|人声版|vocal\s*only/i;
// 弹唱：有乐器伴奏，能用但不是最佳（比完整编曲好，比清唱差）
const ACOUSTIC_RE = /弹唱|不插电|吉他伴奏|钢琴伴奏|自弹自唱/i;
// 明确不能用的
const INSTRUMENTAL_RE = /伴奏|纯音乐|instrumental|karaoke|KTV|去人声|消音/i;
const TUTORIAL_RE = /教学|教程|tutorial|讲解|示范|如何|怎么唱|学唱|尤克里里|ukulele|吉他谱|鼓谱|谱/i;
const FULL_SONG_RE = /hi-?res|无损|录音棚|动态歌词|歌词版|官方|MV|音乐视频|原版|原曲|完整版/i;

export function scoreItem(item = {}) {
  const t = String(item.title || '');
  const dur = parseDuration(item.duration);
  let score = 0;
  const reasons = [];

  const isVocalOnly = VOCAL_ONLY_RE.test(t);
  const isAcoustic = ACOUSTIC_RE.test(t);
  const isTutorial = TUTORIAL_RE.test(t);
  const isInstrumental = INSTRUMENTAL_RE.test(t.replace(/无伴奏/g, '').replace(/(?:吉他|钢琴)伴奏/g, '')); 
  const isFullSong = FULL_SONG_RE.test(t);

  // 教学/谱子类直接判死 —— 就算标题带「清唱」也不能用
  if (isTutorial) {
    score -= 300;
    reasons.push('教学视频');
  } else if (isInstrumental) {
    score -= 200;
    reasons.push('纯伴奏');
  } else if (isVocalOnly) {
    score += 100;                     // 清唱：唯一的正解
    reasons.push('清唱');
  } else if (isAcoustic) {
    score += 20;                      // 弹唱：次优，能用但有伴奏
    reasons.push('弹唱');
  } else if (isFullSong) {
    score -= 120;                     // 完整成品曲：带编曲，分离后音质差
    reasons.push('带伴奏');
  } else {
    score -= 40;                      // 不确定：默认怀疑
    reasons.push('未标明');
  }

  // 明显跑偏的内容
  if (/dj|remix|串烧|合集|整张|专辑|循环|一小时|半小时|盘点|排行|reaction|直播回放/i.test(t)) {
    score -= 80; reasons.push('内容不符');
  }

  // 时长：清唱才值得加分。超过 5 分钟的一律不要 ——
  // 片段裁剪只需要 30 秒，但超长素材下载/转换都慢，而且多半是合集或现场。
  if (isVocalOnly || isAcoustic) {
    if (dur >= 45 && dur <= 180) { score += 40; reasons.push('时长理想'); }
    else if (dur >= 30 && dur < 45) { score += 20; reasons.push('偏短'); }
    else if (dur > 180 && dur <= 300) { score += 5; reasons.push('偏长'); }
    else if (dur > 300) { score -= 80; reasons.push('过长'); }
    else if (dur > 0 && dur < 30) { score -= 30; reasons.push('太短'); }
  } else if (dur > 300) {
    score -= 60; reasons.push('过长');
  }

  // 播放量（对数，避免大up主压倒一切）
  const rawPlay = Number(item.play);
  const play = Number.isFinite(rawPlay) ? Math.max(0, rawPlay) : 0;
  score += Math.min(15, Math.log10(play + 1) * 3);

  // 只有清唱/弹唱才算「可用的演唱素材」
  return { score, dur, reasons, isVocalOnly: (isVocalOnly || isAcoustic) && !isTutorial && !isInstrumental };
}

