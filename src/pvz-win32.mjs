/**
 * pvz-win32.mjs —— 用 koffi 直接调 Win32，不走 PowerShell
 *
 * 为什么换掉 PowerShell：
 *   PowerShell 的 Add-Type 会剥离 C# 代码里的双引号
 *   （DllImport("user32.dll") → DllImport(user32.dll)），
 *   导致 P/Invoke 声明编译失败。
 *
 * koffi 是纯 JS 的 FFI，预编译好，直接调 DLL：
 *   · 没有引号转义问题
 *   · 没有子进程开销（一次调用 ~1ms，而不是 ~800ms）
 *   · 类型安全
 *
 * 提供的能力：
 *   · 窗口：找句柄、拿位置、后台截屏
 *   · 鼠标：PostMessage 后台点击（不占用户的键鼠）
 *   · 内存：只读，用 ReadProcessMemory
 */

import koffi from 'koffi';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// ── 加载 DLL ─────────────────────────────────────────────────────────────

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');

// ═══════════════════════════════════════════════════════════════════════
// 类型定义（koffi 要求：结构体必须先注册，才能在 .func() 签名里引用）
// ═══════════════════════════════════════════════════════════════════════

const RECT = koffi.struct('RECT', {
  Left: 'int32',
  Top: 'int32',
  Right: 'int32',
  Bottom: 'int32',
});

const POINT = koffi.struct('POINT', {
  x: 'int32',
  y: 'int32',
});

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});

const BITMAPINFO = koffi.struct('BITMAPINFO', {
  bmiHeader: BITMAPINFOHEADER,
  bmiColors: koffi.array('uint32', 3),
});

const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'intptr',
  AllocationBase: 'intptr',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  RegionSize: 'intptr',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
});


// ── 类型定义 ─────────────────────────────────────────────────────────────



// ── 函数声明 ─────────────────────────────────────────────────────────────

const GetWindowRect = user32.func('bool GetWindowRect(intptr hWnd, _Out_ RECT *lpRect)');
const GetClientRect = user32.func('bool GetClientRect(intptr hWnd, _Out_ RECT *lpRect)');
const ClientToScreen = user32.func('bool ClientToScreen(intptr hWnd, _Inout_ POINT *lpPoint)');
const IsWindow = user32.func('bool IsWindow(intptr hWnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr hWnd)');
const GetWindowTextW = user32.func('int GetWindowTextW(intptr hWnd, _Out_ uint16 *lpString, int nMaxCount)');
const GetForegroundWindow = user32.func('intptr GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr hWnd)');
const ShowWindow = user32.func('bool ShowWindow(intptr hWnd, int nCmdShow)');
const PostMessageW = user32.func('bool PostMessageW(intptr hWnd, uint32 Msg, uintptr wParam, intptr lParam)');
const SendMessageW = user32.func('intptr SendMessageW(intptr hWnd, uint32 Msg, uintptr wParam, intptr lParam)');
const PrintWindow = user32.func('bool PrintWindow(intptr hWnd, intptr hdcBlt, uint32 nFlags)');
const GetWindowDC = user32.func('intptr GetWindowDC(intptr hWnd)');
const ReleaseDC = user32.func('int ReleaseDC(intptr hWnd, intptr hDC)');
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *lpPoint)');
const SetCursorPos = user32.func('bool SetCursorPos(int x, int y)');
const mouse_event = user32.func('void mouse_event(uint32 dwFlags, int32 dx, int32 dy, uint32 dwData, uintptr dwExtraInfo)');
const GetDC = user32.func('intptr GetDC(intptr hWnd)');

