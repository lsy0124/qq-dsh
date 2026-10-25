import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// 抖音网页自动化核心。
//
// 设计核心：**不自己算 a_bogus 签名**。
// 抖音每个 web 接口都要求 a_bogus/msToken/verifyFp/x-signature 等签名参数，
// 这些由页面里的混淆 JS 在发请求时现场计算。逆向它既费时又随时会失效。
// 所以这里做的是「借页面环境发请求」：page.evaluate() 里用页面自己的 fetch，
// 签名由页面代码自动补上，我们只负责给 URL 和 body。
//
// 代价：必须保持一个浏览器实例（headful 或 headless 均可），操作有延迟。
// 收益：接口版本变化时基本不用改，只要页面还能用，我们就能用。

const BASE = 'D:\\Users\\未开封的汽水\\Documents\\Downloads\\新建文件夹\\douyin';
const USER_DATA = path.join(BASE, 'edgedata');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

export class DouyinBot {
  constructor({ headless = false } = {}) {
    this.headless = headless;
    this.ctx = null;
    this.page = null;
  }

  async start() {
    fs.mkdirSync(USER_DATA, { recursive: true });

    // 清掉上一次异常退出留下的单实例锁。
    // 不清的话第二次启动会直接失败（"已在另一个会话中打开"），
    // 而 MCP server 是长驻进程，反复重启必然遇到。
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(USER_DATA, f), { force: true }); } catch {}
    }

    this.ctx = await chromium.launchPersistentContext(USER_DATA, {
      channel: 'msedge',
      headless: this.headless,
      viewport: { width: 1400, height: 900 },
      locale: 'zh-CN',
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    this.page = await this.ctx.newPage();
    await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(2500, 4000));
    // 关掉可能挡住的登录/引导弹窗
    await this.page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    return this;
  }

  /** 在页面上下文里发请求，签名由页面自动补 */
  async api(urlPath, { method = 'GET', body = null } = {}) {
    const full = urlPath.startsWith('http') ? urlPath : `https://www.douyin.com${urlPath}`;
    return this.page.evaluate(async ({ full, method, body }) => {
      const opt = {
        method,
        credentials: 'include',
        headers: {
          'content-type': method === 'POST' ? 'application/x-www-form-urlencoded' : 'application/json',
        },
      };
      if (body) opt.body = body;
      const r = await fetch(full, opt);
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, ok: r.ok, json, text: text.slice(0, 400) };
    }, { full, method, body });
  }

  /** 判断是否已登录 */
  async isLoggedIn() {
    return this.page.evaluate(() => {
      const hasLogin = !!document.querySelector('[data-e2e="login-button"]');
      // 有头像/用户信息元素说明已登录
      const hasUser = !!document.querySelector('[data-e2e="user-info"], [data-e2e="live-avatar"]');
      return { hasLogin, hasUser };
    });
  }

  /**
   * 拉推荐流。
   * 用 /aweme/v1/web/tab/feed/ —— 比 v2/module/feed 简单，返回结构更规整。
   */
  async getFeed(count = 10) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      count: String(count),
      refresh_index: '1',
      video_type_select: '1',
    });
    const r = await this.api('/aweme/v1/web/tab/feed/?' + q.toString());
    if (!r.ok || !r.json) return { ok: false, error: r.text, list: [] };

    const list = (r.json.aweme_list || []).map((a) => ({
      aweme_id: a.aweme_id,
      desc: a.desc || '',
      author: a.author?.nickname || '',
      digg_count: a.statistics?.digg_count ?? 0,
      comment_count: a.statistics?.comment_count ?? 0,
      collect_count: a.statistics?.collect_count ?? 0,
      share_count: a.statistics?.share_count ?? 0,
      duration: a.video?.duration ?? 0,
      create_time: a.create_time,
    }));
    return { ok: true, list };
  }

  /**
   * 点赞。
   * 接口：/aweme/v1/web/commit/item/digg/
   * aweme_type 抖音要求传，0 表示普通视频。
   */
  async like(awemeId) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      aweme_id: String(awemeId),
      aweme_type: '0',
      item_version: '0',
    });
    const r = await this.api('/aweme/v1/web/commit/item/digg/?' + q.toString(), { method: 'POST' });
    return { ok: r.ok && r.json?.status_code === 0, raw: r.json ?? r.text };
  }

  /**
   * 收藏。
   * 接口：/aweme/v1/web/aweme/collect/  （action=1 收藏，0 取消）
   */
  async collect(awemeId) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      aweme_id: String(awemeId),
      action: '1',
    });
    const r = await this.api('/aweme/v1/web/aweme/collect/?' + q.toString(), { method: 'POST' });
    return { ok: r.ok && (r.json?.status_code === 0 || r.json?.status_code === undefined), raw: r.json ?? r.text };
  }

  /**
   * 评论。
   * 接口：/aweme/v1/web/comment/publish/
   */
  async comment(awemeId, text) {
    const q = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      aweme_id: String(awemeId),
      text: text,
      text_extra: '[]',
      aweme_type: '0',
    });
    const r = await this.api('/aweme/v1/web/comment/publish/?' + q.toString(), { method: 'POST' });
    return { ok: r.ok && (r.json?.status_code === 0 || r.json?.status_code === undefined), raw: r.json ?? r.text };
  }

  /** 关闭 */
  async close() {
    await this.ctx?.close().catch(() => {});
  }
}

// 直接运行时做一次自检
if (process.argv[1] && process.argv[1].endsWith('douyin-core.mjs')) {
  (async () => {
    const bot = new DouyinBot({ headless: false }).start();
    const self = await bot;
    console.log('登录状态:', JSON.stringify(await self.isLoggedIn()));
    const feed = await self.getFeed(10);
    console.log(`\n拿到 ${feed.list.length} 条视频:`);
    for (const v of feed.list) {
      console.log(`  ${v.aweme_id}  ❤${v.digg_count}  ${v.author} | ${v.desc.slice(0, 40)}`);
    }
    await self.close();
  })();
}
