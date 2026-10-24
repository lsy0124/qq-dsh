import { synthesizeSpeech, ttsStatus } from './tts-core.js';
import { acquireMediaLock } from './media-lock.js';
// mcp-comfyui.js —— 把本机 ComfyUI 接成 MCP 工具，让 agent 能真的画图并直接发到 QQ。
//
// 为什么需要这个文件（而不是直接用 ComfyUI 的 Web 界面）：
//   qq-bridge 的 MCP 工具面里**没有任何画图能力** —— 它能收图、能转存图片、能发图，
//   但不会生成图。ComfyUI 是本机已经装好的生成引擎（D:\ComfyUI_windows_portable_nvidia），
//   两者之间缺的就是这一层胶水：把「画一只猫」翻译成 ComfyUI 的 workflow JSON，
//   轮询到出图，再把 PNG 交给桥接的 /api/send/group|private 发出去。
//
// 设计约束：
//   - 纯 stdio MCP server，不依赖桥接进程内部符号，只通过 HTTP 调 ComfyUI 与桥接控制台 API；
//   - 显存只有 8 GB：默认串行、单任务、出图后可选释放模型（free 端点），避免与语音模型抢显存；
//   - ComfyUI 地址/模型名/默认尺寸全部可通过环境变量覆盖，不写死在代码里；
//   - 出错要把 ComfyUI 的原始错误带出来（它的 node_errors 是排障的唯一线索）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMFY = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const CONSOLE_PORT = Number(process.env.QQ_BRIDGE_CONSOLE_PORT || 0) || 3100;
const CONSOLE_BASE = `http://127.0.0.1:${CONSOLE_PORT}`;

// 默认工作流组件：全部可用环境变量覆盖，因为它们取决于用户装了哪套模型。
const DEFAULT_UNET = process.env.COMFYUI_UNET || 'wan2.2_ti2v_5B_fp16.safetensors';
const DEFAULT_CLIP = process.env.COMFYUI_CLIP || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors';
const DEFAULT_VAE = process.env.COMFYUI_VAE || 'wan2.2_vae.safetensors';
const DEFAULT_NEGATIVE = process.env.COMFYUI_NEGATIVE || 'low quality, blurry, watermark, text';
const OUTPUT_DIR = process.env.COMFYUI_OUTPUT_DIR || path.join(ROOT, 'state', 'comfy-out');

function log(...args) {
  // stdio MCP：stdout 是协议通道，任何调试输出必须走 stderr。
  console.error('[comfyui-mcp]', ...args);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function consoleToken() {
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function jsonFetch(url, init = {}, timeoutMs = 30000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`HTTP ${res.status} ${url} :: ${String(detail).slice(0, 600)}`);
  }
  return body;
}

async function comfyOnline() {
  try {
    const stats = await jsonFetch(`${COMFY}/system_stats`, {}, 8000);
    return { online: true, stats };
  } catch (error) {
    return { online: false, error: String(error?.message ?? error) };
  }
}

/**
 * 组装一个最简 txt2img workflow（API 格式）。
 *
 * 用 UNETLoader 而不是 CheckpointLoaderSimple：用户这台机器上的模型全在
 * diffusion_models/ 下（MiniMax H3 / Wan2.2），checkpoints/ 是空的 ——
 * CheckpointLoaderSimple 会直接报 "ckpt_name not in list"。
 * 组合式加载（UNET + CLIP + VAE）对这类模型才是对的接法。
 */
function buildWorkflow({ prompt, negative, width, height, steps, cfg, seed, unet, clip, vae, filenamePrefix }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    '6': {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: filenamePrefix },
    },
  };
}

async function waitForHistory(promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hist = await jsonFetch(`${COMFY}/history/${promptId}`, {}, 15000);
    const entry = hist?.[promptId];
    if (entry) {
      if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
        const messages = entry.status?.messages ?? [];
        throw new Error(`ComfyUI 执行失败: ${JSON.stringify(messages).slice(0, 800)}`);
      }
      if (entry.outputs && Object.keys(entry.outputs).length) return entry;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`等待出图超时（${Math.round(timeoutMs / 1000)}s）`);
}

