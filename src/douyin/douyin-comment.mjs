import fs from 'node:fs';
import path from 'node:path';

// 抖音评论 + @好友。
//
// 定位依据（实测出来的，别再猜）：
//   评论容器 class 含 `comment-input-inner-container`，文字是「留下你的精彩评论吧」
//   它在页面底部（y ≈ 814），需要先把页面滚到底才渲染
//   点它之后才会出现真正的编辑器（contenteditable）
//
// 写操作一律走 UI：comment/publish 接口有服务端强校验（和点赞一样失败）。

const BASE = 'D:\\Users\\未开封的汽水\\Documents\\Downloads\\新建文件夹\\douyin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DouyinComment {
  constructor(page) {
    this.page = page;
  }

  /**
   * 如果是 modal 模式（自己作品/个人主页弹窗），先展开评论区。
   *
   * 实测：自己的作品走 /user/self?modal_id=xxx，右侧是竖排图标栏
   * （赞 33 / 评论 7 / 收藏 1 / 分享 1），评论区默认收起，
   * 页面上只有一个弹幕输入框。必须点那个评论图标才能展开。
   *
   * @returns {{ isModal, expanded }}
   */
  async ensureCommentPanel() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const isModal = await this.page.evaluate(() => {
      if (/modal_id=/.test(location.href)) return true;
      // 备用判据：右侧有竖排图标栏（宽 40 左右、靠右、多个堆叠）
      const vh = window.innerHeight;
      let count = 0;
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.width > 70) continue;
        if (r.height < 30 || r.height > 70) continue;
        if (r.x < window.innerWidth - 120) { count++; }
      }
      return count >= 3;
    });

    if (!isModal) return { isModal: false, expanded: true };

    // 【严格判断】只认真正的评论输入框
    //
    // 之前的坑：用「页面上有数字」判断 → 「相关推荐」列表里全是数字，永远 true，
    // 于是误判成「已展开」，后面 findCommentBox 就找不到东西。
    const already = await this.page.evaluate(() => {
      // ① 有 Draft 编辑器
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 14) return true;
      }
      // ② 有评论框的 placeholder 文字（必须可见，排除 0x0 幽灵节点）
      for (const el of document.querySelectorAll('div, span')) {
        const t = (el.textContent || '').trim();
        if (/^(留下你的精彩评论吧|说点什么\.\.\.?|善语结善缘)$/.test(t)) {
          const r = el.getBoundingClientRect();
          if (r.width > 80 && r.height > 20) return true;
        }
      }
      return false;
    });
    if (already) return { isModal: true, expanded: true, via: 'already-open' };

    // 【B】note/self 页：点「评论(N)」tab
    //
    // 实测 /note/xxx 页面：右侧面板顶部是 tabs（相关推荐 | 评论(7)），
    // 点「评论(7)」这个 tab 才会显示评论区。
    // 这里的评论数是嵌在 tab 文字里的，不是浮动数字，所以不能用下面的数字逻辑。
    const tabBtn = await this.page.evaluate(() => {
      const vh = window.innerHeight;
      for (const el of document.querySelectorAll('div, span, a, [role="tab"]')) {
        const t = (el.textContent || '').trim();
        // 匹配「评论(7)」「评论（7）」「评论 7」「评论」
        if (!/^评论[\s(（]*\d*[)）]*$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.width > 200) continue;
        if (r.height < 16 || r.height > 60) continue;
        if (r.top < 0 || r.bottom > vh) continue;
        return {
          text: t,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      }
      return null;
    });

    if (tabBtn) {
      await this.page.mouse.click(tabBtn.x, tabBtn.y);
      await sleep(3500);

      // 用同样严格的标准再验一次
      const okTab = await this.page.evaluate(() => {
        for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 100 && r.height > 14) return true;
        }
        for (const el of document.querySelectorAll('div, span')) {
          const t = (el.textContent || '').trim();
          if (/^(留下你的精彩评论吧|说点什么\.\.\.?|善语结善缘)$/.test(t)) return true;
        }
        return false;
      });

      if (okTab) {
        return { isModal: true, expanded: true, via: 'comment-tab', tab: tabBtn };
      }
      // 点完还没展开，记录一下继续往下走（后面还有浮动图标兜底）
      console.warn('[ensureCommentPanel] 点了评论 tab 但没检测到输入框，继续尝试浮动图标');
    }

    // 用「图标下方的纯数字」定位（比猜第几个稳）
    //
    // 实测：右侧竖排每个图标下面都跟一个纯数字（评论数/点赞数...）。
    // 找到这些数字，评论那个是第 2 个，点它上方约 30px 就是图标。
    const icon = await this.page.evaluate(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      // ① 收集靠右的纯数字
      const nums = [];
      for (const el of document.querySelectorAll('span, div')) {
        const t = (el.textContent || '').trim();
        if (!/^\d+(\.\d+)?[万wW]?$/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.width > 70) continue;
        if (r.height < 8 || r.height > 30) continue;
        if (r.x < vw - 140) continue;
        if (r.top < 120 || r.bottom > vh - 40) continue;
        nums.push({
          n: t,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          cy: Math.round(r.y + r.height / 2),
        });
      }
      if (nums.length < 2) return null;

      // ② 按 y 排序 + 去重
      nums.sort((a, b) => a.cy - b.cy);
      const uniq = [];
      for (const c of nums) {
        if (uniq.some((u) => Math.abs(u.cy - c.cy) < 25)) continue;
        uniq.push(c);
      }
      if (uniq.length < 2) return null;

      // ③ 第 2 个是评论数，点它上方 ~30px
      const cmt = uniq[1];
      return {
        x: cmt.x,
        y: Math.max(120, cmt.y - 30),
        count: cmt.n,
        allNums: uniq.map((u) => u.n),
      };
    });

    if (!icon) return { isModal: true, expanded: false, error: '找不到右侧评论图标' };

    await this.page.mouse.click(icon.x, icon.y);
    await sleep(3000);

    // 确认展开了
    const ok = await this.page.evaluate(() => {
      if (document.querySelector('.public-DraftEditor-content')) return true;
      for (const el of document.querySelectorAll('div, span')) {
        const t = (el.textContent || '').trim();
        if (/留下你的精彩评论|说点什么|善语结善缘/.test(t)) return true;
      }
      return false;
    });

    return { isModal: true, expanded: ok, iconPos: icon };
  }

  /**
   * 找评论输入框的位置。
   *
   * 实测要点（踩过的坑）：
   *   · 输入框的 class 不是 comment-input-inner-container（那个找不到）
   *   · 它是 Draft.js 的，**点击之前页面上没有任何 contenteditable**
   *   · 所以要先按「引导文字」定位这个框，点它，编辑器才会被创建
   *
   * 实测坐标：「留下你的精彩评论吧」那一行约 @ (564, 841)，宽约 800+
   */
  /**
   * 滚动评论区（不是滚页面）。
   *
   * 实测两种页面：
   *   · note 页：评论区是独立的窄栏（comment-mainContent，302x460），
   *     有自己的滚动条，滚页面没用。
   *   · video 页：评论区在页面里，滚页面即可。
   *
   * @param {number} times 滚几次（每次约 300px）
   * @returns {{ scrolled, containerCls, top }}
   */
  async scrollComments(times = 1) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let lastTop = -1;
    let containerCls = "";

    for (let i = 0; i < times; i++) {
      const r = await this.page.evaluate(() => {
        // 找可滚动的评论容器（选可滚距离最大的）
        let best = null;
        let bestDelta = 0;

        for (const el of document.querySelectorAll('div[class*="comment-mainContent"], div[class*="comment-list"], div[class*="commentContainer"]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 150 || rect.height < 100) continue;
          const delta = el.scrollHeight - el.clientHeight;
          if (delta < 30) continue;
          if (delta > bestDelta) { bestDelta = delta; best = el; }
        }

        if (best) {
          const before = Math.round(best.scrollTop);
          best.scrollTop += 320;
          return {
            ok: true,
            cls: (best.className || "").toString().slice(0, 50),
            before,
            after: Math.round(best.scrollTop),
            max: best.scrollHeight - best.clientHeight,
          };
        }

        // 退化：滚页面
        const pageBefore = window.scrollY;
        window.scrollBy(0, 400);
        return { ok: false, pageBefore, pageAfter: window.scrollY };
      });

      if (r.ok) {
        containerCls = r.cls;
        lastTop = r.after;
      } else {
        containerCls = "(页面滚动)";
        lastTop = r.pageAfter;
      }

      await sleep(1100);
    }

    return { scrolled: times, containerCls, top: lastTop };
  }

  async findCommentBox(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 滚到评论区
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);

      const box = await this.page.evaluate(() => {
        const vh = window.innerHeight;
        const cands = [];

        // ① 先看有没有已经存在的 Draft 编辑器（有时会提前渲染）
        for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 80 || r.height < 10) continue;
          if (r.top < 0 || r.bottom > vh) continue;
          cands.push({
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            from: 'existing-editor',
          });
        }

        // ② 按引导文字找（最可靠）
        //
        // 【过滤隐藏节点】实测这个文字在 DOM 里有 11 个副本，
        // 其中 6 个是 0x0 的幽灵节点（display:none 或未渲染）。
        // 必须同时满足：宽度够、高度够、在视口内、尺寸非零。
        for (const d of document.querySelectorAll('div, span')) {
          const t = (d.textContent || '').trim();
          if (t !== '留下你的精彩评论吧' && t !== '说点什么...') continue;
          const r = d.getBoundingClientRect();
          // 明确排除隐藏节点
          if (r.width <= 80 || r.height <= 20) continue;
          if (r.width > 900) continue;                 // 太大的外层容器
          if (r.top < 0 || r.bottom > vh) continue;
          if (r.top + r.height <= 0) continue;
          cands.push({
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            from: 'placeholder-text',
          });
        }

        // ③ 兜底：找评论区里最像输入框的容器
        if (!cands.length) {
          for (const el of document.querySelectorAll('div[class*="comment"], div[class*="Comment"]')) {
            const r = el.getBoundingClientRect();
            if (r.width < 300 || r.height < 20 || r.height > 80) continue;
            if (r.top < 0 || r.bottom > vh) continue;
            const t = (el.innerText || '').trim();
            if (t) continue;                       // 空盒子才可能是输入区
            cands.push({
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              w: Math.round(r.width),
              from: 'empty-container',
            });
          }
        }

        // 优先选宽的（输入框通常很宽）
        cands.sort((a, b) => b.w - a.w);
        return cands[0] || null;
      });

      if (box) return box;
      await sleep(1200);
    }
    return null;
  }

  /**
   * 点开编辑器并拿位置。
   * Draft.js 的行为：点空白区 → 创建 .public-DraftEditor-content。
   */
  async openEditorAndGet() {
    // 【先展开评论区面板】
    // 自己的作品是 modal 模式（/user/self?modal_id=xxx），评论区默认收起，
    // 必须先点右侧评论图标，否则永远找不到输入框。
    const panel = await this.ensureCommentPanel();
    if (panel.isModal && !panel.expanded) {
      return {
        ok: false,
        error: '这是自己作品的弹窗页，评论区没能展开' + (panel.error ? '：' + panel.error : ''),
        panel,
      };
    }

    const box = await this.findCommentBox();
    if (!box) {
      return { ok: false, error: '找不到评论输入框（页面可能没加载完，或需要登录）' };
    }

    // 点它
    await this.page.mouse.click(box.x, box.y);
    await sleep(2000);

    // 等 Draft 编辑器出现（最多 8 秒）
    for (let i = 0; i < 8; i++) {
      const ed = await this.page.evaluate(() => {
        const vh = window.innerHeight;
        const cands = [];
        for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 60 || r.height < 10) continue;
          if (r.top < 0 || r.bottom > vh) continue;
          cands.push({
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            cls: (el.className || '').toString().slice(0, 50),
          });
        }
        cands.sort((a, b) => b.w - a.w);
        return cands[0] || null;
      });
      if (ed) return { ok: true, editor: ed, box };
      await sleep(1000);
    }

    return {
      ok: false,
      error: '点了输入框但 Draft 编辑器没出现（可能被弹窗挡住，或需要登录）',
      box,
    };
  }

  /** 点开评论框，拿到真正的编辑器位置 */
  async openEditor(box) {
    await this.page.mouse.click(box.x, box.y);
    await sleep(2000);

    // 点开后再找 contenteditable
    const editor = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 12) continue;
        return {
          cls: (el.className || '').toString().slice(0, 60),
          x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      }
      return null;
    });
    return editor;
  }

  /**
   * 发一条评论。
   * @param {string} text 评论内容
   * @param {object} opts { dryRun: 只输入不发送, atNames: 要 @ 的昵称数组 }
   */
  async post(text, { dryRun = false, atNames = [] } = {}) {
    // 用新逻辑：定位 → 点击 → 等 Draft.js 创建编辑器
    const opened = await this.openEditorAndGet();
    if (!opened.ok) throw new Error(opened.error);

    // 再点一次编辑器内部，确保光标在正确位置
    await this.page.mouse.click(opened.editor.x, opened.editor.y);
    await new Promise((r) => setTimeout(r, 800));

    const atResults = [];

    // @ 好友：输入 @ 触发候选 → 打名字过滤 → ↓ 选中 → Enter 确认。
    // 不能用 DOM click：抖音是 React，合成事件不生效，只有键盘事件能触发它。
    for (const name of atNames) {
      try {
        await this.page.keyboard.type('@', { delay: 120 });
        await new Promise((r) => setTimeout(r, 2200));
        await this.page.keyboard.type(String(name), { delay: 90 });
        await new Promise((r) => setTimeout(r, 1800));
        await this.page.keyboard.press('ArrowDown');
        await new Promise((r) => setTimeout(r, 600));
        await this.page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 1500));

        const inserted = await this.page.evaluate(() => {
          for (const el of document.querySelectorAll('[contenteditable="true"]')) {
            const t = (el.innerText || '').trim();
            if (t) return t;
          }
          return '';
        });
        const ok = inserted.includes(name);
        atResults.push({ name, ok, editor: inserted.slice(0, 60) });

        if (!ok) {
          for (let i = 0; i < name.length + 1; i++) {
            await this.page.keyboard.press('Backspace');
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        atResults.push({ name, ok: false, reason: String(e?.message ?? e).slice(0, 60) });
      }
    }

    await this.page.keyboard.type(String(text), { delay: 55 });
    await new Promise((r) => setTimeout(r, 1500));

    const typed = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });
    if (!typed) throw new Error('文字没能输入到编辑器');

    if (dryRun) return { sent: false, dryRun: true, typed, atResults };

    // 【找发送按钮】两种页面结构都要覆盖
    //
    // 实测结论：
    //   · video 页：编辑器在左侧（宽 ~690），右边紧跟三个 36x36 无背景图标
    //     依次是 @ / 表情 / 发送，**最右边那个是发送**
    //   · note 页：发送按钮是输入框右下角的**红色圆形**
    //
    // 所以先找红色圆（note），找不到再找右排最右图标（video）。
    const sendBtn = await this.page.evaluate(() => {
      const vh = window.innerHeight;

      // 找编辑器
      let ed = null;
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 80) { ed = r; break; }
      }
      if (!ed) return { error: '无编辑器' };

      const edCenterY = ed.y + ed.height / 2;

      // ── 策略 0：官方语义化 class（最可靠） ──
      //
      // 实测踩过的坑：页面上有**两个** commentInput-right-ct，
      // 第一个是 0x0 的幽灵节点，用 querySelector 会拿到它 → 找不到按钮。
      //
      // 真节点：108x36，内含三个 36px 图标：
      //   x=1252 op=0.44  ← @（禁用态，没东西可@）
      //   x=1288 op=0.44  ← 表情（禁用态）
      //   x=1324 op=1.00  ← 发送（可用，不透明）
      //
      // 所以：遍历所有容器 → 选尺寸有效的 → 里面按 opacity 找可用的 → 取最右。
      // 遍历所有 commentInput-right-ct，跳过 0x0 的幽灵节点
      const containers = [];
      for (const el of document.querySelectorAll('[class*="commentInput-right-ct"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) containers.push({ el, r });
      }

      if (containers.length) {
        // 选最大的那个（最外层有效容器）
        containers.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
        const { el: container, r: cr } = containers[0];

        // 收集容器内 28-48px 的图标
        const icons = [];
        for (const icon of container.querySelectorAll('div, span, svg, button')) {
          const r = icon.getBoundingClientRect();
          if (r.width < 28 || r.width > 48) continue;
          if (r.height < 28 || r.height > 48) continue;
          const cs = getComputedStyle(icon);
          icons.push({
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            cx: r.x + r.width / 2,
            op: parseFloat(cs.opacity || '1'),
            cursor: cs.cursor,
            w: Math.round(r.width),
          });
        }

        if (icons.length) {
          // 优先选不透明的（op >= 0.9）且可点的
          const usable = icons.filter((i) => i.op >= 0.9 && i.cursor === 'pointer');
          const pool = usable.length ? usable : icons;
          // 去重（svg 和 span 叠在一起）
          const uniq = [];
          for (const i of pool) {
            if (uniq.some((u) => Math.abs(u.cx - i.cx) < 8)) continue;
            uniq.push(i);
          }
          // 最右那个 = 发送
          uniq.sort((a, b) => b.cx - a.cx);
          return {
            x: uniq[0].x,
            y: uniq[0].y,
            via: 'commentInput-right-ct',
            iconCount: uniq.length,
            allOp: uniq.map((u) => u.op),
          };
        }
      }

      // ── 策略 A：红色圆形（note 页用） ──
      const reds = [];
      for (const el of document.querySelectorAll('div, span, button, [role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 22 || r.width > 60) continue;
        if (r.height < 22 || r.height > 60) continue;
        if (r.top < 0 || r.bottom > vh) continue;

        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        // 在编辑器右侧或下方
        if (cx < ed.x + ed.width * 0.4) continue;
        if (Math.abs(cy - edCenterY) > 100) continue;

        const bg = getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) continue;
        const [_, R, G, B] = m.map(Number);
        if (!(R > 140 && R > G + 50 && R > B + 40)) continue;

        reds.push({ x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), bg, area: r.width * r.height });
      }
      if (reds.length) {
        reds.sort((a, b) => b.area - a.area);
        return { ...reds[0], via: 'red-circle' };
      }

      // ── 策略 B：视频页：编辑器右侧那排图标里最右的一个 ──
      //
      // 实测：三个 36x36 图标在 x = ed.right + 38 / +74 / +110，
      // y 与编辑器中心齐平（±10px）
      const icons = [];
      for (const el of document.querySelectorAll('span, svg, div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 26 || r.width > 48) continue;
        if (r.height < 26 || r.height > 48) continue;
        if (r.top < 0 || r.bottom > vh) continue;

        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;

        // 必须在编辑器右侧
        if (cx < ed.x + ed.width) continue;
        // 与编辑器中心纵向对齐（±30px）
        if (Math.abs(cy - edCenterY) > 30) continue;
        // 不能太远（不超过编辑器右边 +200）
        if (cx > ed.x + ed.width + 220) continue;

        icons.push({ x: Math.round(cx), y: Math.round(cy), cx, w: Math.round(r.width) });
      }
      if (icons.length) {
        // 去重（同一个图标的 span 和 svg 叠在一起）
        const uniq = [];
        for (const i of icons) {
          if (uniq.some((u) => Math.abs(u.cx - i.cx) < 8)) continue;
          uniq.push(i);
        }
        // 最右边那个就是发送
        uniq.sort((a, b) => b.cx - a.cx);
        return { x: uniq[0].x, y: uniq[0].y, via: 'rightmost-icon', count: uniq.length };
      }

      return { error: '找不到发送按钮（红圆和右排图标都没匹配到）' };
    });

    if (sendBtn.error) throw new Error(sendBtn.error);
    console.log('[send] 用', sendBtn.via, '定位:', JSON.stringify(sendBtn));

    // 【发送】用 Playwright 真实点击
    //
    // 实测：note 页发送按钮在编辑器右侧 (1324, 839)，是三个图标里最右的。
    // 但 mouse.click 无效 —— 可能因为：
    //   · 点在了 SVG 上，事件没冒泡到可点父元素
    //   · React 需要完整的事件序列（mousedown → mouseup → click）
    //   · 编辑器失焦后按钮变成不可用
    //
    // 所以这里：① 确保编辑器有焦点 ② 用 locator 真实点击 ③ 验证并兜底

    // 先让编辑器重新获得焦点
    try {
      await this.page.mouse.click(ed.x + 40, ed.y + ed.height / 2);
      await new Promise((r) => setTimeout(r, 600));
    } catch {}

    let sent = false;
    let sendVia = sendBtn.via;

    // 方式 1：用 locator 点那个坐标处的元素
    try {
      const el = this.page.locator('span[class*="wchsYBpK"], span[class*="jfGCpJo0"]').last();
      if (await el.count() > 0) {
        await el.click({ timeout: 5000, force: true });
        await new Promise((r) => setTimeout(r, 2500));
        sendVia = 'locator-force';
      }
    } catch {}

    // 检查是否发出
    const check1 = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });
    sent = check1 === '';

    // 方式 2：原始坐标点击（用完整事件序列）
    if (!sent) {
      try {
        await this.page.mouse.move(sendBtn.x, sendBtn.y);
        await new Promise((r) => setTimeout(r, 200));
        await this.page.mouse.down();
        await new Promise((r) => setTimeout(r, 80));
        await this.page.mouse.up();
        await new Promise((r) => setTimeout(r, 2500));
        sendVia = 'mouse-sequence';
      } catch {}
    }

    const check2 = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });
    sent = check2 === '';

    // 方式 3：键盘 Enter（有些输入框支持）
    if (!sent) {
      try {
        await this.page.keyboard.press('Enter');
        await new Promise((r) => setTimeout(r, 2500));
        sendVia = 'enter-key';
      } catch {}
    }

    const afterClear = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });

    return { sent: afterClear === '', dryRun: false, typed, afterClear, sendVia, sendBtnPos: { x: sendBtn.x, y: sendBtn.y }, atResults };
  }

  /**

    // 【找发送按钮】两种页面结构都要覆盖
    //
    // 实测结论：
    //   · video 页：编辑器在左侧（宽 ~690），右边紧跟三个 36x36 无背景图标
    //     依次是 @ / 表情 / 发送，**最右边那个是发送**
    //   · note 页：发送按钮是输入框右下角的**红色圆形**
    //
    // 所以先找红色圆（note），找不到再找右排最右图标（video）。
    const sendBtn = await this.page.evaluate(() => {
      const vh = window.innerHeight;

      // 找编辑器
      let ed = null;
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 80) { ed = r; break; }
      }
      if (!ed) return { error: '无编辑器' };

      const edCenterY = ed.y + ed.height / 2;

      // ── 策略 0：官方语义化 class（最可靠） ──
      //
      // 实测 note 页输入框右侧容器：class 里带 "commentInput-right-ct"，
      // 内含 @ / 表情 / 发送 三个 36x36 图标，**最右边那个是发送**。
      // 这是官方命名，比坐标和颜色判断都稳。
      const rightCt = document.querySelector('[class*="commentInput-right-ct"]');
      if (rightCt) {
        const rr = rightCt.getBoundingClientRect();
        if (rr.width > 40 && rr.height > 20) {
          // 容器里所有 30-44px 的图标
          const icons = [];
          for (const icon of rightCt.querySelectorAll('div, span, svg, button')) {
            const r = icon.getBoundingClientRect();
            if (r.width < 28 || r.width > 48) continue;
            if (r.height < 28 || r.height > 48) continue;
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            // 只取不透明且可点的（发送按钮输入文字后是 op=1 + pointer）
            const cs = getComputedStyle(icon);
            icons.push({
              x: Math.round(cx), y: Math.round(cy), cx,
              op: parseFloat(cs.opacity || '1'),
              cursor: cs.cursor,
            });
          }
          if (icons.length) {
            // 优先取「不透明 + pointer」的，再取最右的
            const usable = icons.filter((i) => i.op > 0.7 && i.cursor === 'pointer');
            const pool = usable.length ? usable : icons;
            pool.sort((a, b) => b.cx - a.cx);
            return { x: pool[0].x, y: pool[0].y, via: 'commentInput-right-ct', count: icons.length };
          }
        }
      }

      // ── 策略 A：红色圆形（note 页用） ──
      const reds = [];
      for (const el of document.querySelectorAll('div, span, button, [role="button"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 22 || r.width > 60) continue;
        if (r.height < 22 || r.height > 60) continue;
        if (r.top < 0 || r.bottom > vh) continue;

        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        // 在编辑器右侧或下方
        if (cx < ed.x + ed.width * 0.4) continue;
        if (Math.abs(cy - edCenterY) > 100) continue;

        const bg = getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) continue;
        const [_, R, G, B] = m.map(Number);
        if (!(R > 140 && R > G + 50 && R > B + 40)) continue;

        reds.push({ x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), bg, area: r.width * r.height });
      }
      if (reds.length) {
        reds.sort((a, b) => b.area - a.area);
        return { ...reds[0], via: 'red-circle' };
      }

      // ── 策略 B：视频页：编辑器右侧那排图标里最右的一个 ──
      //
      // 实测：三个 36x36 图标在 x = ed.right + 38 / +74 / +110，
      // y 与编辑器中心齐平（±10px）
      const icons = [];
      for (const el of document.querySelectorAll('span, svg, div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 26 || r.width > 48) continue;
        if (r.height < 26 || r.height > 48) continue;
        if (r.top < 0 || r.bottom > vh) continue;

        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;

        // 必须在编辑器右侧
        if (cx < ed.x + ed.width) continue;
        // 与编辑器中心纵向对齐（±30px）
        if (Math.abs(cy - edCenterY) > 30) continue;
        // 不能太远（不超过编辑器右边 +200）
        if (cx > ed.x + ed.width + 220) continue;

        icons.push({ x: Math.round(cx), y: Math.round(cy), cx, w: Math.round(r.width) });
      }
      if (icons.length) {
        // 去重（同一个图标的 span 和 svg 叠在一起）
        const uniq = [];
        for (const i of icons) {
          if (uniq.some((u) => Math.abs(u.cx - i.cx) < 8)) continue;
          uniq.push(i);
        }
        // 最右边那个就是发送
        uniq.sort((a, b) => b.cx - a.cx);
        return { x: uniq[0].x, y: uniq[0].y, via: 'rightmost-icon', count: uniq.length };
      }

      return { error: '找不到发送按钮（红圆和右排图标都没匹配到）' };
    });

    if (sendBtn.error) throw new Error(sendBtn.error);
    console.log('[send] 用', sendBtn.via, '定位:', JSON.stringify(sendBtn));

    await this.page.mouse.click(sendBtn.x, sendBtn.y);
    await new Promise((r) => setTimeout(r, 3000));

    // 验证：编辑器清空了 = 发成功
    const afterClear = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });

    return { sent: afterClear === '', dryRun: false, typed, afterClear, sendVia: sendBtn.via, atResults };
  }

  /**

    await this.page.mouse.click(sendBtn.x, sendBtn.y);
    await new Promise((r) => setTimeout(r, 3000));

    const afterClear = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });

    return { sent: afterClear === '', dryRun: false, typed, afterClear, atResults };
  }

  /**
   * 读视频下的评论，按抖音官方 class 结构精确解析。
   *
   * 实测可用的 class（不要用坐标猜，会抓到「0 分享 回复」这种垃圾）：
   *   comment-item-info-wrap        评论者信息区（昵称/时间/地区）
   *   comment-item-stats-container  操作栏（含「回复」按钮）
   *   comment-item-avatar           头像
   *   comment-item-tag-text         标签（作者 / 作者回复过）
   *
   * @returns {{ comments: Array<{nick, text, time, region, isAuthor, replyX, replyY}>, count }}
   */
  /**
   * 读视频下的评论，按实测的真实 DOM 结构精确解析。
   *
   * 实测结构（一条评论）：
   *   条目容器
   *     ├─ .comment-item-avatar            头像
   *     └─ 内容区
   *        ├─ .comment-item-info-wrap      昵称（★ 里面还藏着「...」更多按钮，要排除）
   *        ├─ 下一个兄弟                    ★ 评论正文（class 随机，靠兄弟关系定位）
   *        ├─ 再下一个兄弟                  ★ 时间·地区（形如「1周前·福建」）
   *        └─ .comment-item-stats-container 操作栏（赞/分享/回复）
   *
   * 关键：正文的 class 是随机串，不能按 class 找；只能「info-wrap 的下一个兄弟」。
   */
  async listCommentTargets({ limit = 20 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 滚到评论区
    for (let i = 0; i < 4; i++) {
      await this.page.mouse.wheel(0, 450);
      await sleep(900);
    }
    await sleep(2000);

    const data = await this.page.evaluate((maxCount) => {
      const out = { comments: [], count: 0, via: "dom-structure" };

      // 【选最大】comment-mainContent 也可能有幽灵节点
      //
      // 实测 note 页：有两个 comment-mainContent，
      // querySelector 拿到的是 0x0 那个 → 解析出 0 条评论。
      // 真正的那个是 302x460（右侧窄栏）。
      let mc = null;
      let mcArea = 0;
      for (const el of document.querySelectorAll('[class*="comment-mainContent"]')) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > mcArea) { mcArea = a; mc = el; }
      }
      if (!mc || mcArea < 100) return out;

      const isTimeRegion = (s) => /\d+\s*(分钟|小时|天|周|月|年)前|昨天|前天|刚刚|·/.test(s);
      // 【强化】操作栏特征 —— 这些绝不能当正文
      //
      // 实测被抓到过：「0 分享 回复」「2.4万 分享 回复」
      // 规则：
      //   · 纯操作词（赞/回复/分享/展开...）
      //   · 纯数字（可能是赞数）
      //   · 「数字 分享 回复」这种组合（操作栏完整文本）
      //   · 只有「分享 回复」两三个词
      const isJunk = (s) => {
        if (!s) return true;
        const t = s.trim();
        // 纯操作词
        if (/^(赞|回复|分享|展开|收起|\.\.\.|·|作者|置顶|作者回复过)$/.test(t)) return true;
        // 纯数字 / 数字+万
        if (/^\d+(\.\d+)?[万wW]?$/.test(t)) return true;
        // 【关键】「数字 分享 回复」或「分享 回复」这类操作栏
        if (/^[\d\.万wW\s]*(分享)?[\s]*(回复)?$/.test(t) && /分享|回复/.test(t)) return true;
        // 只有操作词组成（3 个词以内全是操作词）
        const words = t.split(/\s+/);
        if (words.length <= 3 && words.every((w) => /^(赞|回复|分享|展开|收起|·|\d+(\.\d+)?[万wW]?)$/.test(w))) return true;
        return false;
      };

      // 遍历 mc 的直接子元素（每条评论一个）
      for (const item of mc.children) {
        const ir = item.getBoundingClientRect();
        if (ir.height < 40) continue;

        // ── 昵称：.comment-item-info-wrap 里的纯文字 ──
        const infoWrap = item.querySelector('[class*="comment-item-info-wrap"]');
        if (!infoWrap) continue;                  // 没有昵称区，不是评论条目

        let nick = "";
        // info-wrap 里逐层找「有自身文本、且不是 ...」的节点
        const walkText = (node) => {
          for (const child of node.children) {
            const cls = (child.className || "").toString();
            // 跳过「更多」按钮
            if (/fBKZfpyn|d1ZggioA/.test(cls)) continue;
            // 取自身文本
            let own = "";
            for (const n of child.childNodes) {
              if (n.nodeType === 3) own += n.textContent;
            }
            own = own.replace(/\s+/g, " ").trim();
            if (own && own !== "..." && own.length <= 30 && !isJunk(own) && !isTimeRegion(own)) {
              nick = own;
              return true;
            }
            if (walkText(child)) return true;
          }
          return false;
        };
        if (!walkText(infoWrap)) continue;

        // ── 正文：info-wrap 的下一个兄弟 ──
        let text = "";
        let timeRegion = "";
        let sib = infoWrap.nextElementSibling;

        // 往后最多看 3 个兄弟
        let guard = 0;
        while (sib && guard < 4) {
          const st = (sib.innerText || "").replace(/\s+/g, " ").trim();
          const sr = sib.getBoundingClientRect();

          if (!text && st && st.length >= 2 && !isJunk(st) && !isTimeRegion(st) && sr.height > 10) {
            // 这就是正文
            text = st;
          } else if (!text && st && isJunk(st)) {
            // 【关键】候选是操作栏 —— 跳过，继续往后找（不要接受）
            // 这类评论可能只有 emoji 或图片，没文字正文，那就留给后面兜底
          } else if (text && !timeRegion && isTimeRegion(st)) {
            timeRegion = st;
            break;
          } else if (!text && isTimeRegion(st)) {
            // 有些短评论没有正文，只有一个时间（不太可能，但兜一下）
            timeRegion = st;
          }
          sib = sib.nextElementSibling;
          guard++;
        }

        // 正文兜底：如果上面没找到，试试 item 里含「内容 class」的（部分版本有语义 class）
        if (!text) {
          const contentEl = item.querySelector('[class*="content"]');
          if (contentEl) {
            const t = (contentEl.innerText || "").replace(/\s+/g, " ").trim();
            if (t && !isJunk(t) && !isTimeRegion(t)) text = t;
          }
        }

        // 最终校验：正文不能是操作栏样式
        if (!text || isJunk(text)) continue;
        // 正文太短且全是符号/数字也跳过（可能是 emoji-only 评论）
        if (text.length < 2) continue;

        // ── 时间 + 地区：从 timeRegion 里拆 ──
        let time = "", region = "";
        if (timeRegion) {
          const parts = timeRegion.split("·").map((s) => s.trim());
          time = parts[0] || "";
          region = parts[1] || "";
        }

        // ── 是否作者 ──
        const isAuthor = /\b作者\b/.test(item.innerText || "");

        // ── 回复按钮：.comment-item-stats-container 里文字为「回复」的 ──
        let replyX = 0, replyY = 0;
        const stats = item.querySelector('[class*="comment-item-stats-container"]');
        if (stats) {
          for (const el of stats.querySelectorAll("div, span")) {
            if ((el.textContent || "").trim() !== "回复") continue;
            const r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 8) continue;
            replyX = Math.round(r.x + r.width / 2);
            replyY = Math.round(r.y + r.height / 2);
            break;
          }
        }

        out.comments.push({
          nick: nick.slice(0, 30),
          text: text.slice(0, 200),
          time,
          region,
          isAuthor,
          replyX,
          replyY,
          y: Math.round(ir.y + ir.height / 2),
        });

        if (out.comments.length >= maxCount) break;
      }

      out.count = out.comments.length;
      return out;
    }, limit);


    // 如果条数不够 limit，再多滚几轮补充
    if (data.comments.length < limit) {
      const seen = new Set(data.comments.map((c) => c.nick + "|" + c.text.slice(0, 20)));
      let rounds = 0;

      while (data.comments.length < limit && rounds < 6) {
        rounds++;
        await this.scrollComments(1);

        const more = await this.page.evaluate((maxCount) => {
          const out = [];
          let mc = null, area = 0;
          for (const el of document.querySelectorAll('[class*="comment-mainContent"]')) {
            const r = el.getBoundingClientRect();
            if (r.width * r.height > area) { area = r.width * r.height; mc = el; }
          }
          if (!mc) return out;

          const isJunk2 = (s) => {
            const t = (s || "").trim();
            if (!t) return true;
            if (/^(赞|回复|分享|展开|收起|\.\.\.|·|作者|置顶)$/.test(t)) return true;
            if (/^\d+(\.\d+)?[万wW]?$/.test(t)) return true;
            if (/^[\d\.万wW\s]*(分享)?[\s]*(回复)?$/.test(t) && /分享|回复/.test(t)) return true;
            return false;
          };

          for (const item of mc.children) {
            const ir = item.getBoundingClientRect();
            if (ir.height < 40) continue;
            const infoWrap = item.querySelector('[class*="comment-item-info-wrap"]');
            if (!infoWrap) continue;

            let nick = "";
            const walkText = (node) => {
              for (const child of node.children) {
                const cls = (child.className || "").toString();
                if (/fBKZfpyn|d1ZggioA/.test(cls)) continue;
                let own = "";
                for (const n of child.childNodes) if (n.nodeType === 3) own += n.textContent;
                own = own.replace(/\s+/g, " ").trim();
                if (own && own !== "..." && own.length <= 30 && !isJunk2(own)) { nick = own; return true; }
                if (walkText(child)) return true;
              }
              return false;
            };
            if (!walkText(infoWrap)) continue;

            let text = "";
            let sib = infoWrap.nextElementSibling;
            let g = 0;
            while (sib && g < 4) {
              const st = (sib.innerText || "").replace(/\s+/g, " ").trim();
              if (st && st.length >= 2 && !isJunk2(st) && !/前$|前·|·/.test(st)) {
                text = st;
                break;
              }
              sib = sib.nextElementSibling;
              g++;
            }
            if (!text) continue;

            let replyX = 0, replyY = 0;
            const stats = item.querySelector('[class*="comment-item-stats-container"]');
            if (stats) {
              for (const el of stats.querySelectorAll("div, span")) {
                if ((el.textContent || "").trim() !== "回复") continue;
                const r = el.getBoundingClientRect();
                if (r.width < 10) continue;
                replyX = Math.round(r.x + r.width / 2);
                replyY = Math.round(r.y + r.height / 2);
                break;
              }
            }
            out.push({ nick: nick.slice(0, 30), text: text.slice(0, 200), replyX, replyY, y: Math.round(ir.y + ir.height / 2) });
          }
          return out.slice(0, maxCount);
        }, limit);

        for (const c of more) {
          const key = c.nick + "|" + c.text.slice(0, 20);
          if (seen.has(key)) continue;
          seen.add(key);
          data.comments.push({ time: "", region: "", isAuthor: false, ...c });
          if (data.comments.length >= limit) break;
        }
      }
      data.count = data.comments.length;
    }

    return data;
  }

  /**
   * 回复某条评论。
   * opts: { matchText, replyText, index, dryRun }
   */
  async replyToComment({ matchText, replyText, index = 0, dryRun = false } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (!replyText) throw new Error('缺少回复内容');

    const list = await this.listCommentTargets({ limit: 30 });
    if (!list.comments.length) {
      throw new Error('没找到可回复的评论（可能评论区未展开）');
    }

    let target = null;
    if (matchText) {
      target = list.comments.find((c) => c.text.includes(String(matchText)));
      if (!target) {
        const preview = list.comments.slice(0, 5).map((c) => '[' + c.text.slice(0, 20) + ']').join(' / ');
        throw new Error('没找到含该文字的评论。现有：' + preview);
      }
    } else {
      target = list.comments[Math.min(index, list.comments.length - 1)];
    }

    // 【滚动到目标评论】确保它在视口内再点
    //
    // 实测陷阱：回复按钮可能在 y=1115，而视口高度只有 1100 —— 点视口外无效。
    // 做法：先按昵称+内容找到那条评论的 DOM 节点，scrollIntoView，
    //      然后重新取「回复」按钮的坐标。
    const scrolled = await this.page.evaluate((t) => {
      let mc = null, mca = 0;
      for (const el of document.querySelectorAll('[class*="comment-mainContent"]')) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > mca) { mca = a; mc = el; }
      }
      if (!mc) return null;

      // 按昵称 + 内容前几个字找目标条目
      for (const item of mc.children) {
        const txt = (item.innerText || '').replace(/\s+/g, " ");
        if (!txt.includes(t.nick)) continue;
        if (!txt.includes(t.textSnippet)) continue;

        // 找到这条了，滚进来
        item.scrollIntoView({ block: "center", behavior: "instant" });

        return { found: true };
      }
      return null;
    }, { nick: target.nick, textSnippet: target.text.slice(0, 10) });

    await sleep(1500);

    // 滚动后重新定位「回复」按钮
    let clickX = target.replyX;
    let clickY = target.replyY;

    if (scrolled?.found) {
      const fresh = await this.page.evaluate((t) => {
        const mc = document.querySelector('[class*="comment-mainContent"]');
        if (!mc) return null;
        for (const item of mc.children) {
          const txt = (item.innerText || "").replace(/\s+/g, " ");
          if (!txt.includes(t.nick)) continue;
          if (!txt.includes(t.textSnippet)) continue;

          const stats = item.querySelector('[class*="comment-item-stats-container"]');
          if (!stats) return null;
          for (const el of stats.querySelectorAll("div, span")) {
            if ((el.textContent || "").trim() !== "回复") continue;
            const r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 8) continue;
            // 必须在视口内
            if (r.top < 0 || r.bottom > window.innerHeight) return { outOfView: true };
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return null;
      }, { nick: target.nick, textSnippet: target.text.slice(0, 10) });

      if (fresh?.x) {
        clickX = fresh.x;
        clickY = fresh.y;
        console.log("[reply] 滚动后重新定位回复按钮:", clickX, clickY);
      } else if (fresh?.outOfView) {
        // 还在视口外，再滚一次
        await this.page.mouse.wheel(0, 400);
        await sleep(1200);
      }
    }

    await this.page.mouse.click(clickX, clickY);
    await sleep(2500);

    // 【判定回复模式】页面出现「回复中」
    //
    // 实测：点「回复」后，那条评论的操作栏文字会从「0 分享 回复」变成「0 分享 回复中」。
    // 这是最可靠的「已进入回复模式」信号，比 placeholder 可靠
    // （实测 placeholder 是空的，靠它会误判成"没出现编辑器"）。
    let inReplyMode = false;
    for (let i = 0; i < 8; i++) {
      inReplyMode = await this.page.evaluate(() => /回复中/.test(document.body?.innerText || ''));
      if (inReplyMode) break;
      await sleep(700);
    }

    // 编辑器检测：任何可见的 Draft 编辑器都算（不依赖 placeholder）
    const editor = await this.page.evaluate(() => {
      const vh = window.innerHeight;
      const cands = [];

      for (const el of document.querySelectorAll('.public-DraftEditor-content, [contenteditable="true"], textarea')) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) continue;
        if (r.top < 0 || r.bottom > vh) continue;

        const txt = (el.innerText || el.value || '').trim();
        cands.push({
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          isEmpty: !txt,
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }

      if (!cands.length) return null;
      // 优先空的
      const empty = cands.find((c) => c.isEmpty);
      return empty || cands[0];
    });

    // 既没进回复模式，也没有编辑器 → 真的失败了
    if (!editor && !inReplyMode) {
      return { ok: false, error: '点了回复但没出现编辑器' };
    }

    if (!editor) {
      // 进了回复模式但没找到编辑器 —— 用底部主评论框兜底（抖音有时复用它）
      return { ok: false, error: '进入了回复模式，但没定位到输入框' };
    }

    await this.page.mouse.click(editor.x, editor.y);
    await sleep(900);
    await this.page.keyboard.type(String(replyText), { delay: 55 });
    await sleep(1300);

    const typed = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });

    if (!typed) throw new Error('文字没能输入到回复框');

    if (dryRun) return { sent: false, dryRun: true, target: target.text, typed };

    await this.page.keyboard.press('Enter');
    await sleep(2800);

    const after = await this.page.evaluate(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        const t = (el.innerText || '').trim();
        if (t) return t;
      }
      return '';
    });

    return {
      sent: after === '',
      target: target.text.slice(0, 60),
      typed,
      editorAt: editor,
    };
  }

}