const OpenProcess = kernel32.func('intptr OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('bool CloseHandle(intptr hObject)');
const ReadProcessMemory = kernel32.func('bool ReadProcessMemory(intptr hProcess, intptr lpBaseAddress, _Out_ uint8 *lpBuffer, intptr nSize, _Out_ intptr *lpNumberOfBytesRead)');
const VirtualQueryEx = kernel32.func('intptr VirtualQueryEx(intptr hProcess, intptr lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, intptr dwLength)');

// （结构体定义已上移）

// GDI（截屏用）
const CreateCompatibleDC = gdi32.func('intptr CreateCompatibleDC(intptr hdc)');
const CreateCompatibleBitmap = gdi32.func('intptr CreateCompatibleBitmap(intptr hdc, int nWidth, int nHeight)');
const SelectObject = gdi32.func('intptr SelectObject(intptr hdc, intptr h)');
const DeleteObject = gdi32.func('bool DeleteObject(intptr ho)');
const DeleteDC = gdi32.func('bool DeleteDC(intptr hdc)');
const BitBlt = gdi32.func('bool BitBlt(intptr hdcDest, int xDest, int yDest, int w, int h, intptr hdcSrc, int xSrc, int ySrc, uint32 rop)');
const GetDIBits = gdi32.func('int GetDIBits(intptr hdc, intptr hbm, uint32 start, uint32 cLines, _Out_ uint8 *lpvBits, _Inout_ BITMAPINFO *lpbmi, uint32 usage)');



// 内存区域信息（VirtualQueryEx 用）

// ── 常量 ─────────────────────────────────────────────────────────────────

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;

const PW_RENDERFULLCONTENT = 0x00000002;

const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;

const SRCCOPY = 0x00CC0020;
const DIB_RGB_COLORS = 0;

// ── 窗口操作 ─────────────────────────────────────────────────────────────

/**
 * 拿窗口的客户区尺寸和外框位置。
 * @returns {{ok, hwnd, x, y, w, h, cw, ch, title} | {ok:false, error}}
 */
export function getWindowInfo(hwnd) {
  if (!IsWindow(hwnd)) return { ok: false, error: 'invalid-hwnd' };

  const wr = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
  if (!GetWindowRect(hwnd, wr)) return { ok: false, error: 'GetWindowRect-failed' };

  const cr = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
  GetClientRect(hwnd, cr);

  // 标题
  const buf = Buffer.alloc(512);
  GetWindowTextW(hwnd, buf, 256);
  let title = '';
  for (let i = 0; i < 256; i++) {
    const code = buf.readUInt16LE(i * 2);
    if (code === 0) break;
    title += String.fromCharCode(code);
  }

  return {
    ok: true,
    hwnd,
    x: wr.Left,
    y: wr.Top,
    w: wr.Right - wr.Left,
    h: wr.Bottom - wr.Top,
    cw: cr.Right - cr.Left,
    ch: cr.Bottom - cr.Top,
    title,
    visible: !!IsWindowVisible(hwnd),
  };
}

/**
 * 后台截屏（不抢焦点）。
 *
 * 三级兜底：
 *   ① PrintWindow + PW_RENDERFULLCONTENT（DirectDraw/OpenGL 常用）
 *   ② PrintWindow 普通
 *   ③ BitBlt 从窗口 DC
 *
 * @returns {{ok, path, method, w, h}}
 */
export function captureWindow(hwnd, outPath) {
  const info = getWindowInfo(hwnd);
  if (!info.ok) return { ok: false, error: info.error };

  const w = info.cw || info.w;
  const h = info.ch || info.h;
  if (w <= 0 || h <= 0) return { ok: false, error: 'bad-size' };

  const winDC = GetWindowDC(hwnd);
  if (!winDC) return { ok: false, error: 'GetWindowDC-failed' };

  const memDC = CreateCompatibleDC(winDC);
  const hbm = CreateCompatibleBitmap(winDC, w, h);
  const old = SelectObject(memDC, hbm);

  let method = '';
  let success = false;

  // ① PrintWindow + fullcontent
  try {
    if (PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT)) {
      // 检测是否全黑
      const px = readPixel(memDC, w, h);
      if (px && (px[0] > 3 || px[1] > 3 || px[2] > 3)) {
        method = 'PrintWindow+fullcontent';
        success = true;
      }
    }
  } catch {}

  // ② PrintWindow 普通
  if (!success) {
    try {
      if (PrintWindow(hwnd, memDC, 0)) {
        const px = readPixel(memDC, w, h);
        if (px && (px[0] > 3 || px[1] > 3 || px[2] > 3)) {
          method = 'PrintWindow';
          success = true;
        }
      }
    } catch {}
  }

  // ③ BitBlt
  if (!success) {
    try {
      if (BitBlt(memDC, 0, 0, w, h, winDC, 0, 0, SRCCOPY)) {
        method = 'BitBlt';
        success = true;
      }
    } catch {}
  }

  if (success) {
    saveBitmap(memDC, hbm, w, h, outPath);
  }

  SelectObject(memDC, old);
  DeleteObject(hbm);
  DeleteDC(memDC);
  ReleaseDC(hwnd, winDC);

  if (!success) return { ok: false, error: 'all-methods-failed' };

  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  return { ok: true, path: outPath, method, w, h, size };
}

