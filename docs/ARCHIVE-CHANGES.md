> Historical source-package documentation. See the root README for current setup and validation limits.

# 新增能力说明（本项目相对上游的增量）

> 本文档记录在原 qq-bridge 基础上新增的能力，以及对 RVC/GPT-SoVITS 的配套改造。
> 供 codex 审阅与开源发布参考。

---

## 一、新增的 MCP 服务

### 1.1 `mcp-voice-say.js` — 语音与唱歌（5 个工具）

**定位**：桥接自带的 `qq_send_voice` 只能发**语音库里已有的文件**，AI 没有「把一句话变成声音」的能力。这个 MCP 补上那一环。

| 工具 | 能力 | 实现 |
|---|---|---|
| `qq_say` | 文本 → GPT-SoVITS → 语音条 | HTTP 调 9880 `/tts` |
| `qq_tts_status` | 查 TTS 在线状态与当前音色 | HTTP 探活 |
| `qq_sing` | 音频文件 → RVC 换音色 → 发出 | 调本地 `rvc_infer.py` |
| `qq_song` | **歌名 → 全自动点歌** | 搜索+下载+RVC 全链路 |
| `qq_song_search` | 只搜不下（看候选素材） | bilibili-api |

**`qq_say` 的情绪映射**（`mood` 参数）：

```js
soft:   { speed: 0.88, temperature: 1.08, topP: 0.94 }   // 温柔安抚
normal: { speed: 0.94, temperature: 1.05, topP: 0.95 }   // 平常
lively: { speed: 1.06, temperature: 1.15, topP: 0.92 }   // 轻快兴奋
sleepy: { speed: 0.82, temperature: 1.02, topP: 0.96 }   // 困得含糊
```

### 1.2 `mcp-douyin.js` — 抖音（12 个工具）

**核心技术路线**：不逆向签名，而是在浏览器页面上下文里 `fetch`，让页面自己算 `a_bogus`。

```js
page.evaluate(async (url) => {
  const r = await fetch(url, { credentials: 'include' });  // 页面自动补签名
  return await r.json();
}, url)
```

**为什么这么做**：抖音每个 web 接口都要 `a_bogus/msToken/verifyFp/x-signature`，这些由页面混淆 JS 现场计算。逆向既费时又随时失效。借页面环境发请求，抖音改版也不太受影响。

**能力**：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `douyin_feed` | 读 | 推荐流 |
| `douyin_detail` | 读 | 详情 + 评论 |
| `douyin_comments` | 读 | 只看评论 |
| `douyin_search` | 读 | 搜索 |
| `douyin_transcribe` | 读 | **听懂**（下载 + FunASR 转写） |
| `douyin_read_share` | 读 | **解析别人发来的分享链接** |
| `douyin_read_im` | 读 | **读私信 + 区分谁发的** |
| `douyin_comment` | 写 | 发评论 + @（UI 自动化） |
| `douyin_send_message` | 写 | 发私信（UI） |
| `douyin_share_video` | 写 | 分享视频（标准分享文案） |
| `douyin_conversations` | 读 | 会话列表 |
| `douyin_status` | 读 | 状态 |

**写操作为什么走 UI**：`commit/item/digg`（点赞）和 `comment/publish`（评论）都返回 `status_code=5 参数不合法`——服务端除签名外还有播放器上下文注入的字段。

**UI 自动化的四个关键坑**（详见 HANDOVER.md 4.11）。

### 1.3 `mcp-comfyui.js` — 画图（3 个工具）

`comfy_status` / `comfy_generate` / `comfy_free`。

工作流：UNETLoader + CLIPLoader(type `wan`) + VAELoader。每次生成后主动卸载 VRAM（8 GB 卡必须这么做）。

---

## 二、新增的核心模块

### 2.1 `src/song.mjs` — 点歌

**完整链路**：

```
歌名
 ↓ 自动加「清唱」搜索变体（清唱 / 无伴奏 / 纯人声 / 原词）
 ↓ B 站搜索（bilibili-api-python）
 ↓ 打分排序
 ↓ 校验标题含目标歌名（防「点雨爱唱出我不难过」）
 ↓ 下载（yt-dlp 抽音频）
 ↓ 音高检测（detect_pitch.py 自相关法）
 ↓ 偏男声？→ 回头找女声清唱版
 ↓ 返回 audioPath + 建议变调量
```

**打分规则**（`scoreItem`）：

```js
清唱/无伴奏/纯人声      +100   ← 唯一正解
弹唱（带吉他/钢琴）      +20   ← 次优
伴奏/纯音乐/KTV         -200   ← 禁用
教学/教程/谱子          -300   ← 直接排除
完整成品曲（Hi-res/MV） -120
超过 5 分钟              -80
时长 45-180 秒          +40
```

**为什么淘汰伴奏版**：人声和伴奏在频谱上重叠，分离时齿音和高频泛音一起被削掉，再走 RVC 就是二次损伤 → 成品发闷、发糊、听不清词。