export default DouyinComment;

// 直接运行：自测
if (process.argv[1] && process.argv[1].endsWith('douyin-comment.mjs')) {
  const { DouyinBot } = await import('./douyin-core.mjs');
  const { DouyinReader } = await import('./douyin-reader.mjs');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    try { fs.rmSync(path.join(BASE, 'edgedata', f), { force: true }); } catch {}
  }
  const bot = await new DouyinBot({ headless: false }).start();
  const reader = new DouyinReader(bot.page);
  const cm = new DouyinComment(bot.page);
  try {
    const feed = await reader.feed({ count: 5 });
    const t = feed.find(v => v.comment > 50) || feed[0];
    console.log('目标:', t.id, '| 评论', t.comment);
    await bot.page.goto(`https://www.douyin.com/video/${t.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const r = await cm.post(process.env.CMT_TEXT || '这个真的学到了', {
      dryRun: process.env.CMT_DRY === '1',
      atNames: process.env.CMT_AT ? process.env.CMT_AT.split(',') : [],
    });
    console.log(JSON.stringify(r, null, 2));
    await bot.page.screenshot({ path: path.join(BASE, 'comment-final.png') }).catch(() => {});
  } catch (e) {
    console.error('失败:', e?.message);
  } finally {
    await sleep(4000);
    await bot.close();
  }
}
