import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// 抖音私信与分享的 UI 自动化。
//
// 为什么走 UI 而不是接口：
//   私信接口走 protobuf（imapi.douyin.com/v1/message/...），body 是二进制，
//   逆向 schema 成本高且随时失效。而 UI 路径已经实测跑通（真实发出过消息），
//   而且抖音改版时只要选择器还在就还能用。
//
// 已知的坑（都踩过了）：
//   1. 消息面板不会自动打开，必须点右上角「消息」图标（约 1278, 28）
//   2. 对话列表点开会话后才出现输入框
//   3. 输入框是 contenteditable 的 DIV，不是 textarea；必须用 keyboard.type
//      逐字输入才能触发框架的 onChange，直接改 innerText 无效
//   4. Enter 发送；发送后编辑器会留一个零宽字符 \u200b，别误判为失败

const BASE = 'D:\\Users\\未开封的汽水\\Documents\\Downloads\\新建文件夹\\douyin';
const USER_DATA = path.join(BASE, 'edgedata');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DouyinIM {
  constructor(page) {
    this.page = page;
  }

  /** 判断消息面板是否已展开 */
  async isPanelOpen() {
    return this.page.evaluate(() => {
      // 面板展开时会话列表项处于可见状态；折叠时它们不渲染或尺寸为 0
      let visible = 0;
      for (const el of document.querySelectorAll('div, li')) {
        const r = el.getBoundingClientRect();
        if (r.x < 1040 || r.width < 200 || r.height < 45 || r.height > 90) continue;
        const t = (el.textContent || '').trim();
        if (t.length > 2) visible++;
      }
      return visible > 0;
    });
  }

  /** 打开消息面板（已打开就跳过——再点图标会把它关掉） */
  async openPanel() {
    if (await this.isPanelOpen()) {
      return true;
    }
    const icon = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('li, div')) {
        const t = (el.textContent || '').trim();
        if (!/^消息\s*\d*$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10 || r.top > 100) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    if (!icon) throw new Error('找不到消息图标（页面可能未加载完）');
    await this.page.mouse.click(icon.x, icon.y);
    await sleep(2500);
    return true;
  }

  /** 列出当前面板里的会话 */
  async listConversations() {
    return this.page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('div, li, a')) {
        const r = el.getBoundingClientRect();
        if (r.x < 1040 || r.width < 200 || r.width > 400) continue;
        if (r.height < 45 || r.height > 90) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length < 2) continue;
        out.push({
          text: t.slice(0, 50),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        });
      }
      // 去重（父子重复）
      const uniq = [];
      for (const c of out) {
        if (uniq.some((u) => Math.abs(u.y - c.y) < 12)) continue;
        uniq.push(c);
      }
      return uniq;
    });
  }

  /** 按昵称模糊匹配并打开会话 */
  async openConversation(nameHint) {
    const convs = await this.listConversations();
    const target = nameHint
      ? convs.find((c) => c.text.includes(nameHint))
      : convs.find((c) => !/^消息/.test(c.text) && c.y > 100);
    if (!target) {
      throw new Error(`找不到会话 ${nameHint ?? '(第一个)'}；现有: ${convs.map((c) => c.text.slice(0, 12)).join(' | ')}`);
    }
    await this.page.mouse.click(target.x, target.y);
    await sleep(3000);

    // 确认输入框出现
    const box = await this.page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"][class*="messageEditor"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!box) throw new Error('会话打开了但输入框没出现');
    return { conversation: target.text, box };
  }

  /** 在已打开的会话里发文字 */
  async sendText(text, box) {
    await this.page.mouse.click(box.x, box.y);
    await sleep(900);
    await this.page.keyboard.type(String(text), { delay: 50 });
    await sleep(1200);

    const before = await this.page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"][class*="messageEditor"]');
      return el ? (el.innerText || '').trim() : '';
    });
    if (!before) throw new Error('文字没能输入到编辑器');

    await this.page.keyboard.press('Enter');
    await sleep(2500);

    // 发送后编辑器只剩零宽字符
    const after = await this.page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"][class*="messageEditor"]');
      const t = el ? (el.innerText || '') : '';
      return t.replace(/\u200b/g, '').trim();
    });
    return { sent: after === '', typed: before };
  }

  /** 一步到位：打开面板 → 选会话 → 发消息 */
  async sendTo(nameHint, text) {
    await this.openPanel();
    const { conversation, box } = await this.openConversation(nameHint);
    const r = await this.sendText(text, box);
    return { conversation, ...r };
  }

  /**
   * 读取当前已打开会话里的消息（只读）。
   *
   * 抖音私信 DOM：自己的消息靠右、对方的靠左；
   * 分享的视频是卡片（有封面图 + 标题），链接可能不在可见文本里。
   */
  async readConversation({ limit = 30 } = {}) {
    // 判断消息归属靠头像位置（实测最可靠）。
    // 抖音私信里：对方头像固定在左侧（x≈1077），自己的在右侧（x≈1353）。
    // 之前用 centerX > width*0.72 判断，但抓到的元素往往是整块容器
    // （x 跨 1053-1377，center 全是面板中心），所以永远判成同一边。
    const data = await this.page.evaluate((maxCount) => {
      const out = [];
      const winW = window.innerWidth;

      // 找聊天容器（右侧面板里面积最大的）
      let container = null, bestArea = 0;
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.x < 980 || r.width < 250 || r.height < 200) continue;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; container = el; }
      }
      if (!container) return { messages: [], count: 0, error: '找不到聊天区域' };

      // 收集头像位置（左右两侧的锚点）
      const leftAvatars = [];
      const rightAvatars = [];
      for (const img of container.querySelectorAll('img')) {
        const r = img.getBoundingClientRect();
        if (r.width < 20 || r.width > 60) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (cx < winW * 0.85) leftAvatars.push(cy);
        else rightAvatars.push(cy);
      }

      // 判断某个 y 更靠近哪一侧的头像
      const sideOf = (y) => {
        const near = (arr) => {
          let best = Infinity;
          for (const a of arr) {
            const d = Math.abs(a - y);
            if (d < best) best = d;
          }
          return best;
        };
        const dl = near(leftAvatars);
        const dr = near(rightAvatars);
        if (dl === Infinity && dr === Infinity) return "unknown";
        if (dl === Infinity) return "me";
        if (dr === Infinity) return "them";
        // 距离在 120px 内才有意义，都太远就判未知
        if (Math.min(dl, dr) > 120) return "unknown";
        return dl < dr ? "them" : "me";
      };

      // 提取消息：优先找"最内层"的文字块（排除包着别人的大容器）
      const candidates = [];
      for (const el of container.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.height < 22 || r.height > 300) continue;
        if (r.width < 40 || r.width > 620) continue;

        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 500) continue;

        // 过滤时间戳和系统提示：这些不是消息内容
        if (/^\d{1,2}:\d{2}(\s|$)/.test(txt)) continue;
        if (/^(昨天|前天|星期[一二三四五六日]|\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(txt)) continue;
        if (/^(以下为新消息|对方正在输入|已读|未读)/.test(txt)) continue;
        if (/^\d{1,2}:\d{2}\s*$/.test(txt)) continue;

        // 排除：包含子 div 且子 div 也有文字（说明是容器）
        let childWithText = 0;
        for (const c of el.children) {
          if (!c.querySelector) continue;
          const ct = (c.innerText || '').trim();
          if (ct) childWithText++;
        }
        if (childWithText > 0 && r.height > 60) continue;

        candidates.push({ txt, r, area: r.width * r.height });
      }

      // 同样文字只留面积最小的（最内层那个）
      const byText = new Map();
      for (const c of candidates) {
        const prev = byText.get(c.txt);
        if (!prev || c.area < prev.area) byText.set(c.txt, c);
      }

      for (const { txt, r } of byText.values()) {
        const cy = r.y + r.height / 2;
        const from = sideOf(cy);

        const links = [];
        for (const a of container.querySelectorAll('a[href]')) {
          const ar = a.getBoundingClientRect();
          if (Math.abs((ar.y + ar.height / 2) - cy) > 40) continue;
          const h = a.getAttribute('href') || '';
          if (/douyin|iesdouyin/.test(h)) links.push(h);
        }
        const urlRe = /https?:\/\/[^\s"'<>]*(?:douyin|iesdouyin)\.com[^\s"'<>]*/g;
        const inline = txt.match(urlRe);
        if (inline) links.push(...inline);

        out.push({
          from,
          text: txt.slice(0, 300),
          links: [...new Set(links)],
          y: Math.round(cy),
        });
      }

      out.sort((a, b) => a.y - b.y);
      return { messages: out.slice(-maxCount), count: out.length };
    }, limit);

    return data;
  }

  /**
   * 打开会话 → 读消息 → 把里面的抖音链接解析成视频详情。
   * 这是「别人在抖音私信里给我分享视频」的正确处理路径。
   */
  async readSharedFrom(nameHint, { limit = 20, reader = null } = {}) {
    await this.openPanel();
    const { conversation } = await this.openConversation(nameHint);
    await new Promise((r) => setTimeout(r, 2500));

    const raw = await this.readConversation({ limit });

    const videos = [];
    if (reader) {
      for (const m of raw.messages || []) {
        for (const link of m.links) {
          try {
            const r = await reader.fromShareText(link);
            if (r?.ok) {
              videos.push({ link, aweme_id: r.awemeId, text: r.text, from: m.from, sender: m.from === 'me' ? '你' : '对方' });
              break;
            }
          } catch {}
        }
      }
    }

    return { conversation, messages: raw.messages || [], videos, count: raw.count || 0 };
  }

  /** 分享一条视频给某个会话 */
  async shareVideo(nameHint, awemeId, { desc } = {}) {
    const link = `https://www.douyin.com/video/${awemeId}`;
    const title = desc ? `【${desc.slice(0, 40)}】\n` : '';
    const text = `${title}${link}`;
    return this.sendTo(nameHint, text);
  }
}

export default DouyinIM;

// 直接运行时：自测发送
if (process.argv[1] && process.argv[1].endsWith('douyin-im.mjs')) {
  const { DouyinBot } = await import('./douyin-core.mjs');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(USER_DATA, f), { force: true }); } catch {}
  }
  const bot = await new DouyinBot({ headless: false }).start();
  const im = new DouyinIM(bot.page);
  try {
    console.log('会话列表:');
    await im.openPanel();
    const convs = await im.listConversations();
    convs.forEach((c) => console.log('  ' + c.text.slice(0, 30)));
    if (process.env.IM_SEND === '1') {
      const r = await im.sendTo(process.env.IM_TO || '', process.env.IM_TEXT || '测试消息');
      console.log('发送结果:', JSON.stringify(r));
    }
  } catch (e) {
    console.error('失败:', e?.message);
  } finally {
    await sleep(3000);
    await bot.close();
  }
}