**音高检测**（`detect_pitch.py`）：

自相关法估中位数基频（比平均值稳健）。

实测基准（麻勒勒本人）：
```
深夜电台 2026-05-17 → 258.1 Hz
哼谁再质疑我的实力  → 258.1 Hz
太能唠了            → 216.2 Hz
── 目标约 244 Hz
```

变调映射：
```python
f0 < 110  → +16 半音（低音男声）
f0 < 150  → +12 半音（男声）
f0 < 190  → +6  半音（偏低男声）
f0 < 215  → +2  半音（中性偏低）
f0 ≤ 285  → 0        （女声）
f0 ≤ 330  → -2  半音（偏高女声）
f0 > 330  → -4  半音（高音女声）
```

### 2.2 `src/sing.mjs` — RVC 音色转换

**分段机制**（`trimSegments`）：

```
每段最长 55 秒（留 5 秒余量给转码，不顶 QQ 60 秒上限）
段间连续无空档
最后一段 < 8 秒丢弃
最多 10 段
```

**`clipSec` 语义**：总共唱多少秒（不是单段长度）。

| 场景 | clipSec | 结果 |
|---|---|---|
| 唱几句 | 25 | 1 段 25 秒 |
| 唱一首 | 120 | 3 段：55+55+10 |
| 长一点 | 150 | 3 段：55+55+40 |

**显存管理**（`prepareGpu`）：

```js
1. 清掉残留的 rvc_infer / separate_vocals 进程
2. 查空闲显存（门槛 2200 MB —— 实测 RVC 峰值吃 2.6 GB）
3. 不够 → 调 ComfyUI /free 释放缓存 → 再查一次
4. 还够不上才报错
```

**为什么门槛是 2200 而不是 3500**：实测 2857 MB 空闲就能跑成功（峰值只剩 253 MB），原来设 3500 等于白白拦掉能跑的任务。

### 2.3 `src/voice-in.mjs` — 收语音转文字

**现状**：桥接原代码把语音显示成 `[语音]` 占位符，AI 完全不知道说了什么。

**链路**：
```
record 段（含 file/file_id）
 → OneBot get_record(out_format=wav) 拿 base64
 → 写临时 wav
 → FunASR 转写
 → 输出「[语音: 转写内容]」
 → 删临时文件
```

**设计要点**：转写失败退回 `[语音]`，不阻塞消息处理。

---

## 三、对 RVC 的配套改造

原版 RVC 有几个缺陷，本项目提供两个封装脚本绕过。

### 3.1 `RVC/rvc_infer.py`

**绕过的问题**：

| 问题 | 现象 | 解法 |
|---|---|---|
| argparse 冲突 | `configs/config.py` 在 import 时执行 `parse_args()`，截走命令行参数 | 改环境变量传参 |
| weight_root 未设 | `get_vc` 内部 `f'{os.getenv("weight_root")}/{sid}'` 拼出 `None/...` | 显式设环境变量 |
| rmvpe_root 未设 | `KeyError: 'rmvpe_root'` | 显式设 |
| **outside_index_root 未设** | `os.path.abspath(None)` 抛 TypeError | 显式设（哪怕指向同一目录） |
| 索引查找失败 | 写死 `startswith("malele")`，但实际文件名是 `added_IVF256_...malele_v2.index` | 改成 `"malele" in fn.lower()` |
| 返回值解包 | `vc_single` 返回 `(status, (sr, audio))` | 正确拆两层 |
| int16 当 float 写 | 输出全是杂音（RMS 0.99） | 检测 peak > 1.5 就除以 32768 |

**环境变量清单**（缺一不可）：

```python
os.environ["weight_root"]        = "assets/weights"
os.environ["index_root"]         = "logs"
os.environ["outside_index_root"] = "logs"      # 必须！否则 abspath(None) 崩溃
os.environ["rmvpe_root"]         = "assets/rmvpe"
```

**调用方式**：

```python
os.environ["RVC_SRC"] = 输入音频
os.environ["RVC_F0"]  = 变调半音数
os.environ["RVC_TAG"] = 输出文件名标记
subprocess.run([python, "rvc_infer.py"])
```

### 3.2 `RVC/separate_vocals.py`

**绕过的问题**：

| 问题 | 现象 | 解法 |
|---|---|---|
| 模型缓存目录 | `~/.cache/pymss` 是软链到 E 盘，写不进去 | 显式 `--model-dir` |
| 缺 ffmpeg | pymss 找不到系统 ffmpeg | 脚本内自动加 PATH |
| **显存不足报成编码错误** | `'utf-8' codec can't decode byte 0xbf` | cuda 失败自动回退 cpu |
| 类名记错 | `Separator` 实际叫 `MSSeparator` | 用 `from_model_name` |

### 3.3 `RVC/detect_pitch.py`

自相关法估基频中位数。用于判断男声/女声，决定变调量。

### 3.4 `RVC/build_malele_index.py`

