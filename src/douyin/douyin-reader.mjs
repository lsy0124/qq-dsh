import fs from 'node:fs';
import path from 'node:path';

// 抖音内容读取器 —— 只读，不涉及点赞/收藏等写操作。
//
// 为什么这个版本能成：前面卡在「写操作要服务端强校验参数」，
// 但**读接口没有这个问题** —— 页面自己的 fetch 带上签名就能拿到完整数据。
// 所以策略是：所有读取都在 page.evaluate 里用页面上下文发请求，
// 签名由页面自动补，我们只解析返回的 JSON。
//
// 能力边界（要诚实）：
//   ✅ 标题、文案、话题标签、作者、时长、各项计数、发布时间
//   ✅ 评论列表（文字）
//   ✅ 视频封面图 URL（能下载，供视觉模型看）
//   ❌ 视频画面（需要下载视频再抽帧，另说）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DouyinReader {
  constructor(page) {
    this.page = page;
  }

  /** 统一入口：在页面上下文里发 GET */
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

  /**
   * 拉推荐流（带完整字段）。
   * 用 tab/feed，返回结构比 module/feed 干净。
   */
  async feed({ count = 20, refreshIndex = 1 } = {}) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      count: String(count),
      refresh_index: String(refreshIndex),
      video_type_select: '1',
    });
    const r = await this.get('/aweme/v1/web/tab/feed?' + q.toString());
    if (!r.json?.aweme_list) return [];

    return r.json.aweme_list.map((a) => {
      // 提取话题标签（#xxx 在 text_extra 里）
      const tags = (a.text_extra || [])
        .map((t) => t.hashtag_name)
        .filter(Boolean);
      const cover = a.video?.cover?.url_list?.[0]
        || a.video?.origin_cover?.url_list?.[0]
        || a.video?.dynamic_cover?.url_list?.[0]
        || '';
      return {
        id: a.aweme_id,
        desc: (a.desc || '').trim(),
        author: a.author?.nickname || '',
        author_id: a.author?.sec_uid || '',
        tags,
        duration_sec: Math.round((a.video?.duration || 0) / 1000),
        cover,
        digg: a.statistics?.digg_count ?? 0,
        comment: a.statistics?.comment_count ?? 0,
        collect: a.statistics?.collect_count ?? 0,
        share: a.statistics?.share_count ?? 0,
        created: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 16) : '',
      };
    });
  }

  /**
   * 拉某条视频的评论（文字）。
   * 这是「理解内容」的重要补充——评论里往往有对视频内容的描述和反应。
   */
  async comments(awemeId, { count = 20, cursor = 0 } = {}) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      aweme_id: String(awemeId),
      cursor: String(cursor),
      count: String(count),
      item_type: '0',
    });
    const r = await this.get('/aweme/v1/web/comment/list/?' + q.toString());
    if (!r.json?.comments) return [];
    return r.json.comments.map((c) => ({
      text: (c.text || '').trim(),
      user: c.user?.nickname || '',
      digg: c.digg_count ?? 0,
      reply_count: c.reply_comment_total ?? 0,
      is_author: !!c.is_author,
      time: c.create_time ? new Date(c.create_time * 1000).toISOString().slice(0, 16) : '',
    })).filter((c) => c.text);
  }

  /**
   * 搜索（能定向找内容）。
   */
  async search(keyword, { count = 10 } = {}) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      keyword,
      search_channel: 'aweme_general',
      offset: '0',
      count: String(count),
      is_filter_search: '0',
    });
    const r = await this.get('/aweme/v1/web/general/search/single/?' + q.toString());
    const list = r.json?.data || [];
    const out = [];
    for (const item of list) {
      const a = item.aweme_info;
      if (!a) continue;
      out.push({
        id: a.aweme_id,
        desc: (a.desc || '').trim(),
        author: a.author?.nickname || '',
        digg: a.statistics?.digg_count ?? 0,
        duration_sec: Math.round((a.video?.duration || 0) / 1000),
        cover: a.video?.cover?.url_list?.[0] || '',
      });
    }
    return out;
  }

  /**
   * 生成抖音标准分享文案（用于分享给别人时显示成卡片而不是裸链接）。
   *
   * 抖音客户端的分享文本来自 aweme_detail.share_info.share_link_desc，
   * 里面有个 %s 占位符要替换成 share_url。带这段文本发出去，
   * 接收方（QQ/微信）会解析成带封面的卡片。
   */
  async shareText(awemeId) {
    const q = new URLSearchParams({
      device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
      aweme_id: String(awemeId),
    });
    const r = await this.get('/aweme/v1/web/aweme/detail/?' + q.toString());
    const a = r.json?.aweme_detail;
    if (!a) throw new Error('拿不到视频详情，无法生成分享文案');

    const si = a.share_info || {};
    const link = si.share_url || a.share_url || `https://www.douyin.com/video/${awemeId}`;
    let text = si.share_link_desc || '';

    if (text) {
      // %s 是抖音的链接占位符
      text = text.replace('%s', link).trim();
      // 有些版本会带多余的空白
      text = text.replace(/\s{2,}/g, ' ');
    } else {
      // 退路：自己拼一个接近抖音格式的
      text = `${a.desc || ''}\n${link}\n复制此链接，打开抖音搜索，直接观看视频！`;
    }

    return {
      text,
      link,
      desc: a.desc || '',
      author: a.author?.nickname || '',
      cover: a.video?.cover?.url_list?.[0] || a.video?.origin_cover?.url_list?.[0] || '',
      aweme_id: a.aweme_id,
    };
  }

  /**
   * 把一个视频整理成「可读的内容摘要」，供 LLM 判断内容。
   * 这是「理解内容」的核心：把结构化字段 + 评论热点拼成一段话。
   */
  async describe(awemeId, { withComments = true } = {}) {
    const feedList = await this.feed({ count: 30 });
    let v = feedList.find((x) => x.id === String(awemeId));

    // 不在当前流里就去搜（用 desc 关键词），或者直接读详情接口
    if (!v) {
      const q = new URLSearchParams({
        device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
        aweme_id: String(awemeId),
      });
      const d = await this.get('/aweme/v1/web/aweme/detail/?' + q.toString());
      const a = d.json?.aweme_detail;
      if (a) {
        v = {
          id: a.aweme_id, desc: a.desc || '', author: a.author?.nickname || '',
          tags: (a.text_extra || []).map((t) => t.hashtag_name).filter(Boolean),
          duration_sec: Math.round((a.video?.duration || 0) / 1000),
          cover: a.video?.cover?.url_list?.[0] || '',
          digg: a.statistics?.digg_count ?? 0, comment: a.statistics?.comment_count ?? 0,
          collect: a.statistics?.collect_count ?? 0, share: a.statistics?.share_count ?? 0,
          created: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 16) : '',
        };
      }
    }
    if (!v) return null;

    const lines = [];
    lines.push(`【标题/文案】${v.desc || '(无)'}`);
    if (v.tags.length) lines.push(`【话题标签】${v.tags.map((t) => '#' + t).join(' ')}`);
    lines.push(`【作者】${v.author}`);
    lines.push(`【时长】${v.duration_sec} 秒`);
    lines.push(`【数据】赞 ${v.digg} / 评论 ${v.comment} / 收藏 ${v.collect} / 分享 ${v.share}`);
    if (v.created) lines.push(`【发布】${v.created}`);
    if (v.cover) lines.push(`【封面】${v.cover}`);

    if (withComments) {
      const cs = await this.comments(awemeId, { count: 15 });
      if (cs.length) {
        lines.push(`\n【热门评论】`);
        for (const c of cs.slice(0, 12)) {
          lines.push(`  ${c.user}${c.is_author ? '(作者)' : ''}: ${c.text.slice(0, 80)} (赞${c.digg})`);
        }
      }
    }
    return { meta: v, text: lines.join('\n') };
  }

  /**
   * 从任意文本里提取抖音分享信息。
   *
   * 抖音分享文本长这样（QQ/微信/抖音私信里到处都是）：
   *   4.35 :0pm cmd:/ 07/10 p@d.aN 古代腹葬是什么？#腹葬 #一人分饰多角
   *   https://v.douyin.com/xxxxx/ 复制此链接，打开Dou音搜索，直接观看视频！
   */
  static extractShareLink(text) {
    const s = String(text || '');
    if (!s) return { found: false };

    // 1. 完整链接里直接抠 aweme_id
    const idMatch = s.match(/(?:douyin\.com\/video\/|iesdouyin\.com\/share\/video\/)(\d{15,25})/);
    if (idMatch) {
      return { found: true, kind: 'video_url', awemeId: idMatch[1], link: idMatch[0] };
    }

    // 2. 短链（要跟重定向才能拿到 id）
    const shortMatch = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
    if (shortMatch) {
      return { found: true, kind: 'short_url', awemeId: null, link: shortMatch[0] };
    }

    // 3. 其他 douyin 域名
    const anyMatch = s.match(/https?:\/\/[^\s"'<>]*(?:douyin|iesdouyin)\.com[^\s"'<>]*/);
    if (anyMatch) {
      return { found: true, kind: 'other', awemeId: null, link: anyMatch[0] };
    }

    return { found: false };
  }

  /**
   * 短链 → aweme_id。抖音短链 302 到 /video/<id> 或 /share/video/<id>/。
   */
  async resolveShortLink(shortUrl) {
    const finalUrl = await this.page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { redirect: 'follow', credentials: 'include' });
        return r.url || '';
      } catch {
        return '';
      }
    }, shortUrl);

    const m = String(finalUrl).match(/(?:\/video\/|\/share\/video\/)(\d{15,25})/);
    if (m) return m[1];

    const again = DouyinReader.extractShareLink(finalUrl);
    return again.awemeId || null;
  }

  /**
   * 一步到位：给一段分享文本，返回视频内容。
   * AI 收到「帮我看看这个抖音」时就调它。
   */
  async fromShareText(text, { withComments = true } = {}) {
    const info = DouyinReader.extractShareLink(text);
    if (!info.found) {
      return { ok: false, error: '这段文字里没有抖音链接' };
    }

    let awemeId = info.awemeId;
    if (!awemeId && info.link) {
      awemeId = await this.resolveShortLink(info.link);
    }
    if (!awemeId) {
      return { ok: false, error: '认出链接了，但解析不到视频 ID（可能已删除或需要登录）' };
    }

    const d = await this.describe(awemeId, { withComments });
    if (!d) {
      return { ok: false, error: `视频 ${awemeId} 不存在或读不到` };
    }

    return { ok: true, awemeId, ...d };
  }

  /**
   * 读抖音通知（@提醒、评论回复、点赞、关注）。
   *
   * 这是唯一能感知「有人在评论区 @ 我」的方式 —— 抖音没有推送 API，
   * 只能靠 hover 右上角通知图标弹出面板再解析。
   *
   * @param {object} opts
   *   - limit: 最多读几条，默认 20
   *   - kind: "all" 全部 / "interaction" 只看互动（评论/@/赞）
   */
  async readNotifications({ limit = 20 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 回首页，通知图标只在首页右上角
    if (!this.page.url().includes('douyin.com') || this.page.url().includes('/video/')) {
      await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
    }

    // hover 通知图标（坐标实测为 1238, 28；但窗口宽度变化时要重新找）
    const iconPos = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('li, div, span')) {
        const t = (el.textContent || '').trim();
        if (!/^通知\s*\d*$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10 || r.top > 100) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });

    if (!iconPos) throw new Error('找不到通知图标（页面可能未加载完）');

    await this.page.mouse.move(iconPos.x, iconPos.y);
    await sleep(2500);

    // 解析面板
    const data = await this.page.evaluate((maxCount) => {
      const out = { found: false, items: [], raw: "" };

      // 找浮层面板：顶部区域、宽 250-600、绝对定位
      let panel = null;
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 250 || r.width > 600) continue;
        if (r.height < 100 || r.height > 900) continue;
        if (r.top > 200) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
        const t = (el.innerText || '').trim();
        if (!t) continue;
        panel = el;
        out.found = true;
        break;
      }

      if (!panel) return out;
      out.raw = (panel.innerText || "").replace(/\s+/g, " ").slice(0, 600);

      // 逐条提取：每条通常是一个带头像的小块
      const seen = new Set();
      for (const el of panel.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.height < 40 || r.height > 140) continue;
        if (r.width < 180) continue;

        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length < 4 || txt.length > 200) continue;
        if (seen.has(txt)) continue;

        // 必须有头像（排除纯文字块）
        if (!el.querySelector('img')) continue;

        // 识别动作类型
        let action = 'other';
        if (/回复了你的评论|回复了你/.test(txt)) action = '回复评论';
        else if (/@了你|@了/.test(txt)) action = '@提醒';
        else if (/赞了你的评论|赞了你/.test(txt)) action = '点赞';
        else if (/关注了你/.test(txt)) action = '关注';
        else if (/评论了你的/.test(txt)) action = '评论';

        // 提取时间（02:03 / 昨天 / 2025-11-28）
        const timeMatch = txt.match(/(\d{1,2}:\d{2}|昨天|前天|\d{4}-\d{2}-\d{2})/);

        seen.add(txt);
        out.items.push({
          text: txt.slice(0, 150),
          action,
          time: timeMatch ? timeMatch[1] : '',
        });
      }

      out.items = out.items.slice(0, maxCount);
      return out;
    }, limit);

    // 鼠标移开，关掉面板
    await this.page.mouse.move(700, 500);
    await sleep(500);

    return data;
  }

  /**
   * 滚到页面底部，确保能看到「发布」按钮。
   *
   * 为什么需要：创作者中心的表单很长（描述、封面、音乐、标签、权限...），
   * 发布按钮在最下面，不滚动根本不在视口里。
   */
  async scrollToBottom(page) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 800);
      await sleep(600);
    }
    await sleep(1200);
  }

  /**
   * 找到并点击「发布」按钮（需要先滚动到底）。
   */
  async clickPublishButton(page) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await this.scrollToBottom(page);

    const btn = await page.evaluate(() => {
      const vh = window.innerHeight;
      const cands = [];
      for (const el of document.querySelectorAll('button, div[role="button"], div[class*="btn"], span')) {
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.width > 200) continue;
        if (r.height < 26 || r.height > 60) continue;
        const t = (el.textContent || '').trim();
        if (t !== '发布') continue;
        // 排除「定时发布」「立即发布」这类单选文字
        if (r.width < 60) continue;
        cands.push({
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          inView: r.top >= 0 && r.bottom <= vh,
          w: Math.round(r.width),
          cls: (el.className || '').toString().slice(0, 40),
        });
      }
      // 优先选视口内、宽度大一点的（主按钮通常 100+ 宽）
      cands.sort((a, b) => (b.inView ? 1 : 0) - (a.inView ? 1 : 0) || b.w - a.w);
      return cands[0] || null;
    });

    if (!btn) throw new Error('滚动后仍找不到「发布」按钮');

    await page.mouse.click(btn.x, btn.y);
    await sleep(2000);

    // 有些版本会弹二次确认
    const confirm = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, div[role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 24) continue;
        const t = (el.textContent || '').trim();
        if (t !== '确认发布' && t !== '确定') continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    if (confirm) {
      await page.mouse.click(confirm.x, confirm.y);
      await sleep(2000);
    }

    return btn;
  }

  /**
   * 找标题和描述两个输入框。
   *
   * 实测页面结构：
   *   「作品描述」区有两个输入：上面短的（限 20 字左右）、下面长的（限 1000 字）
   *   二者语义不同，不能混用。
   */
  async findTitleAndDesc(page) {
    return page.evaluate(() => {
      const vh = window.innerHeight;
      const cands = [];
      for (const el of document.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 18) continue;
        const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
        if (/搜索/.test(ph)) continue;
        cands.push({
          tag: el.tagName,
          ph,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          h: Math.round(r.height),
          w: Math.round(r.width),
          inView: r.top >= 0 && r.bottom <= vh,
        });
      }
      // 标题：矮的那一行；描述：高的大框（textarea 或多行 contenteditable）
      const textareas = cands.filter((c) => c.tag === 'TEXTAREA' || c.h > 60);
      const singles = cands.filter((c) => c.tag !== 'TEXTAREA' && c.h <= 60);
      return {
        title: singles[0] || null,
        desc: textareas[0] || null,
        all: cands,
      };
    });
  }

  /**
   * 打开发布页（创作者中心）。
   * 返回一个 page 对象，后续在这个 page 上操作。
   */
  async openUploadPage() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 先回首页
    if (!this.page.url().includes('douyin.com')) {
      await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
    }

    // 找「投稿」按钮并点击（会开新标签）
    const btn = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('li, div, span')) {
        const t = (el.textContent || '').trim();
        if (t !== '投稿') continue;
        const r = el.getBoundingClientRect();
        if (r.top > 100 || r.width < 20) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    if (!btn) throw new Error('找不到「投稿」按钮（可能未登录）');

    const pagesBefore = this.page.context().pages().length;
    await this.page.mouse.click(btn.x, btn.y);
    await sleep(5000);

    // 拿新开的标签
    const pages = this.page.context().pages();
    if (pages.length <= pagesBefore) {
      // 没开新标签，可能直接跳转了
      if (this.page.url().includes('creator.douyin.com')) {
        return this.page;
      }
      throw new Error('点击投稿后没有打开创作者中心');
    }

    const uploadPage = pages[pages.length - 1];
    await uploadPage.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(4000);
    return uploadPage;
  }

  /**
   * 发布视频作品。
   *
   * @param {object} opts
   *   - videoPath: 视频文件的本地绝对路径
   *   - title: 标题/文案（含话题）
   *   - dryRun: 只上传不发布（默认 false）
   * @returns {{ uploaded, published, title, error }}
   */
  async publishVideo({ videoPath, title = '', desc = '', music = '', dryRun = false } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('视频文件不存在: ' + videoPath);
    }

    const uploadPage = await this.openUploadPage();

    // 1. 上传文件
    const fileInput = uploadPage.locator('input[type="file"]').first();
    if (await fileInput.count() === 0) {
      throw new Error('找不到文件上传控件');
    }
    await fileInput.setInputFiles(videoPath);
    await sleep(3000);

    // 2. 等上传/处理完成（页面会出现标题输入框）
    let editor = null;
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      editor = await uploadPage.evaluate(() => {
        for (const el of document.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 20) continue;
          if (r.top < 0 || r.bottom > window.innerHeight) continue;
          return {
            tag: el.tagName,
            ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          };
        }
        return null;
      });
      if (editor) break;
    }

    if (!editor) {
      return { uploaded: false, published: false, error: '上传后没等到编辑界面（可能超时或格式不支持）' };
    }

    // 3. 填标题和描述（【改】二者是两个不同的输入框）
    //
    // 实测页面：「作品描述」区上方是短标题（约 20 字），
    // 下方的大框才是长描述（1000 字）。混填会导致描述被截断。
    const fields = await this.findTitleAndDesc(uploadPage);
    const filled = { title: false, desc: false };

    if (title) {
      // 短的当标题填
      if (fields.title) {
        await uploadPage.mouse.click(fields.title.x, fields.title.y);
        await sleep(700);
        await uploadPage.keyboard.type(String(title), { delay: 35 });
        await sleep(900);
        filled.title = true;
      } else if (editor) {
        // 兜底：用最早找到的那个
        await uploadPage.mouse.click(editor.x, editor.y);
        await sleep(700);
        await uploadPage.keyboard.type(String(title), { delay: 35 });
        await sleep(900);
        filled.title = true;
      }
    }

    // desc 参数：如果有就填长描述框
    if (typeof desc === 'string' && desc) {
      if (fields.desc) {
        await uploadPage.mouse.click(fields.desc.x, fields.desc.y);
        await sleep(700);
        await uploadPage.keyboard.type(String(desc), { delay: 30 });
        await sleep(900);
        filled.desc = true;
      }
    }

    if (dryRun) {
      return { uploaded: true, published: false, dryRun: true, title, desc: desc || '', filled };
    }

    // 【音乐】发布前选一首
    let musicResult = null;
    if (music) {
      try {
        musicResult = await this.pickMusic({ page: uploadPage, keyword: music, index: 0 });
      } catch (e) {
        musicResult = { picked: false, error: String(e?.message ?? e).slice(0, 100) };
      }
    }

    // 4. 点「发布」—— 需要先滚到底（按钮在页面最下面）
    try {
      await this.clickPublishButton(uploadPage);
    } catch (e) {
      return { uploaded: true, published: false, error: String(e?.message ?? e).slice(0, 120) };
    }
    await sleep(6000);

    // 5. 确认发布成功（URL 变化或出现成功提示）
    const result = await uploadPage.evaluate(() => ({
      url: location.href,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    }));

    const ok = /管理|成功|已发布/.test(result.text) || result.url.includes('content/manage');

    return {
      uploaded: true,
      published: ok,
      title,
      desc: desc || '',
      music: musicResult,
      filled,
      finalUrl: result.url,
      pageText: result.text.slice(0, 150),
    };
  }


  /**
   * 打开指定的发布形式（视频 / 图文 / 全景 / 文章）。
   * @param {'video'|'image'|'panorama'|'article'} mode
   */
  async openPublishMode(mode = 'video') {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const tabName = {
      video: '发布视频',
      image: '发布图文',
      panorama: '发布全景视频',
      article: '发布文章',
    }[mode];
    if (!tabName) throw new Error('未知的发布形式: ' + mode);

    const page = await this.openUploadPage();
    await sleep(2500);

    // 找 tab 并点击
    const tab = await page.evaluate((name) => {
      for (const el of document.querySelectorAll('div, span, a, li')) {
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.width > 220) continue;
        if (r.height < 18 || r.height > 55) continue;
        const t = (el.textContent || '').trim();
        if (t !== name) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    }, tabName);

    if (!tab) throw new Error('找不到「' + tabName + '」按钮');
    await page.mouse.click(tab.x, tab.y);
    await sleep(3500);

    return page;
  }

  /**
   * 发布图文（多张图片 + 文字）。
   *
   * @param {object} opts
   *   - imagePaths: 图片路径数组（1-9 张）
   *   - title: 文字描述 / 标题
   *   - dryRun: 只上传不发布
   */
  async publishImages({ imagePaths = [], title = '', desc = '', music = '', dryRun = false } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (!imagePaths.length) throw new Error('至少需要一张图片');
    for (const p of imagePaths) {
      if (!fs.existsSync(p)) throw new Error('图片不存在: ' + p);
    }

    const page = await this.openPublishMode('image');

    // 找图片上传控件（accept 含 image 的那个）
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count();
    let targetInput = null;

    for (let i = 0; i < count; i++) {
      const accept = await inputs.nth(i).getAttribute('accept');
      if (accept && accept.includes('image')) {
        targetInput = inputs.nth(i);
        break;
      }
    }
    if (!targetInput) throw new Error('找不到图片上传控件');

    await targetInput.setInputFiles(imagePaths);
    await sleep(4000);

    // 等编辑界面（标题输入框出现）
    let editor = null;
    for (let i = 0; i < 30; i++) {
      await sleep(2500);
      editor = await page.evaluate(() => {
        for (const el of document.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 150 || r.height < 20) continue;
          if (r.top < 0 || r.bottom > window.innerHeight) continue;
          const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
          // 跳过搜索框
          if (/搜索/.test(ph)) continue;
          return {
            tag: el.tagName,
            ph,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          };
        }
        return null;
      });
      if (editor) break;
    }

    if (!editor) {
      return { uploaded: false, published: false, error: '图片上传后没等到编辑界面' };
    }

    // 【改】图片：标题描述分离
    // 和视频一样，页面有短标题和长描述两个输入框。
    const fields = await this.findTitleAndDesc(page);
    const filled = { title: false, desc: false };

    if (title) {
      if (fields.title) {
        await page.mouse.click(fields.title.x, fields.title.y);
        await sleep(700);
        await page.keyboard.type(String(title), { delay: 40 });
        await sleep(900);
        filled.title = true;
      } else if (editor) {
        await page.mouse.click(editor.x, editor.y);
        await sleep(700);
        await page.keyboard.type(String(title), { delay: 40 });
        await sleep(900);
        filled.title = true;
      }
    }

    if (typeof desc === 'string' && desc) {
      if (fields.desc) {
        await page.mouse.click(fields.desc.x, fields.desc.y);
        await sleep(700);
        await page.keyboard.type(String(desc), { delay: 30 });
        await sleep(900);
        filled.desc = true;
      }
    }

    if (dryRun) {
      return {
        uploaded: true, published: false, dryRun: true,
        imageCount: imagePaths.length, title, desc: desc || '', filled,
      };
    }

    // 【音乐】发布前选一首
    let musicResult = null;
    if (music) {
      try {
        musicResult = await this.pickMusic({ page, keyword: music, index: 0 });
      } catch (e) {
        // 配乐失败不该阻断发布
        musicResult = { picked: false, error: String(e?.message ?? e).slice(0, 100) };
      }
    }

    // 点发布（先滚到底）
    try {
      await this.clickPublishButton(page);
    } catch (e) {
      return { uploaded: true, published: false, error: String(e?.message ?? e).slice(0, 120) };
    }
    await sleep(6000);

    const result = await page.evaluate(() => ({
      url: location.href,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    }));

    const ok = /管理|成功|已发布/.test(result.text) || result.url.includes('content/manage');

    return {
      uploaded: true,
      published: ok,
      imageCount: imagePaths.length,
      title,
      desc: desc || '',
      music: musicResult,
      filled,
      finalUrl: result.url,
      pageText: result.text.slice(0, 150),
    };
  }


  /**
   * 在发布页选一首背景音乐。
   *
   * @param {object} opts
   *   - page: 发布页的 Page 对象
   *   - keyword: 搜索关键词（歌名/风格）。省略则用推荐列表第一条
   *   - index: 选第几条（从 0 开始，默认 0）
   *   - dryRun: 只搜索不选中
   * @returns {{ picked, name, candidates }}
   */
  async pickMusic({ page, keyword = '', index = 0, dryRun = false } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 1. 滚到音乐那一行并点「选择音乐」
    //    注意：页面上有两个「选择音乐」文字 —— 左边是标签，右边才是按钮。
    //    取最右边那个（x 更大）。
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('div, span')) {
        if ((el.textContent || '').trim() === '选择音乐') {
          el.scrollIntoView({ block: 'center' });
          return;
        }
      }
    });
    await sleep(1500);

    const btn = await page.evaluate(() => {
      const vh = window.innerHeight;
      const cands = [];
      for (const el of document.querySelectorAll('div, span, button')) {
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.width > 220) continue;
        if (r.height < 14 || r.height > 55) continue;
        if (r.top < 0 || r.bottom > vh) continue;
        if ((el.textContent || '').trim() !== '选择音乐') continue;
        cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rx: Math.round(r.x) });
      }
      cands.sort((a, b) => b.rx - a.rx);
      return cands[0] || null;
    });

    if (!btn) throw new Error('找不到「选择音乐」按钮');

    await page.mouse.click(btn.x, btn.y);
    await sleep(4000);

    // 2. 等弹窗出现
    let dialogReady = false;
    for (let i = 0; i < 12; i++) {
      dialogReady = await page.evaluate(() => {
        for (const el of document.querySelectorAll('div')) {
          const r = el.getBoundingClientRect();
          if (r.width < 380 || r.height < 250) continue;
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (/搜索音乐|推荐|热门榜/.test(el.innerText || '')) return true;
        }
        return false;
      });
      if (dialogReady) break;
      await sleep(1200);
    }
    if (!dialogReady) throw new Error('音乐弹窗没打开');

    // 3. 有关键词就搜索
    if (keyword) {
      const box = await page.evaluate(() => {
        for (const el of document.querySelectorAll('input')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 18) continue;
          const ph = el.getAttribute('placeholder') || '';
          if (!/搜索/.test(ph)) continue;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
        return null;
      });
      if (box) {
        await page.mouse.click(box.x, box.y);
        await sleep(700);
        await page.keyboard.type(String(keyword), { delay: 70 });
        await sleep(900);
        await page.keyboard.press('Enter');
        await sleep(4000);
      }
    }

    // 4. 收集候选条目
    const list = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      // 全屏弹窗
      let dlg = null, best = 0;
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 380 || r.height < 250) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (!/搜索音乐|推荐|热门榜/.test(el.innerText || '')) continue;
        const a = r.width * r.height;
        if (a > best) { best = a; dlg = el; }
      }
      if (!dlg) return out;

      for (const el of dlg.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.height < 30 || r.height > 110) continue;
        if (r.width < 250) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length < 4 || t.length > 160) continue;
        if (seen.has(t)) continue;
        // 必须有「使用人数」或时长标记，才是音乐条目
        if (!/\d{1,2}:\d{2}/.test(t)) continue;
        // 排除只有歌名+歌手没时长的父容器重复
        seen.add(t);
        out.push({
          text: t,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        });
        if (out.length >= 15) break;
      }
      return out;
    });

    if (!list.length) throw new Error('弹窗里没找到音乐条目');

    if (dryRun) {
      return { picked: false, dryRun: true, keyword, candidates: list };
    }

    // 5. 选第 index 条
    const target = list[Math.min(index, list.length - 1)];
    // 点条目右侧的「使用」区（整行点击通常也能选）
    await page.mouse.click(target.x, target.y);
    await sleep(2500);

    // 有些版本要再点一次「使用」
    const useBtn = await page.evaluate(() => {
      for (const el of document.querySelectorAll('div, span, button')) {
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.width > 120 || r.height < 18 || r.height > 50) continue;
        if ((el.textContent || '').trim() !== '使用') continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    if (useBtn) {
      await page.mouse.click(useBtn.x, useBtn.y);
      await sleep(2000);
    }

    // 6. 确认弹窗关了、音乐填上了
    const applied = await page.evaluate(() => {
      // 弹窗还在吗
      let stillOpen = false;
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 380 || r.height < 250) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        if (/搜索音乐|热门榜/.test(el.innerText || '')) { stillOpen = true; break; }
      }
      // 页面上还显示「点击添加合适作品风格音乐」吗
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const notPicked = /点击添加合适作品风格音乐/.test(bodyText);
      return { stillOpen, notPicked, bodyText: bodyText.slice(0, 200) };
    });

    // 如果还开着，尝试按 Esc 关掉
    if (applied.stillOpen) {
      await page.keyboard.press('Escape');
      await sleep(1500);
    }

    return {
      picked: !applied.notPicked,
      name: target.text,
      candidates: list.slice(0, 5),
    };
  }

}

export default DouyinReader;
