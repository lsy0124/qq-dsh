/**
 * pvz-bridge.mjs — 植物大战僵尸 后台自动化桥
 *
 * 设计目标（按需求）：
 *   ① 认真玩（真实操作，不作弊改内存）
 *   ② 能学习（每局的决策可追溯、可复盘）
 *   ③ 不占用用户的键盘和鼠标
 *
 * 怎么做到不占用键鼠：
 *   不用 SendInput / mouse_event（那会移动真实光标、抢焦点）。
 *   改用 PostMessage 直接往游戏窗口投递 WM_LBUTTONDOWN/UP，
 *   窗口不需要在前台，光标一动不动。
 *
 * 怎么做到能看画面：
 *   用 PrintWindow 从窗口 DC 抓位图（不抢焦点）。
 *   注意：PVZ 是 DirectDraw 渲染，普通 PrintWindow 可能抓黑屏，
 *   需要 PW_RENDERFULLCONTENT(2) 标志；还不行就用 BitBlt 兜底。
 *
 * ⚠️ 仅用于本地单机游戏。不要用于联机游戏或任何有反作弊的环境。
 */

import { spawn, spawnSync } from 'node:child_process';

// ── Win32 API（通过 PowerShell 调用，避免原生编译）─────────────────────────

const PS_HELPERS = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PvzWin32 {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // 后台鼠标：不移动真实光标
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    // 后台截屏
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
}
"@

# 屏幕截图（兜底方案）
function Capture-Screen($x, $y, $w, $h, $outPath) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "ok"
}
`;

function runPS(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', PS_HELPERS + '\n' + script], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs);
    p.on('close', () => { clearTimeout(timer); resolve({ ok: true, out: out.trim(), err: err.trim() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
  });
}

// ── 窗口操作 ──────────────────────────────────────────────────────────────

/**
 * 枚举所有可见窗口，找出可能是游戏的。
 * @returns {Promise<Array<{hwnd, title, pid, rect}>>}
 */
export async function listWindows() {
  const r = await runPS(`
$script:found = New-Object System.Collections.ArrayList
$cb = [PvzWin32+EnumWindowsProc]{
    param($h, $l)
    try {
        if (-not [PvzWin32]::IsWindowVisible($h)) { return $true }
        $sb = New-Object System.Text.StringBuilder 256
        [void][PvzWin32]::GetWindowText($h, $sb, 256)
        $t = $sb.ToString()
        if ([string]::IsNullOrWhiteSpace($t)) { return $true }
        $rect = New-Object PvzWin32+RECT
        [void][PvzWin32]::GetWindowRect($h, [ref]$rect)
        $w = $rect.Right - $rect.Left
        $hh = $rect.Bottom - $rect.Top
        if ($w -lt 200 -or $hh -lt 150) { return $true }
        $procId = 0
        [void][PvzWin32]::GetWindowThreadProcessId($h, [ref]$procId)
        [void]$script:found.Add([pscustomobject]@{
            hwnd = $h.ToInt64(); title = $t; pid = $procId
            x = $rect.Left; y = $rect.Top; w = $w; h = $hh
        })
    } catch {}
    return $true
}
[void][PvzWin32]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found.Count -eq 0) { Write-Output "[]" }
else { $script:found | ConvertTo-Json -Compress }
`, 20000);

  if (!r.out) return [];
  try {
    const parsed = JSON.parse(r.out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * 按进程 ID 找窗口句柄。
 *
 * 只用 Process.MainWindowHandle —— 不需要任何 P/Invoke，
 * 所以不会被 PowerShell 的 Add-Type 引号剥离问题影响。
 *
 * 窗口位置和尺寸用 .NET 的 GetWindowRect 会失败（引号问题），
 * 改用 PowerShell 内置的窗口属性，或者截屏时用 GetClientRect 的替代方案。
 *
 * @param {number} pid
 * @returns {Promise<{hwnd, title, pid, w, h} | null>}
 */
export async function findWindowByPid(pid) {
  const r = await runPS(`