async function downloadImage(image) {
  const qs = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  const res = await fetch(`${COMFY}/view?${qs}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`取图失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(OUTPUT_DIR);
  const safeName = `${Date.now()}-${String(image.filename).replace(/[^\w.-]/g, '_')}`;
  const file = path.join(OUTPUT_DIR, safeName);
  fs.writeFileSync(file, buf);
  return file;
}

async function releaseModels() {
  try {
    await jsonFetch(`${COMFY}/free`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }, 15000);
    return true;
  } catch (error) {
    log('free 失败', error?.message);
    return false;
  }
}

async function sendImageToQQ({ key, file, replyToMessageId, token }) {
  if(!/^(private|group):\d+$/.test(String(key)) || !token)throw Error('必须提供当前 QQ 会话 key 与 token');
  const res=await fetch(CONSOLE_BASE+'/api/socialV2/send-generated-image',{
    method:'POST',headers:{'content-type':'application/json','x-console-token':consoleToken(),'x-agent-token':token,'x-agent-call':'1'},
    body:JSON.stringify({key,file:path.basename(file),token,replyToMessageId}),signal:AbortSignal.timeout(120000)
  });
  const result=await res.json();
  if(!res.ok||!result.ok)throw Error('桥接发图失败 HTTP '+res.status+': '+String(result.error??'unknown'));
  return result;
}

const server = new McpServer({ name: 'comfyui', version: '1.0.0' });

