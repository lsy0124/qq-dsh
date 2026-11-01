/**
 * pvz-memory.mjs — 植物大战僵尸 内存读取桥
 *
 * 目标：只读游戏状态，不改内存（不当外挂）。
 *
 * 为什么用读内存而不是截屏：
 *   ① 截屏要视觉识别，PVZ 是 DirectDraw，截图可能全黑
 *   ② 读内存拿到的是精确数值（阳光数就是 175，不是"猜大约 175"）
 *   ③ 不需要抢焦点，不占用户键鼠
 *
 * 技术手段：ReadProcessMemory（Win32 API）
 *   - 只读，不写
 *   - 不需要管理员权限（同用户进程可读）
 *
 * 内存偏移的正确解法：
 *   不同版本（原版/年度版/融合版）偏移不同，所以不硬编码。
 *   改用「特征码扫描」找基址，再用已知的相对偏移取值。
 *
 * ⚠️ 仅用于本地单机游戏。
 */

import { spawn } from 'node:child_process';

// ── PowerShell + P/Invoke 桥（避免原生编译）───────────────────────────────

const PS_PRELUDE = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class PvzMem {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr baseAddr,
        byte[] buffer, int size, out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr baseAddr,
        byte[] buffer, int size, out IntPtr bytesWritten);

    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool EnumProcessModulesEx(IntPtr hProcess, IntPtr[] lphModule,
        int cb, out int lpcbNeeded, uint filterFlag);

    [DllImport("psapi.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetModuleBaseName(IntPtr hProcess, IntPtr hModule,
        StringBuilder lpBaseName, int nSize);

    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool GetModuleInformation(IntPtr hProcess, IntPtr hModule,
        out MODULEINFO lpmodinfo, int cb);

    [StructLayout(LayoutKind.Sequential)]
    public struct MODULEINFO {
        public IntPtr lpBaseOfDll;
        public uint SizeOfImage;
        public IntPtr EntryPoint;
    }

    public const uint PROCESS_READ = 0x0410;   // QUERY_INFO | VM_READ
    public const uint PROCESS_WRITE = 0x0428;  // + VM_WRITE (仅备用，正常不用)
    public const uint LIST_MODULES_ALL = 0x03;

    // 读一个 int32
    public static int ReadInt32(IntPtr h, long addr) {
        byte[] buf = new byte[4];
        IntPtr read;
        if (!ReadProcessMemory(h, new IntPtr(addr), buf, 4, out read)) return 0;
        return BitConverter.ToInt32(buf, 0);
    }

    // 读一个 float
    public static float ReadFloat(IntPtr h, long addr) {
        byte[] buf = new byte[4];
        IntPtr read;
        if (!ReadProcessMemory(h, new IntPtr(addr), buf, 4, out read)) return 0f;
        return BitConverter.ToSingle(buf, 0);
    }

    // 读指定长度的字节
    public static byte[] ReadBytes(IntPtr h, long addr, int len) {
        byte[] buf = new byte[len];
        IntPtr read;
        if (!ReadProcessMemory(h, new IntPtr(addr), buf, len, out read)) return null;
        return buf;
    }

    // 读指针（32 位进程用 4 字节）
    public static long ReadPtr(IntPtr h, long addr) {
        byte[] buf = new byte[4];
        IntPtr read;
        if (!ReadProcessMemory(h, new IntPtr(addr), buf, 4, out read)) return 0;
        return BitConverter.ToUInt32(buf, 0);
    }

    // 特征码扫描：在模块内存里找一段字节
    // 返回第一个匹配的绝对地址，找不到返回 0
    public static long ScanPattern(IntPtr h, long baseAddr, int size, string patternHex, string mask) {
        byte[] buf = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(h, new IntPtr(baseAddr), buf, size, out read)) return 0;

        int patLen = mask.Length;
        byte[] pat = new byte[patLen];
        for (int i = 0; i < patLen; i++) {
            pat[i] = Convert.ToByte(patternHex.Substring(i * 2, 2), 16);
        }

        for (int i = 0; i <= size - patLen; i++) {
            bool hit = true;
            for (int j = 0; j < patLen; j++) {
                if (mask[j] == '?' ) continue;
                if (buf[i + j] != pat[j]) { hit = false; break; }
            }
            if (hit) return baseAddr + i;
        }
        return 0;
    }
}
"@
`;

function runPS(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', PS_PRELUDE + '\n' + script], {
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
  });
}

// ── 进程操作 ──────────────────────────────────────────────────────────────

/**
 * 找 PVZ 进程。
 * @returns {Promise<{pid, name, path} | null>}
 */
export async function findProcess() {
  const r = await runPS(`
$names = @('PlantsVsZombies','plantsvszombies','pvz','PvZ','PopCapGame1')
$found = $null
foreach ($n in $names) {
    $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { $found = $p; break }
}
if (-not $found) {
    # 兜底：按窗口标题找
    $all = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '植物大战僵尸|Plants vs' }
    if ($all) { $found = $all | Select-Object -First 1 }
}
if ($found) {
    $path = ''
    try { $path = $found.Path } catch {}
    Write-Output ("FOUND:" + $found.Id + ":" + $found.ProcessName + ":" + $path)
} else {
    Write-Output "NOTFOUND"
}
`, 30000);

  const m = (r.out || '').match(/FOUND:(\d+):([^:]+):(.*)/);
  if (!m) return null;
  return { pid: Number(m[1]), name: m[2], path: m[3] || '' };
}

/**
 * 列出进程的所有模块（含基址和大小）。
 * 用来确认游戏主模块在哪儿。
 */
export async function listModules(pid) {
  const r = await runPS(`