**为已有 .pth 补生成 .index。**

```python
1. 切分原始音频（8 秒/段，44.1k 单声道）
2. HuBERT 提取 768 维特征（v2 模型）
3. faiss IVF256 索引
```

实测：826 段切片 → 823 段特征成功 → 30.1 MB index。

**为什么必须补**：没有 index，RVC 只能用 .pth 泛化，音色严重跑偏。

---

## 四、桥接的改动

### 4.1 `src/bridge.js` 新增

| 位置 | 改动 |
|---|---|
| `buildProactivePrompt` | 主动唤醒时注入 `pendingThought`（「想说但没说的话」） |
| `segmentsToText` 的 `case 'record'` | 语音转文字（原来只有 `[语音]` 占位符） |
| `forceRemoveLock` | 锁文件删不掉时重试 10 次 + 改名挪走（原来只试一次就 exit） |
| 主动消息参数 | `checkInterval 10-30min`、`probability 0.55`、`idleThreshold 8min` |

**`buildProactivePrompt` 的改造逻辑**：

```js
// 原来：安静了 → 掷骰子 → 随便开个话题
// 现在：优先读 pendingThought，有具体的事才开口

const pending = getSocialV2State(key)?.pendingThoughts
  .filter(t => !t.expiresAt || t.expiresAt > Date.now());

if (pending.length) {
  // 注入「你心里还惦记着的事」
} else {
  // 没记 pendingThought 时可以安静，别硬找话说
}
```

### 4.2 `qq-tool-restrict.mjs` 白名单

```js
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__comfyui__',
  'mcp__voice-say__',
  'mcp__douyin__',
]
```

**不在名单 = 静默 403。** 加新 MCP 必须同步这里。

### 4.3 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 新增段落

| 段落 | 内容 |
|---|---|
| 15b | 说说（最多 9 张图） |
| 15c | 说说评论 |
| 16 | 发语音（mood 参数） |
| 16b | 唱歌（点歌/换音色/搜素材三种用法） |
| 17 | 抖音（12 个工具的使用场景） |
| 主动找人的正确姿势 | pendingThought 机制 |
| 主动性的具体判断标准 | 五种该主动找人的情况 |
| 怎么"调用技能"才自然 | 语音/表情/分享/说说的自然用法 |

---

## 五、配套脚本（仓库外，需一并整理）

| 文件 | 位置 | 作用 |
|---|---|---|
| `launch.mjs` | 上级目录 | 统一服务启动器 |
| `svc-daemon.mjs` | 上级目录 | 看护进程（20s 巡检 5 个服务） |
| `重启DSH.bat` | 上级目录 | 重启脚本（轮询等端口释放） |
| `启动全部.bat` | 上级目录 | 一键启动 |
| `_health.mjs` | 本仓库 | 健康检查 |
| `sing_search.py` | 本仓库 src/ | B站搜索/下载 |

---

## 六、待办（给 codex）

### 6.1 必须先做

1. **清理硬编码绝对路径** —— 应使用可配置的用户安装目录。
2. **`bridge.js` 拆分** —— 663 KB 单文件，建议按职责拆成 `message-router` / `session-state` / `wake-scheduler` / `voice` 等模块
3. **补齐 `.env.example`** —— 把所有路径、端口、token 抽成模板
4. **单元测试** —— 目前几乎为零，优先补 `scoreItem` / `trimSegments` / `parseDuration` 这些纯函数

### 6.2 应该做

1. **SnowLuma Hook 退化检测** —— 一段时间收不到事件就自动重启 QQ
2. **统一错误信息** —— 现在很多错误误导（显存不足报成 UTF-8 错误）
3. **抖音 UI 选择器加固** —— 目前全靠坐标和 class，抖音改版就废
4. **配置校验** —— 启动时校验必填项，别等运行时才炸

### 6.3 可选

1. **真正接入歌声合成（SVS）** —— 现在是「换音色」，做不到「自由唱新歌」
2. **抖音画面理解** —— 现在只能读文字和口播，看不到画面
3. **长期记忆向量检索** —— 现在只有轻量 KV

---

## 七、发布前检查清单

- [ ] 清理所有 `.bak` 文件（已做，23 个）
- [ ] 清理临时脚本（已做，59 个）
- [ ] 删除 `state/`（含会话状态、日志）
- [ ] 删除 `config.json`（含 token）
- [ ] 删除训练素材（`麻勒勒-纯语音/`、`audio-ref/`）
- [ ] 检查 `.gitignore` 覆盖：`state/`、`config.json`、`*.log`、`*.bak`
- [ ] 替换硬编码路径为占位符
- [ ] 确认没有 token / 密钥泄漏（`grep -r "token\|secret\|key" src/`）
- [ ] README 补充新增能力的说明
- [ ] HANDOVER.md 随仓库发布（或放 docs/）

---

*本文档配合 HANDOVER.md 使用。前者讲「做了什么」，后者讲「为什么这么做、踩过哪些坑」。*