server.tool(
  'comfy_status',
  '只读：检查本机 ComfyUI 是否在线、显卡与可用模型清单。画图前先调它确认环境。',
  {},
  async () => {
    const { online, stats, error } = await comfyOnline();
    if (!online) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            online: false,
            error,
            hint: `ComfyUI 没在跑。启动方式：D:\\ComfyUI_windows_portable_nvidia\\ComfyUI_windows_portable\\run_nvidia_gpu.bat（已内置 UTF-8 环境变量，避免 GBK emoji 崩溃）。`,
          }, null, 2),
        }],
      };
    }
    let models = {};
    try {
      const info = await jsonFetch(`${COMFY}/object_info`, {}, 25000);
      models = {
        unet: info?.UNETLoader?.input?.required?.unet_name?.[0] ?? [],
        clip: info?.CLIPLoader?.input?.required?.clip_name?.[0] ?? [],
        vae: info?.VAELoader?.input?.required?.vae_name?.[0] ?? [],
      };
    } catch {}
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          online: true,
          version: stats?.system?.comfyui_version,
          device: stats?.devices?.[0]?.name,
          vram_total_gb: stats?.devices?.[0]?.vram_total
            ? Math.round((stats.devices[0].vram_total / 1024 ** 3) * 10) / 10
            : null,
          vram_free_gb: stats?.devices?.[0]?.vram_free
            ? Math.round((stats.devices[0].vram_free / 1024 ** 3) * 10) / 10
            : null,
          defaults: { unet: DEFAULT_UNET, clip: DEFAULT_CLIP, vae: DEFAULT_VAE },
          models,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'comfy_generate',
  '用本机 ComfyUI 生成一张图。可选自动发到 QQ 群/私聊。显存只有 8G，默认出图后会释放模型。',
  {
    prompt: z.string().min(1).describe('正向提示词（英文效果通常更好，也可中文）'),
    negative: z.string().optional().describe('负向提示词'),
    width: z.number().int().min(128).max(2048).optional().describe('宽，默认 768'),
    height: z.number().int().min(128).max(2048).optional().describe('高，默认 768'),
    steps: z.number().int().min(1).max(80).optional().describe('采样步数，默认 20'),
    cfg: z.number().min(0).max(30).optional().describe('CFG，默认 5'),
    seed: z.number().int().optional().describe('随机种子，省略则随机'),
    unet: z.string().optional().describe('UNET 模型文件名，省略用默认'),
    clip: z.string().optional().describe('CLIP/文本编码器文件名，省略用默认'),
    vae: z.string().optional().describe('VAE 文件名，省略用默认'),
    token: z.string().optional().describe('当前 QQ 会话令牌，sendToKey 非空时必须提供；来自消息中的会话令牌'),
    sendToKey: z.string().optional().describe('可选：group:<群号> 或 private:<QQ号>，出图后直接发过去'),
    replyToMessageId: z.union([z.string(), z.number()]).optional().describe('可选：引用回复某条消息'),
    freeAfter: z.boolean().optional().describe('出图后是否立刻释放显存（默认 true）'),
  },
  async (args) => {
    if(args.sendToKey && !args.token) return {isError:true,content:[{type:'text',text:'发送图片必须携带当前会话 token，请使用消息中的会话令牌。'}]};
    const releaseMediaLock = await acquireMediaLock();
    try {
    const { online, error } = await comfyOnline();
    if (!online) {
      return {
        content: [{
          type: 'text',
          text: `ComfyUI 离线，无法画图。原因：${error}\n请先运行 run_nvidia_gpu.bat 启动它。`,
        }],
        isError: true,
      };
    }

    const width = args.width ?? 768;
    const height = args.height ?? 768;
    const seed = args.seed ?? Math.floor(Math.random() * 1e15);
    const workflow = buildWorkflow({
      prompt: args.prompt,
      negative: args.negative ?? DEFAULT_NEGATIVE,
      width,
      height,
      steps: args.steps ?? 20,
      cfg: args.cfg ?? 5,
      seed,
      unet: args.unet ?? DEFAULT_UNET,
      clip: args.clip ?? DEFAULT_CLIP,
      vae: args.vae ?? DEFAULT_VAE,
      filenamePrefix: `qqbridge_${Date.now()}`,
    });

    log('提交任务 seed=', seed, `${width}x${height}`);
    const queued = await jsonFetch(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: `qqbridge-${process.pid}` }),
    }, 30000);

    if (queued?.node_errors && Object.keys(queued.node_errors).length) {
      return {
        content: [{
          type: 'text',
          text: `工作流被 ComfyUI 拒绝：\n${JSON.stringify(queued.node_errors, null, 2)}\n\n提示：模型名必须来自 comfy_status 返回的清单。`,
        }],
        isError: true,
      };
    }
    const promptId = queued?.prompt_id;
    if (!promptId) {
      return { content: [{ type: 'text', text: `ComfyUI 未返回 prompt_id：${JSON.stringify(queued).slice(0, 400)}` }], isError: true };
    }

    let entry;
    try {
      entry = await waitForHistory(promptId, 300000);
    } catch (waitError) {
      if (args.freeAfter !== false) await releaseModels();
      return { content: [{ type: 'text', text: String(waitError?.message ?? waitError) }], isError: true };
    }

    const images = [];
    for (const nodeOut of Object.values(entry.outputs ?? {})) {
      for (const img of nodeOut?.images ?? []) images.push(img);
    }
    if (!images.length) {
      if (args.freeAfter !== false) await releaseModels();
      return { content: [{ type: 'text', text: 'ComfyUI 跑完了但没有产出图片节点。' }], isError: true };
    }

    const saved = [];
    for (const img of images) {
      try { saved.push(await downloadImage(img)); } catch (e) { log('取图失败', e?.message); }
    }

    let sendResult = null;
    let sendError = null;
    if (args.sendToKey && saved.length) {
      try {
        sendResult = await sendImageToQQ({
          key: args.sendToKey,
          file: saved[0],
          replyToMessageId: args.replyToMessageId,
          token: args.token,
        });
      } catch (e) {
        sendError = String(e?.message ?? e);
      }
    }

    const freed = args.freeAfter !== false ? await releaseModels() : false;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: saved.length > 0 && !sendError,
          prompt_id: promptId,
          seed,
          size: `${width}x${height}`,
          files: saved,
          sent: sendResult ? true : (sendError ? false : null),
          sendError,
          vramReleased: freed,
        }, null, 2),
      }],
    };
    } finally { releaseMediaLock(); }
  },
);

server.tool(
  'comfy_free',
  '释放 ComfyUI 占用的显存（卸载模型）。8G 显存和语音模型抢资源时先调这个。',
  {},
  async () => {
    const ok = await releaseModels();
    return { content: [{ type: 'text', text: ok ? '已请求 ComfyUI 释放模型与显存。' : '释放请求失败（ComfyUI 可能没在跑）。' }] };
  },
);

server.tool('tts_status','检查本机语音合成服务和参考音频是否就绪。',{},async()=>({content:[{type:'text',text:JSON.stringify(await ttsStatus())}]}));
server.tool('tts_synthesize','合成一段语音到语音库，返回 file 文件名。随后调用 qq_send_voice 发送；本工具不自动发送。',{text:z.string().min(1).max(600)},async({text})=>{
  try{return {content:[{type:'text',text:JSON.stringify(await synthesizeSpeech(text))}]};}
  catch(e){return {isError:true,content:[{type:'text',text:String(e.message)}]};}
});
const transport = new StdioServerTransport();
await server.connect(transport);
log('comfyui MCP server 就绪，ComfyUI =', COMFY);
