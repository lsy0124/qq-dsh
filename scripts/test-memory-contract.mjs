// 记忆写入的字段契约：qq_memory_append 的 extra 必须能把后端真正读的键带过去。
//
// 背景（2026-11-01 实测的 bug）：
//   记忆系统在 bridge.js 里早就写好了 —— selfBelief（性格变化的载体）读
//   extra.changedBy / weight / until，contentMemory 读 extra.platform / id /
//   title / url / type。但 MCP 这一层的 zod schema 从来没声明过这些键，
//   而 zod 默认会**丢掉未声明的字段**。于是：
//     · 写完 selfBelief，「因为什么改的」「旧想法作废」全是空的 —— 性格不会变；
//     · contentMemory 拿不到 platform，后端 `if (!platform) return` —— 一条都不记；
//     · pendingThought 写 2 小时过期，实际按默认值走。
//   工具调用全部成功返回，所以从外面完全看不出来，只能靠这条用例钉住。
//
// 这里用 vm 加载真实的 mcp-snowluma-safe.js，拿到工具的真实 schema，
// 再用 zod 按 MCP SDK 的方式解析一次 —— 断言的是「解析之后这些键还在」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 只加载工具定义：把 import 行去掉、把 __dirname 固定、灌入最小上下文，
 * 拿到 name → { schema, callback } 的映射。
 */
function loadTools() {
  const tools = new Map();
  const source = fs
    .readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');

  class McpServer {
    constructor() {
      this.tool = (name, _description, schema, callback) => tools.set(name, { schema, callback });
    }
    connect() {}
  }

  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: async () => Response.json({}),
    AbortSignal,
    http: { request: () => { throw new Error('fixture did not inject http'); } },
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (v) => JSON.stringify(v),
  });
  return tools;
}

const tools = loadTools();

/** 按 MCP SDK 的方式解析一次参数，返回解析结果（未声明的键会被 zod 丢掉）。 */
function parseArgs(name, args) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} 应该存在`);
  return z.object(tool.schema).parse(args);
}

test('qq_memory_append 的 extra 能带上 selfBelief 的性格变化参数', () => {
  const parsed = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'selfBelief',
    content: '我好像不那么怕被怼了',
    extra: {
      changedBy: '他怼我的时候我没躲',
      weight: 4,
    },
  });
  assert.equal(parsed.extra.changedBy, '他怼我的时候我没躲', 'changedBy 不能被 schema 丢掉');
  assert.equal(parsed.extra.weight, 4, 'weight 不能被 schema 丢掉');
});

test('qq_memory_append 的 extra 能把旧想法标成已经过去了', () => {
  const parsed = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'selfBelief',
    content: '现在不怕了',
    extra: { until: '我怕被怼', changedBy: '那次他说了那句话' },
  });
  assert.equal(parsed.extra.until, '我怕被怼', 'until 不能被 schema 丢掉');
  assert.equal(parsed.extra.changedBy, '那次他说了那句话');
});

test('qq_memory_append 的 extra 能带上 contentMemory 的平台与来源', () => {
  const parsed = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'contentMemory',
    content: '这只猫跑得像我',
    extra: {
      platform: 'douyin',
      id: '7300000000000000000',
      title: '开局自己跑来的一只猫',
      url: 'https://example.invalid/v/1',
      type: 'funny',
    },
  });
  // platform 是后端硬前置：丢了它，appendMemoryV2 直接 return，一条都不记。
  assert.equal(parsed.extra.platform, 'douyin', 'platform 不能被 schema 丢掉');
  assert.equal(parsed.extra.id, '7300000000000000000');
  assert.equal(parsed.extra.title, '开局自己跑来的一只猫');
  assert.equal(parsed.extra.type, 'funny');
});

test('qq_memory_append 原有的轻量记忆参数没有被改动', () => {
  const topic = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'activeTopic',
    content: '在聊星露谷',
    extra: { participants: ['他'], pendingQuestion: '要不要一起玩' },
  });
  assert.deepEqual(topic.extra.participants, ['他']);
  assert.equal(topic.extra.pendingQuestion, '要不要一起玩');

  const thought = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'pendingThought',
    content: '想问问他今天吃了没',
    extra: { motivation: 'sociability', expiresAtMs: 3600000 },
  });
  assert.equal(thought.extra.expiresAtMs, 3600000, 'expiresAtMs 要能自定义，否则 2 小时假设不成立');

  const impression = parseArgs('qq_memory_append', {
    key: 'group:1',
    token: 'fixture',
    category: 'memberImpression',
    content: '爱接梗',
    extra: { target: '小鱼儿' },
  });
  assert.equal(impression.extra.target, '小鱼儿');
});

test('selfBelief 的 weight 只在 1-5 之间，越界要当场报错而不是静默生效', () => {
  assert.throws(
    () => parseArgs('qq_memory_append', {
      key: 'group:1', token: 'fixture', category: 'selfBelief', content: 'x',
      extra: { weight: 9 },
    }),
    /weight|expected|invalid/i,
    'backend 的 selfBelief weight 上限是 5，schema 应该在入口就拦住',
  );
});