$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $target) { Write-Output "NONE"; exit }
$h = $target.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output "NONE"; exit }

# 用 System.Windows.Forms.Screen 的替代：直接读窗口标题判断非空
$t = $target.MainWindowTitle

# 尺寸：用 .NET 的 user32 封装 —— 这里改用 Add-Type 但引号用双引号转义
Write-Output ("HWND:" + $h.ToInt64() + ":" + $t)
`, 30000);

  const out = (r.out || '').trim();
  const m = out.match(/HWND:(d+):(.*)/s);
  if (!m) return null;

  return {
    hwnd: Number(m[1]),
    title: m[2] || '',
    pid,
    w: 0,
    h: 0,
  };
}

export async function findGameWindow(keyword = '植物大战僵尸') {
  // ① 先按进程 ID（最可靠，不受标题编码影响）
  try {
    const { findProcess } = await import('./pvz-memory.mjs');
    const proc = await findProcess();
    if (proc) {
      const byPid = await findWindowByPid(proc.pid);
      if (byPid) return byPid;
    }
  } catch {}

  // ② 退回标题匹配
  const wins = await listWindows();
  const kws = [keyword, 'Plants', 'PlantsVsZombies', '植物', 'PVZ'].filter(Boolean);
  for (const kw of kws) {
    const hit = wins.find((w) => (w.title || '').includes(kw));
    if (hit) return hit;
  }
  return null;
}

/**
 * 后台截屏。
 *
 * 三级兜底：
 *   ① PrintWindow + PW_RENDERFULLCONTENT（DirectDraw 常用）
 *   ② PrintWindow 无标志
 *   ③ 屏幕区域截图（需要窗口可见但不抢焦点）
 *
 * @returns {{ok, path, method, size}}
 */
export async function captureWindow(hwnd, outPath) {
  const r = await runPS(`
$hwnd = [IntPtr]${
  '${hwnd}'}
$out = '${outPath.replace(/\\/g, '\\\\')}'

$rect = New-Object PvzWin32+RECT
[void][PvzWin32]::GetClientRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output "err:bad-size"; exit }

$method = ""
$done = $false

# ① PW_RENDERFULLCONTENT (2)
try {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [PvzWin32]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if ($ok) {
        # 检测是否全黑
        $px = $bmp.GetPixel([int]($w/2), [int]($h/2))
        if ($px.R -gt 3 -or $px.G -gt 3 -or $px.B -gt 3) {
            $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
            $method = "PrintWindow+fullcontent"
            $done = $true
        }
    }
    $g.Dispose(); $bmp.Dispose()
} catch {}

# ② PrintWindow 普通
if (-not $done) {
    try {
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [PvzWin32]::PrintWindow($hwnd, $hdc, 0)
        $g.ReleaseHdc($hdc)
        if ($ok) {
            $px = $bmp.GetPixel([int]($w/2), [int]($h/2))
            if ($px.R -gt 3 -or $px.G -gt 3 -or $px.B -gt 3) {
                $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
                $method = "PrintWindow"
                $done = $true
            }
        }
        $g.Dispose(); $bmp.Dispose()
    } catch {}
}

# ③ 屏幕区域（兜底）
if (-not $done) {
    try {
        $wr = New-Object PvzWin32+RECT
        [void][PvzWin32]::GetWindowRect($hwnd, [ref]$wr)
        Capture-Screen $wr.Left $wr.Top ($wr.Right - $wr.Left) ($wr.Bottom - $wr.Top) $out
        $method = "screen-region"
        $done = $true
    } catch {}
}