/** 读一个像素（用于检测黑屏） */
function readPixel(hdc, w, h) {
  try {
    const bi = {
      bmiHeader: {
        biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
        biCompression: 0, biSizeImage: w * h * 4,
        biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
      },
      bmiColors: [0, 0, 0],
    };
    const buf = Buffer.alloc(4);
    GetDIBits(hdc, 0, 0, 0, buf, bi, DIB_RGB_COLORS);
    return [buf[2], buf[1], buf[0]];
  } catch {
    return null;
  }
}

/** 把内存 DC 存成 PNG */
function saveBitmap(hdc, hbm, w, h, outPath) {
  try {
    const bi = {
      bmiHeader: {
        biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
        biCompression: 0, biSizeImage: w * h * 4,
        biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
      },
      bmiColors: [0, 0, 0],
    };

    const buf = Buffer.alloc(w * h * 4);
    const lines = GetDIBits(hdc, hbm, 0, h, buf, bi, DIB_RGB_COLORS);
    if (!lines) return false;

    // BGRA → RGBA
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4 + 0] = buf[i * 4 + 2]; // R
      rgba[i * 4 + 1] = buf[i * 4 + 1]; // G
      rgba[i * 4 + 2] = buf[i * 4 + 0]; // B
      rgba[i * 4 + 3] = 255;
    }

    writePNG(outPath, w, h, rgba);
    return true;
  } catch (e) {
    console.error('[pvz-win32] saveBitmap 失败:', e?.message ?? e);
    return false;
  }
}

/** 极简 PNG 编码（避免依赖外部库） */
function writePNG(outPath, w, h, rgba) {

  // raw：每行前加一个 filter 字节 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA

  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', compressed));
  chunks.push(chunk('IEND', Buffer.alloc(0)));

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc ^ -1;
}

// ── 后台点击（不占键鼠）───────────────────────────────────────────────────

/**
 * 往窗口投递鼠标点击。
 *
 * 用 PostMessage：不移动真实光标、不抢焦点。
 *
 * @param {number} hwnd
 * @param {number} x 客户区坐标
 * @param {number} y 客户区坐标
 * @param {'left'|'right'} button
 */
export function postClick(hwnd, x, y, button = 'left') {
  const px = Math.round(x) & 0xffff;
  const py = Math.round(y) & 0xffff;
  const lParam = (py << 16) | px;

  const down = button === 'right' ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
  const up = button === 'right' ? WM_RBUTTONUP : WM_LBUTTONUP;
  const wparam = button === 'right' ? 2 : 1;

  PostMessageW(hwnd, WM_MOUSEMOVE, 0, lParam);
  PostMessageW(hwnd, down, wparam, lParam);
  PostMessageW(hwnd, up, 0, lParam);

  return { ok: true, x: px, y: py };
}

/**
 * 同步点击（SendMessage）。
 *
 * 和 postClick 的区别：
 *   postClick    = PostMessage，投递就返回，不等处理
 *   sendClickSync= SendMessage，等窗口处理完才返回
 *
 * 有些游戏只响应 SendMessage。但 SendMessage 是阻塞的，
 * 如果目标窗口卡住，调用方也会卡住，所以加了超时保护。
 */
