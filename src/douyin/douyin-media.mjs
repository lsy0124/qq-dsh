import fs from 'node:fs';
import path from 'node:path';

// 下载抖音视频（无水印），供后续转写。
//
// 关键点：抖音的 video.play_addr 里有多个 url_list，其中带 watermark=1 的是带水印版，
// 优先挑不带 watermark 参数的（通常就是无水印源）。如果全都带，就选码率最高的
// play_addr 而非 download_addr —— 后者往往是带水印的。
//
// 下载用 Node 原生 fetch，不引第三方库；用 Cookie 复用浏览器登录态，
// 否则部分视频会 403。

export class DouyinMedia {
  constructor(page) {
    this.page = page;
  }

  async get(urlPath) {
    const full = urlPath.startsWith('http') ? urlPath : `https://www.douyin.com${urlPath}`;
    return this.page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text: text.slice(0, 300) };
    }, full);
  }

  /** 拿视频详情里的播放地址 */
  async getVideoInfo(awemeId) {
    const q = new URLSearchParams({
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      aweme_id: String(awemeId),
    });
    const r = await this.get('/aweme/v1/web/aweme/detail/?' + q.toString());
    const a = r.json?.aweme_detail;
    if (!a) return null;

    const v = a.video || {};
    // 候选地址：play_addr > play_addr_h264 > download_addr
    const addrCandidates = [
      v.play_addr_h264, v.play_addr, v.download_addr,
    ].filter(Boolean);

    const urls = [];
    for (const addr of addrCandidates) {
      for (const u of (addr.url_list || [])) urls.push(u);
    }

    // 排序：无水印优先，其次码率高的
    urls.sort((a, b) => {
      const aw = /watermark=1/.test(a) ? 1 : 0;
      const bw = /watermark=1/.test(b) ? 1 : 0;
      if (aw !== bw) return aw - bw;
      return 0;
    });

    return {
      aweme_id: a.aweme_id,
      desc: a.desc || '',
      author: a.author?.nickname || '',
      duration_ms: v.duration || 0,
      urls,
      cover: v.cover?.url_list?.[0] || v.origin_cover?.url_list?.[0] || '',
    };
  }

  /**
   * 下载视频到本地。
   * 直接在页面上下文里 fetch 会受 blob 限制，所以这里导出 cookie 后用 Node 下载。
   */
  async download(awemeId, outDir) {
    const info = await this.getVideoInfo(awemeId);
    if (!info) throw new Error('拿不到视频信息');
    if (!info.urls.length) throw new Error('视频没有可用的播放地址');

    fs.mkdirSync(outDir, { recursive: true });

    // 从浏览器拿 cookie
    const cookies = await this.page.context().cookies('https://www.douyin.com');
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    let lastErr = null;
    for (const url of info.urls.slice(0, 4)) {
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            referer: 'https://www.douyin.com/',
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 10000) { lastErr = `文件过小 ${buf.length}`; continue; }

        const file = path.join(outDir, `${awemeId}.mp4`);
        fs.writeFileSync(file, buf);
        return { file, bytes: buf.length, desc: info.desc, author: info.author, duration_ms: info.duration_ms };
      } catch (e) {
        lastErr = String(e?.message ?? e);
      }
    }
    throw new Error(`所有地址都下载失败：${lastErr}`);
  }
}

export default DouyinMedia;
