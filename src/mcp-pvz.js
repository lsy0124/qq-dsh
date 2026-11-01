/**
 * mcp-pvz.js —— 植物大战僵尸 AI 桥接 MCP
 *
 * 底层是游戏内的 mod（pvz-ai-bridge），它在本机 127.0.0.1:8770 暴露 HTTP API。
 * 这个 MCP 把那套 HTTP 接口包装成 AI 能调的工具。
 *
 * 为什么走 bridge 而不是模拟输入：
 *   我们实测过 PostMessage / SendMessage / SendInput 全被游戏拒了
 *   （Godot 4 用 RawInput，只认真实硬件事件）。
 *   而这个 mod 直接调游戏内部方法，完全绕开输入层，还不占用户键鼠。
 *
 * 前置条件：
 *   · 游戏在跑（mod 随游戏启动加载）
 *   · 游戏侧装了 pvz-ai-bridge mod（0.2.x / 0.3.x）
 *   · 8770 端口可访问
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PVZ_BRIDGE_PORT) || 8770;
const BASE = `http://127.0.0.1:${PORT}`;
// 写操作总开关（和抖音一致的做法）
const WRITES_ALLOWED = process.env.PVZ_ALLOW_WRITES !== '0';

// 游戏本体。桥接是游戏内 mod，必须游戏先跑起来 8770 才有响应。
const PVZ_EXE = process.env.PVZ_EXE
  || 'F:\\植物大战僵尸杂交版0.31\\植物大战僵尸杂交重制版\\植物大战僵尸杂交版发布版0.31.0.Csharp.exe';

const server = new McpServer({ name: 'pvz', version: '1.0.0' });

function log(...a) {
  console.error('[pvz]', ...a);
}

async function api(pathname, options = {}) {
  const url = BASE + pathname;
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || text.slice(0, 200) };
    }
    return { ok: true, data };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        ok: false,
        error: `连不上 PVZ 桥接（${BASE}）。\n`
          + '可能原因：\n'
          + '· 游戏没开 —— 桥接随游戏启动，先把植物大战僵尸杂交版打开\n'
          + '· 游戏侧没装 pvz-ai-bridge mod\n'
          + '· 端口不是 8770 —— 可用环境变量 PVZ_BRIDGE_PORT 覆盖',
      };
    }
    return { ok: false, error: msg.slice(0, 200) };
  }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const err = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function writesGate(tool) {
  if (WRITES_ALLOWED) return null;
  return err(`「${tool}」会操作游戏，当前被 PVZ_ALLOW_WRITES=0 禁用。`);
}

// ── 状态 ─────────────────────────────────────────────────────────────────

// ── 启动游戏 ─────────────────────────────────────────────────────────────

/** 进程名是否已在跑（Godot 打包后进程名通常就是 exe 名）。 */
function pvzRunning() {
  try {
    const name = path.basename(PVZ_EXE);
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | `
      + `Where-Object { $_.ProcessName -like '*植物大战*' -or $_.ProcessName -like '*PVZ*' -or $_.ProcessName -like '*Plants*' } | `
      + `Select-Object -First 1 -ExpandProperty Id"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

server.tool(
  'pvz_launch',
  '游戏没开时把它启动起来（桥接随游戏加载，起来后 8770 才有响应）。等 20-40 秒再 pvz_status。',
  {},
  async () => {
    if (!fs.existsSync(PVZ_EXE)) {
      return err(`找不到游戏本体：${PVZ_EXE}\n可用环境变量 PVZ_EXE 指定路径。`);
    }
    if (pvzRunning()) {
      return text('植物大战僵尸已经在运行了，直接用 pvz_status 看状态。');
    }
    try {
      // detached + unref：别让 MCP 进程被游戏拖住，也别在游戏关闭时连带退出
      const child = spawn(PVZ_EXE, [], {
        cwd: path.dirname(PVZ_EXE),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      log('已启动 PVZ:', PVZ_EXE);
      return text('植物大战僵尸启动中。等 20-40 秒（Godot 加载较慢），然后用 pvz_status 确认桥接连上。');
    } catch (e) {
      return err(`启动失败：${String(e?.message ?? e)}`);
    }
  },
);

server.tool(
  'pvz_status',
  '查 PVZ 桥接状态和游戏是否在战斗中。第一次用先调这个确认能连上。',
  {},
  async () => {
    const r = await api('/info');
    if (!r.ok) return err(r.error);

    const st = await api('/state?cells=1&rects=1');
    const info = r.data;
    const lines = [
      `桥接: ${info.mod} v${info.version}  端口 ${info.port}  Godot ${info.godot}`,
      `战斗中: ${info.inBattle ? '是' : '否'}`,
    ];
    if (info.mode) lines.push(`模式: ${info.mode}`);

    if (st.ok && st.data?.inBattle) {
      const d = st.data;
      if (d.sun !== undefined) lines.push(`阳光: ${d.sun}`);
      if (d.rows && d.cols) lines.push(`地图: ${d.rows} 行 × ${d.cols} 列`);
      if (d.wave !== undefined) lines.push(`波次: ${d.wave}`);
    }
    return text(lines.join('\n'));
  },
);

server.tool(
  'pvz_state',
  '读战斗快照：阳光、波次、格子里的植物、僵尸位置。rows/cols 都是 1-based。',
  {
    cells: z.boolean().optional().describe('是否返回每个格子的植物信息，默认 true'),
  },
  async ({ cells }) => {
    const q = cells === false ? '?rects=1' : '?cells=1&rects=1';
    const r = await api('/state' + q);
    if (!r.ok) return err(r.error);

    const d = r.data;
    if (!d?.inBattle) {
      return text('当前不在战斗中。需要先进一局关卡。');
    }
    return text(JSON.stringify(d, null, 2));
  },
);

server.tool(
  'pvz_screenshot',
  '截当前游戏画面（PNG）。想「看一眼现在什么局面」时用。',
  {
    format: z.enum(['png', 'jpg']).optional().describe('默认 png'),
  },
  async ({ format }) => {
    const q = format === 'jpg' ? '?fmt=jpg' : '';
    const url = BASE + '/screenshot' + q;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return err(`截图失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          { type: 'text', text: `截图 ${(buf.length / 1024).toFixed(0)} KB` },
          { type: 'image', data: buf.toString('base64'), mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png' },
        ],
      };
    } catch (e) {
      return err(`截图失败：${String(e?.message ?? e).slice(0, 150)}`);
    }
  },
);

// ── 操作 ─────────────────────────────────────────────────────────────────

server.tool(
  'pvz_plant',
  '在指定格子种植物。row/col 从 1 开始，slot 是卡槽序号（0 = 第一张卡）。',
  {
    row: z.number().int().min(1).max(10).describe('行号，从 1 开始'),
    col: z.number().int().min(1).max(15).describe('列号，从 1 开始'),
    slot: z.number().int().min(0).max(20).describe('卡槽序号，0 = 第一张卡'),
    packet: z.string().optional().describe('也可直接指定植物名（知道名字时用这个更准）'),
    force: z.boolean().optional().describe('无视冷却/阳光强行种（作弊用，一般别开）'),
  },
  async ({ row, col, slot, packet, force }) => {
    const denied = writesGate('pvz_plant');
    if (denied) return denied;

    const body = { row, col, slot };
    if (packet) body.packet = packet;
    if (force) body.force = true;

    const r = await api('/action/plant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 20000,
    });
    if (!r.ok) return err(`种植失败：${r.error}`);
    return text(`已在第 ${row} 行第 ${col} 列种植${packet ? `「${packet}」` : `卡槽 ${slot}`}`);
  },
);

server.tool(
  'pvz_shovel',
  '铲掉指定格子的植物。',
  {
    row: z.number().int().min(1).max(10).describe('行号，从 1 开始'),
    col: z.number().int().min(1).max(15).describe('列号，从 1 开始'),
  },
  async ({ row, col }) => {
    const denied = writesGate('pvz_shovel');
    if (denied) return denied;

    const r = await api('/action/shovel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ row, col }),
      timeoutMs: 15000,
    });
    if (!r.ok) return err(`铲除失败：${r.error}`);
    return text(`已铲除第 ${row} 行第 ${col} 列的植物`);
  },
);

server.tool(
  'pvz_click',
  '在游戏画面里点一下（坐标是画面内像素）。收阳光、点按钮用。',
  {
    x: z.number().int().min(0).describe('横坐标（画面内像素）'),
    y: z.number().int().min(0).describe('纵坐标（画面内像素）'),
    button: z.enum(['left', 'right']).optional().describe('默认 left'),
  },
  async ({ x, y, button }) => {
    const denied = writesGate('pvz_click');
    if (denied) return denied;

    const r = await api('/action/click', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x, y, button: button || 'left' }),
      timeoutMs: 15000,
    });
    if (!r.ok) return err(`点击失败：${r.error}`);
    return text(`已点击 (${x}, ${y})`);
  },
);

server.tool(
  'pvz_press',
  '按游戏里的动作键，比如暂停、开菜单。',
  {
    action: z.string().min(1).describe('动作名，如 Pause / Plant / Shovel'),
  },
  async ({ action }) => {
    const denied = writesGate('pvz_press');
    if (denied) return denied;

    const r = await api('/action/press', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
      timeoutMs: 15000,
    });
    if (!r.ok) return err(`按键失败：${r.error}`);
    return text(`已执行动作 ${action}`);
  },
);

server.tool(
  'pvz_command',
  '执行游戏控制台命令。可用命令见 pvz_list_commands。',
  {
    input: z.string().min(1).describe('完整命令，如 "/sun 999"、"/killall"'),
  },
  async ({ input }) => {
    const denied = writesGate('pvz_command');
    if (denied) return denied;

    const cmd = String(input).trim();
    if (!cmd.startsWith('/')) {
      return err('命令要以 / 开头，比如 /sun 999');
    }
    const r = await api('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: cmd }),
      timeoutMs: 20000,
    });
    if (!r.ok) return err(`命令失败：${r.error}`);
    return text(`已执行 ${cmd}\n${JSON.stringify(r.data, null, 2)}`);
  },
);

server.tool(
  'pvz_list_commands',
  '列出游戏控制台支持的所有命令。',
  {},
  async () => {
    const r = await api('/commands');
    if (!r.ok) return err(r.error);
    const cmds = r.data?.commands || {};
    const lines = Object.entries(cmds).map(([k, v]) => `/${k}  —  ${v}`);
    return text(`可用命令 ${lines.length} 个：\n\n${lines.join('\n')}`);
  },
);

server.tool(
  'pvz_list_nodes',
  '列出当前画面上可见的控件（按钮/文字等）。找「开始冒险」这类按钮坐标时用。',
  {
    name: z.string().optional().describe('按名字筛选，支持子串匹配'),
  },
  async ({ name }) => {
    const q = name ? `?name=${encodeURIComponent(name)}` : '';
    const r = await api('/action/list_nodes' + q);
    if (!r.ok) return err(r.error);
    return text(JSON.stringify(r.data, null, 2));
  },
);

// ── 启动 ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log(`PVZ MCP 就绪，桥接 = ${BASE}（写操作${WRITES_ALLOWED ? '已允许' : '已禁用'}）`);