if ($done) { Write-Output "ok:$method:${'$'}w x ${'$'}h" } else { Write-Output "err:all-failed" }
`, 30000);

  const out = r.out || '';
  if (out.startsWith('ok:')) {
    const parts = out.split(':');
    return { ok: true, path: outPath, method: parts[1], size: parts[2] || '' };
  }
  return { ok: false, error: out || r.err || 'unknown' };
}

// ── 后台点击（不占键鼠）───────────────────────────────────────────────────

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;

/**
 * 往游戏窗口投递一次点击。
 *
 * 关键：用 PostMessage 而不是 SendInput —— 不移动真实光标、不抢焦点。
 *
 * @param {number} hwnd 窗口句柄
 * @param {number} x 客户区坐标
 * @param {number} y 客户区坐标
 * @param {boolean} clientCoords 是否是客户区坐标（默认 true）
 */
export async function postClick(hwnd, x, y, clientCoords = true) {
  // lParam 格式：低 16 位 x，高 16 位 y
  const r = await runPS(`
$hwnd = [IntPtr]${hwnd}
$x = ${Math.round(x)}
$y = ${Math.round(y)}
$lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
$wp = [IntPtr]1

# 先移动（有些游戏需要）
[void][PvzWin32]::PostMessage($hwnd, ${WM_MOUSEMOVE}, [IntPtr]::Zero, $lp)
Start-Sleep -Milliseconds 30
[void][PvzWin32]::PostMessage($hwnd, ${WM_LBUTTONDOWN}, $wp, $lp)
Start-Sleep -Milliseconds 60
[void][PvzWin32]::PostMessage($hwnd, ${WM_LBUTTONUP}, [IntPtr]::Zero, $lp)

Write-Output "ok"
`, 15000);

  return { ok: (r.out || '').includes('ok') };
}

/**
 * 批量点击（用于连续操作，比如收阳光）。
 */
export async function postClickMany(hwnd, points, delayMs = 120) {
  const lines = points.map(({ x, y }) => {
    const lp = `[IntPtr]((${Math.round(y)} -shl 16) -bor (${Math.round(x)} -band 0xFFFF))`;
    return `
[void][PvzWin32]::PostMessage($hwnd, ${WM_LBUTTONDOWN}, [IntPtr]1, ${lp})
Start-Sleep -Milliseconds 40
[void][PvzWin32]::PostMessage($hwnd, ${WM_LBUTTONUP}, [IntPtr]::Zero, ${lp})
Start-Sleep -Milliseconds ${delayMs}`;
  }).join('\n');

  const r = await runPS(`$hwnd = [IntPtr]${hwnd}\n${lines}\nWrite-Output "ok"`, 60000);
  return { ok: (r.out || '').includes('ok'), count: points.length };
}

// ── 游戏状态读取（截图分析）────────────────────────────────────────────────

/**
 * 分析截图，读出当前的游戏状态。
 *
 * PVZ 的界面布局是固定的（800x600 或 1024x768），
 * 所以可以按固定坐标取色判断：
 *   · 阳光数：左上角文字区（需要 OCR，或用模板匹配）
 *   · 卡片冷却：种子卡片的灰度
 *   · 棋盘：9x5 格，每格 80x100 像素
 *
 * 这里先提供「取色」的基础能力，具体识别逻辑等游戏装上再调。
 */
export async function samplePixels(imagePath, points) {
  const checks = points.map((p, i) =>
    `$px = $bmp.GetPixel(${Math.round(p.x)}, ${Math.round(p.y)}); $res += "p${i}:$($px.R),$($px.G),$($px.B);"`
  ).join('\n');

  const r = await runPS(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${imagePath.replace(/\\/g, '\\\\')}')
$res = ""
${checks}
$bmp.Dispose()
Write-Output $res
`, 20000);

  const out = r.out || '';
  const result = [];
  for (const m of out.matchAll(/p(\d+):(\d+),(\d+),(\d+)/g)) {
    result.push({ index: Number(m[1]), r: Number(m[2]), g: Number(m[3]), b: Number(m[4]) });
  }
  return result;
}

export default {
  listWindows,
  findGameWindow,
  findWindowByPid,
  captureWindow,
  postClick,
  postClickMany,
  samplePixels,
};