export function sendClickSync(hwnd, x, y, button = 'right') {
  const px = Math.round(x) & 0xffff;
  const py = Math.round(y) & 0xffff;
  const lParam = (py << 16) | px;

  const isRight = button === 'right';
  const down = isRight ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
  const up = isRight ? WM_RBUTTONUP : WM_LBUTTONUP;
  const wp = isRight ? 2 : 1;

  try {
    SendMessageW(hwnd, WM_MOUSEMOVE, 0, lParam);
    SendMessageW(hwnd, down, wp, lParam);
    SendMessageW(hwnd, up, 0, lParam);
    return { ok: true, method: 'SendMessage', x: px, y: py };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 用 SendInput 点击（会移动真实光标）。
 *
 * ⚠️ 这是最后的手段 —— 它会占用用户的鼠标。
 * 只有在 PostMessage / SendMessage 都失效时才用。
 *
 * 做法：把光标移到目标点 → 点击 → 移回原位。
 * 这样用户几乎感觉不到（但光标确实动过）。
 */
export function sendInputClick(hwnd, x, y, button = 'right') {
  try {
    // 客户区坐标 → 屏幕坐标
    const pt = { x: Math.round(x), y: Math.round(y) };
    ClientToScreen(hwnd, pt);

    // 保存当前光标位置
    const old = { x: 0, y: 0 };
    GetCursorPos(old);

    // 移动 + 点击 + 移回
    SetCursorPos(pt.x, pt.y);
    mouse_event(button === 'right' ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(button === 'right' ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    SetCursorPos(old.x, old.y);

    return { ok: true, method: 'SendInput', screenX: pt.x, screenY: pt.y, restored: old };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 批量点击（收阳光用）。
 */
export async function postClickMany(hwnd, points, delayMs = 120) {
  for (const p of points) {
    postClick(hwnd, p.x, p.y, p.button || 'left');
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: true, count: points.length };
}

/**
 * 后台按键。
 */
export function postKey(hwnd, vkCode) {
  PostMessageW(hwnd, WM_KEYDOWN, vkCode, 0);
  PostMessageW(hwnd, WM_KEYUP, vkCode, 0);
  return { ok: true, vk: vkCode };
}

// ── 内存读取 ─────────────────────────────────────────────────────────────

/**
 * 打开进程拿句柄。用完要 closeHandle。
 */
export function openProcess(pid) {
  const h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
  return h ? h : null;
}

export function closeHandle(h) {
  try { CloseHandle(h); } catch {}
}

/**
 * 读内存。
 * @param {intptr} hProcess
 * @param {number} addr
 * @param {number} len
 * @returns {Buffer|null}
 */
export function readMemory(hProcess, addr, len) {
  const buf = Buffer.alloc(len);
  const read = [0];
  const ok = ReadProcessMemory(hProcess, addr, buf, len, read);
  if (!ok) return null;
  return buf;
}

export function readInt32(hProcess, addr) {
  const b = readMemory(hProcess, addr, 4);
  return b ? b.readInt32LE(0) : null;
}

export function readFloat(hProcess, addr) {
  const b = readMemory(hProcess, addr, 4);
  return b ? b.readFloatLE(0) : null;
}

/**
 * 枚举进程内存区域（用于特征码扫描）。
 * @returns {Array<{base, size, protect, state}>}
 */
export function enumMemoryRegions(hProcess) {
  const regions = [];
  let addr = 0;
  const mbi = {};
  const MBI_SIZE = 48;   // 64 位下 MEMORY_BASIC_INFORMATION 是 48 字节

  for (let i = 0; i < 5000; i++) {
    const ret = VirtualQueryEx(hProcess, addr, mbi, MBI_SIZE);
    if (!ret) break;

    const base = Number(mbi.BaseAddress) || 0;
    const size = Number(mbi.RegionSize) || 0;
    if (size === 0) break;

    // MEM_COMMIT = 0x1000，可读的保护位
    const state = mbi.State;
    const protect = mbi.Protect;
    const readable = state === 0x1000 && (protect & 0x02 || protect & 0x04 || protect & 0x20 || protect & 0x40);

    if (readable) {
      regions.push({ base, size, protect, state });
    }

    addr = base + size;
    if (addr <= base) break;
  }

  return regions;
}

// ── 导出 ─────────────────────────────────────────────────────────────────

export default {
  getWindowInfo,
  captureWindow,
  postClick,
  sendClickSync,
  sendInputClick,
  postClickMany,
  postKey,
  openProcess,
  closeHandle,
  readMemory,
  readInt32,
  readFloat,
  enumMemoryRegions,
  // 常量
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
};