$h = [PvzMem]::OpenProcess([PvzMem]::PROCESS_READ, $false, ${pid})
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR:open-failed"; exit }
$mods = New-Object 'IntPtr[]' 1024
$needed = 0
[void][PvzMem]::EnumProcessModulesEx($h, $mods, [IntPtr]::Size * 1024, [ref]$needed, [PvzMem]::LIST_MODULES_ALL)
$count = $needed / [IntPtr]::Size
$out = @()
for ($i = 0; $i -lt $count; $i++) {
    $sb = New-Object System.Text.StringBuilder 260
    [void][PvzMem]::GetModuleBaseName($h, $mods[$i], $sb, 260)
    $mi = New-Object PvzMem+MODULEINFO
    [void][PvzMem]::GetModuleInformation($h, $mods[$i], [ref]$mi, [System.Runtime.InteropServices.Marshal]::SizeOf($mi))
    $out += [pscustomobject]@{ name = $sb.ToString(); base = $mi.lpBaseOfDll.ToInt64(); size = $mi.SizeOfImage }
}
[void][PvzMem]::CloseHandle($h)
$out | ConvertTo-Json -Compress
`, 30000);

  if (!r.out || r.out.startsWith('ERR')) return { ok: false, error: r.out };
  try {
    const parsed = JSON.parse(r.out);
    return { ok: true, modules: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
}

// ── 内存读取 ──────────────────────────────────────────────────────────────

/**
 * 打开进程句柄（后续所有读操作共用）。
 * 注意：PowerShell 每次调用是新进程，句柄不能跨调用保存，
 *      所以这里返回的是「能否打开」的探测结果。
 */
export async function canAttach(pid) {
  const r = await runPS(`
$h = [PvzMem]::OpenProcess([PvzMem]::PROCESS_READ, $false, ${pid})
if ($h -eq [IntPtr]::Zero) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output "ERR:$code"
} else {
    [void][PvzMem]::CloseHandle($h)
    Write-Output "OK"
}
`, 20000);
  return (r.out || '').startsWith('OK');
}

/**
 * 批量读内存地址。
 * @param {number} pid
 * @param {Array<{addr:number, type:'int'|'float'|'ptr'|'bytes', len?:number}>} reads
 */
export async function readMemory(pid, reads) {
  const lines = reads.map((rd, i) => {
    const addr = `[IntPtr]${rd.addr}`;
    switch (rd.type) {
      case 'int':   return `$v${i} = [PvzMem]::ReadInt32($h, ${rd.addr})`;
      case 'float': return `$v${i} = [PvzMem]::ReadFloat($h, ${rd.addr})`;
      case 'ptr':   return `$v${i} = [PvzMem]::ReadPtr($h, ${rd.addr})`;
      case 'bytes': {
        const len = rd.len || 16;
        return `$b${i} = [PvzMem]::ReadBytes($h, ${rd.addr}, ${len}); $v${i} = if ($b${i}) { ($b${i} | ForEach-Object { $_.ToString("x2") }) -join '' } else { "" }`;
      }
      default: return `$v${i} = 0`;
    }
  }).join('\n');

  const outputs = reads.map((_, i) => `"r${i}:" + $v${i}`).join('\n');

  const r = await runPS(`
$h = [PvzMem]::OpenProcess([PvzMem]::PROCESS_READ, $false, ${pid})
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR:cannot-open"; exit }
${lines}
[void][PvzMem]::CloseHandle($h)
${outputs}
`, 60000);

  const results = [];
  for (const line of (r.out || '').split('\n')) {
    const m = line.match(/^r(\d+):(.*)$/);
    if (m) {
      const v = m[2].trim();
      results[Number(m[1])] = (rd => {
        const orig = reads[Number(m[1])];
        if (orig?.type === 'float') return Number(v);
        if (orig?.type === 'bytes') return v;
        return Number(v);
      })();
    }
  }
  return { ok: !(r.out || '').startsWith('ERR'), values: results, raw: r.out };
}

/**
 * 特征码扫描：在模块范围内找一段字节模式。
 *
 * 这是版本无关的定位方法 —— 不依赖固定偏移。
 *
 * @param {number} pid
 * @param {number} baseAddr 模块基址
 * @param {number} size 模块大小
 * @param {string} patternHex 十六进制字节串，如 "558BEC83EC" （用 ?? 表示通配）
 * @param {string} mask 掩码，如 "xxxxxxxx" 或 "xx??xx"
 *
 * 例：找 "植物数组基址的引用指令"
 *   pattern: "A1????????8B0D"  mask: "x???????x"
 */
export async function scanPattern(pid, baseAddr, size, patternHex, mask) {
  // 分块扫描，避免一次读太大内存
  const CHUNK = 8 * 1024 * 1024;
  const chunks = Math.ceil(size / CHUNK);

  for (let i = 0; i < chunks; i++) {
    const offset = i * CHUNK;
    const len = Math.min(CHUNK, size - offset);

    const r = await runPS(`
$h = [PvzMem]::OpenProcess([PvzMem]::PROCESS_READ, $false, ${pid})
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR"; exit }
$addr = [long]${baseAddr} + ${offset}
$hit = [PvzMem]::ScanPattern($h, $addr, ${len}, '${patternHex}', '${mask}')
[void][PvzMem]::CloseHandle($h)
Write-Output ("HIT:" + $hit)
`, 120000);

    const m = (r.out || '').match(/HIT:(-?\d+)/);
    if (m) {
      const addr = Number(m[1]);
      if (addr !== 0) return { ok: true, addr };
    }
  }
  return { ok: false, addr: 0 };
}

export default {
  findProcess,
  listModules,
  canAttach,
  readMemory,
  scanPattern,
};
