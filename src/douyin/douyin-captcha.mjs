import fs from 'node:fs';
import path from 'node:path';

// 抖音操作时检测验证码/风控，并把控制权交回给本人。
//
// 需求原话：「遇到抖音要求发验证码，不要取消，让 qq 告诉我，我来进行验证」
//
// 设计要点：
//   1. 检测到验证码 → 不关闭浏览器、不重试，把窗口留着让本人手动处理
//   2. 通过 OneBot 私信通知 ownerQQ（从 config.json 读，通常是主人 QQ）
//   3. 抛出一个带明确标记的错误，让上层 MCP 工具如实回报「需要你验证」
//
// 抖音出现的验证形式：
//   - 滑块验证（"请完成下列验证后继续"）
//   - 图形验证码（"请输入验证码"）
//   - 人脸/实名验证
//   - 简单算术验证
// 共同特征：页面上出现特定关键词 + 弹层。

const QQ_BRIDGE_CONFIG = 'D:\\Users\\未开封的汽水\\Documents\\Downloads\\新建文件夹\\qq-bridge\\config.json';

/** 读 ownerQQ 与 OneBot 配置 */
function loadQqConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(QQ_BRIDGE_CONFIG, 'utf8'));
    return {
      owner: Number(cfg.ownerQQ) || 0,
      httpUrl: cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000',
      token: cfg.snowluma?.accessToken || '',
    };
  } catch {
    return { owner: 0, httpUrl: 'http://127.0.0.1:3000', token: '' };
  }
}

/** 直接走 OneBot 给 owner 发一条私信 */
export async function notifyOwner(message) {
  const { owner, httpUrl, token } = loadQqConfig();
  try {
    const res = await fetch(`${httpUrl}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ user_id: owner, message }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok && json?.status === 'ok', owner, raw: json ?? text.slice(0, 200) };
  } catch (e) {
    return { ok: false, owner, error: String(e?.message ?? e) };
  }
}

/** 页面上的验证码关键词 */
const CAPTCHA_PATTERNS = [
  { re: /请完成下列验证|完成验证后继续|拖动滑块|向右滑动/, kind: '滑块验证' },
  { re: /请输入验证码|输入验证码|验证码已发送/, kind: '短信/图形验证码' },
  { re: /请进行人脸验证|实名认证|身份验证/, kind: '实名/人脸验证' },
  { re: /操作过于频繁|请稍后再试|安全验证|异常行为/, kind: '风控拦截' },
  { re: /请先登录|登录后.*继续|扫码登录/, kind: '需要登录' },
];

/**
 * 检测当前页面是否有验证码/风控。
 * @returns {Promise<null | {kind: string, matched: string, url: string}>}
 */
export async function detectCaptcha(page) {
  try {
    const info = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      // 只扫前 3000 字，验证提示通常在顶部弹层
      const head = body.slice(0, 3000);

      // 找弹层类元素（验证码一般是个模态框）
      const modals = [];
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 120) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        // 必须真的可见
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        // 居中弹层
        const cx = r.x + r.width / 2;
        if (Math.abs(cx - window.innerWidth / 2) > 200) continue;
        const t = (el.innerText || '').slice(0, 200);
        if (t) modals.push(t);
      }

      return {
        head,
        modals: modals.slice(0, 3),
        // 只认**可见**的验证 iframe。
        // 抖音首页一直挂着 id="nocaptcha-container" 的隐藏 iframe（0x0, visible=false），
        // 那是风控 SDK 的预加载容器，不代表真的在要求验证 —— 不加可见性判断会天天误报。
        hasIframe: (() => {
          for (const f of document.querySelectorAll('iframe')) {
            const r = f.getBoundingClientRect();
            if (r.width < 50 || r.height < 50) continue;
            const cs = getComputedStyle(f);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
            const src = (f.getAttribute('src') || '').toLowerCase();
            const id = (f.id || '').toLowerCase();
            if (/captcha|verify/.test(src) || /captcha/.test(id)) return true;
          }
          return false;
        })(),
        url: location.href,
      };
    });

    const haystack = [info.head, ...info.modals, info.url].join('\n');
    for (const p of CAPTCHA_PATTERNS) {
      const m = haystack.match(p.re);
      if (m) {
        return { kind: p.kind, matched: m[0], url: info.url, hasIframe: info.hasIframe };
      }
    }
    if (info.hasIframe) {
      return { kind: '验证码（iframe）', matched: 'captcha iframe', url: info.url, hasIframe: true };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 遇到验证码时的统一处理：通知 owner，然后抛出可识别的错误。
 *
 * 关键：**不关闭页面**。浏览器窗口要留着，让本人能直接操作。
 */
export async function handleCaptcha(page, { context = '抖音操作' } = {}) {
  const info = await detectCaptcha(page);
  if (!info) return null;   // 没有验证码，正常继续

  let url = '';
  try { url = page.url(); } catch {}

  const msg = [
    `【抖音需要验证】`,
    ``,
    `操作：${context}`,
    `类型：${info.kind}`,
    info.matched ? `提示：${info.matched}` : '',
    ``,
    `浏览器窗口已留着，请直接在窗口里完成验证。`,
    `验证完成后告诉我，我继续。`,
  ].filter(Boolean).join('\n');

  const sent = await notifyOwner(msg);

  const err = new Error(
    `需要人工验证（${info.kind}）。已通过 QQ 通知你${sent.ok ? '' : '（通知发送失败，请查看抖音窗口）'}，`
    + `请在弹出的浏览器窗口里完成验证后重试。`,
  );
  err.code = 'CAPTCHA_REQUIRED';
  err.captchaInfo = info;
  err.notified = sent.ok;
  throw err;
}

export default { detectCaptcha, handleCaptcha, notifyOwner };
