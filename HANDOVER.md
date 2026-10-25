# DeepSeek Harness × QQ 接入项目 — 交接文档

> 本文档面向接手完善与开源发布的开发者。
> 目标：让 AI（DeepSeek Harness）住进 QQ，能聊天、发语音、唱歌、画图、刷抖音、看抖音私信。
> 本文档记录**做了什么、为什么这么做、踩过哪些坑、还有哪些没做完**。

---

## 一、项目定位

把 **DeepSeek Harness**（一个本地 AI Agent 运行环境）接入 QQ，使其成为一个有记忆、有情绪、能主动开口、还带实机能力的聊天对象。

核心不是「让 AI 回消息」，而是**让 AI 在 QQ 里像个人**：会说话、会发语音、会唱歌、会发表情、会发说说、会翻你的抖音。

### 技术栈总览

```
                    ┌─────────────────────────────────────┐
   用户 QQ 客户端 ──▶│  QQ 客户端（PC 版，被 Hook 注入）      │
                    └──────────────┬──────────────────────┘
                                   │ 内存注入（原生 vtable 层）
                    ┌──────────────▼──────────────────────┐
                    │  SnowLuma（OneBot v11 网关）          │
                    │  把 QQ 私有协议暴露成标准 HTTP/WS     │
                    │  端口：5099(WebUI) 3000(HTTP) 3001(WS)│
                    └──────────────┬──────────────────────┘
                                   │ OneBot v11
                    ┌──────────────▼──────────────────────┐
                    │  qq-bridge（本项目的核心）            │
                    │  · 消息路由 / 会话管理 / 唤醒调度      │
                    │  · 白名单 / 限流 / 敏感词              │
                    │  · 语音、唱歌、画图、抖音等能力编排     │
                    │  端口：3100                          │
                    └──────────────┬──────────────────────┘
                                   │ HTTP + SSE
                    ┌──────────────▼──────────────────────┐
                    │  DeepSeek Harness（DSH Desktop）      │
                    │  · Agent runtime，加载 preset/persona │
                    │  · MCP 客户端，挂载各种工具            │
                    │  端口：43129（Web GUI）               │
                    └──────────────┬──────────────────────┘
                                   │ MCP (stdio)
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
   snowluma-safe   voice-say    comfyui     douyin     web-search-safe
   （QQ 全套能力）  （语音/唱歌） （画图）    （抖音）    （联网搜索）
```

**关键设计**：能力全部拆成独立 MCP server，通过 stdio 挂载给 DSH。这样 AI 拿到的是「工具」，不是「接口」。

---

## 二、目录结构与文件职责

### 2.1 顶层结构

```
新建文件夹/
├── qq-bridge/              ★ 核心项目（要开源的就是这个）
├── SnowLuma/               QQ 网关（第三方，不属本项目）
├── GPT-SoVITS/             语音合成（第三方）
├── RVC/                    音色转换（第三方）
├── douyin/                 抖音自动化脚本（本项目配套）
├── launch.mjs              统一服务启动器
├── svc-daemon.mjs          看护进程（每 20s 巡检 5 个服务）
├── 重启DSH.bat             重启脚本（轮询等端口释放）
├── 启动全部.bat            一键启动全部服务
└── 麻勒勒-纯语音/           训练素材（109 分钟，用于 RVC index）
```

### 2.2 qq-bridge 内部

```
qq-bridge/
├── src/
│   ├── bridge.js                【663 KB】核心。消息路由、会话状态机、唤醒调度、
│   │                                      二代仿真逻辑、语音库、限流、敏感词
│   ├── mcp-snowluma-safe.js      【88 KB】QQ 全套能力 MCP（45 个工具）
│   ├── mcp-douyin.js             【22 KB】抖音 MCP（12 个工具）
│   ├── mcp-voice-say.js          【19 KB】语音合成 + 唱歌 MCP（5 个工具）
│   ├── mcp-comfyui.js            【15 KB】画图 MCP
│   ├── mcp-host-server.js         【5 KB】宿主能力 MCP
│   ├── mcp-web-search-safe.js     【4 KB】联网搜索 MCP
│   │
│   ├── sing.mjs                  【16 KB】RVC 音色转换（分段、显存管理）
│   ├── song.mjs                  【19 KB】点歌（B站搜素材、选清唱、音高检测）
│   ├── voice-in.mjs               【5 KB】收语音 → ASR 转文字
│   ├── sing_search.py             【3 KB】B站搜索/下载（走 bilibili-api）
│   │
│   ├── audio-quality.js          音频质量检查
│   ├── dsh-client.js             DSH HTTP/SSE 客户端
│   ├── forward.js                消息转发
│   ├── md-to-plain.js            Markdown 转纯文本
│   ├── media-lock.js             媒体并发锁
│   ├── model-prices.js           模型价格表
│   ├── preset-prompt.js          preset 提示词注入
│   ├── qq-model-view.js          模型视图
│   ├── role-card.js              角色卡
│   ├── safe-fetch.js             SSRF 防护的 fetch
│   ├── self-test.js              自检
│   ├── sensitive.js              敏感词
│   ├── slang-learner.js          群黑话学习
│   ├── snowluma-conn.js          SnowLuma 连接管理
│   ├── state-acl.mjs             状态文件权限
│   ├── sticker-lib.js            表情包库
│   ├── token-ledger.js           用量账本
│   ├── tts-core.js               TTS 核心
│   ├── v2-wait.js                二代仿真等待逻辑
│   ├── voice-core.js             语音合成核心
│   └── web-search.js             搜索核心
│
├── plugins/
│   ├── qq-agent-presets/         ★ DSH 插件：preset 注入 + 工具白名单
│   │   ├── index.mjs
│   │   ├── qq-tool-restrict.mjs  【关键】工具白名单（不在名单 = 静默 403）
│   │   └── presets/
│   │       ├── qq-chat.patch.yml
│   │       └── qq-chat-v2.patch.yml   【关键】完整的 AI 人格 + 能力说明
│   └── qq-mode-console/          控制台插件（WebUI）
│
├── dsh/agent-presets/
│   ├── qq-chat/                  一代（普通模式）
│   └── qq-chat-v2/               ★ 二代（仿真模式，主力）
│       ├── agent.cordis.yml      【关键】人格 + 工具说明的源文件
│       └── preset.yml
│
├── scripts/
│   ├── build-agent-preset-patches.mjs  【关键】把 agent.cordis.yml 编译成 patch
│   ├── tts-say.mjs                     TTS CLI
│   └── ...
├── audio/                        语音库（发出去的文件放这里）
├── audio-ref/                    参考音频（GPT-SoVITS 音色样本）
├── state/                        运行时状态（会话、锁、日志）
├── config.json                   【关键】主配置
└── launch-bridge.mjs             桥接启动器（带 DSH_HOME）
```

### 2.3 两代预设的区别

| | qq-chat（一代） | qq-chat-v2（二代，主力） |
|---|---|---|
| 消息发送 | 自动转发（AI 输出的文本直接发） | **必须显式调 qq_send_message** |
| 唤醒机制 | 简单轮询 | 沉睡/唤醒状态机 |
| 会话隔离 | 无 | 会话级 token |
| 适用 | 简单场景 | 生产环境 |

**二代的核心设计**：AI 输出的文本只是「思考」，不会自动发出去。要说话必须调工具。这样它才能决定「不接话」「分多条发」「带表情引用」。

---

## 三、核心能力清单

### 3.1 QQ 能力（mcp-snowluma-safe.js，45 个工具）

**消息类**
| 工具 | 说明 |
|---|---|
| `qq_send_message` | 统一发送，支持多段、@、引用 |
| `qq_send_private_message` | 私聊 |
| `qq_send_group_message` | 群聊 |
| `qq_send_burst` | 分多条发送（带随机间隔，真人感） |
| `qq_reply` | 引用回复 |
| `qq_send_poke` | 拍一拍 |
| `qq_get_unread_messages` | 读未读（带水位） |
| `qq_get_recent_messages` | 读最近消息 |
| `qq_get_message_detail` | 单条详情 |
| `qq_mark_read` | 标记已读 |
| `qq_wait_for_messages` | 等消息（reply/messages 两种用途） |

**群管理**
| 工具 | 说明 |
|---|---|
| `qq_list_groups` | 群列表 |
| `qq_get_group_members` | 群成员 |
| `qq_get_group_history` | 群历史 |
| `qq_get_active_members` | 活跃成员 |

**资料类**
| 工具 | 说明 |
|---|---|
| `qq_set_signature` | 改签名 |
| `qq_set_profile` | 改昵称 |
| `qq_set_avatar` | 改头像 |
| `qq_get_self_image` | 看自己的形象 |

**空间（说说）**
| 工具 | 说明 |
|---|---|
| `qq_post_qzone` | 发说说（最多 9 张图） |
| `qq_delete_qzone` | 删说说 |
| `qq_list_qzone` | 列表 |
| `qq_comment_qzone` | 评论 |
| `qq_qzone_detail` | 详情 + 全部评论 |

**表情**
| 工具 | 说明 |
|---|---|
| `qq_list_stickers` | 收藏列表 |
| `qq_send_sticker` | 发收藏表情 |
| `qq_collect_sticker` | 收藏别人的表情 |
| `qq_get_sticker_image` | 看表情长什么样 |
| `qq_sticker_note` | 给表情写备注（本地记忆） |

**语音**
| 工具 | 说明 |
|---|---|
| `qq_send_voice` | 发语音库里的文件 |
| `qq_list_voices` | 列出语音库 |

**记忆与状态**
| 工具 | 说明 |
|---|---|
| `qq_memory_append` | 记 activeTopic / pendingThought / memberImpression |
| `qq_memory_query` | 查记忆 |
| `qq_memory_remove` | 删记忆 |
| `qq_memory_clear` | 清空 |
| `qq_set_wake_config` | 设置唤醒条件 |
| `qq_social_state` | 会话状态 |
| `qq_get_prompt` | 当前提示词 |
| `qq_status` | 机器人状态 |
| `qq_slang_query` | 查群黑话 |
| `qq_slang_submit` | 提交陌生词 |
| `qq_get_forward_msg` | 读合并转发 |
| `qq_report_feedback` | 反馈问题 |

### 3.2 语音能力（mcp-voice-say.js，5 个工具）

| 工具 | 说明 |
|---|---|
| `qq_say` | 说话（文本→GPT-SoVITS→语音条） |
| `qq_tts_status` | TTS 状态 |
| `qq_sing` | 给音频文件换音色 |
| `qq_song` | **点歌**（歌名→自动搜素材→换音色→发出去） |
| `qq_song_search` | 只搜不下 |

**`qq_song` 的完整链路**：
```
歌名
 → B站搜索（自动加「清唱」变体）
 → 打分选材（清唱 +100，伴奏 -200，教学 -300）
 → 校验标题含歌名（防「点雨爱唱出我不难过」）
 → 下载（yt-dlp）
 → 音高检测（自相关法，判断男声/女声）
 → 是男声？→ 换女声版素材
 → 按音高自动变调
 → 分段裁剪（每段 ≤55 秒）
 → RVC 逐段转换
 → 响度归一化
 → 逐条发送（间隔 1.5 秒）
```

### 3.3 抖音能力（mcp-douyin.js，12 个工具）

| 工具 | 说明 |
|---|---|
| `douyin_feed` | 推荐流 |
| `douyin_detail` | 详情 + 评论 |
| `douyin_comments` | 只看评论 |
| `douyin_search` | 搜索 |
| `douyin_transcribe` | **听懂**（下载 + ASR 转写） |
| `douyin_comment` | 发评论 + @ |
| `douyin_send_message` | 发私信 |
| `douyin_share_video` | 分享视频（标准分享文案） |
| `douyin_conversations` | 会话列表 |
| `douyin_read_share` | **解析别人发来的分享链接** |
| `douyin_read_im` | **读私信内容 + 区分谁发的** |
| `douyin_status` | 状态 |

### 3.4 其他

| MCP | 工具 |
|---|---|
| `comfyui` | `comfy_status` / `comfy_generate` / `comfy_free` |
| `web-search-safe` | `web_search` / `web_fetch` |
| `snowluma-host` | 宿主能力（读文件等） |

---

## 四、关键设计决策（含踩坑记录）

这一节是最有价值的部分。**每个坑都花过真实时间。**

### 4.1 工具白名单必须手工同步（第一次踩）

**现象**：配置都对，AI 却说「工具不在白名单内」。

**原因**：`qq-tool-restrict.mjs` 里有个 `SAFE_PREFIXES` 数组，**执行期**才校验。不在名单 = 静默 403。

```js
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  'mcp__comfyui__',
  'mcp__voice-say__',
  'mcp__douyin__',      // 加新 MCP 必须在这里加前缀
]
```

**教训**：加新 MCP 要改 **4 个地方**：MCP 定义、白名单、preset 源、重新生成 patch。

### 4.2 preset 只在启动时加载（第二次踩）

**现象**：改了提示词，AI 行为没变。

**原因**：DSH 的 preset **只在进程启动时**读入 registry。而且 **QQ 会话是复用的** —— `state/sessions.json` 里存着 `private:xxx → session-id` 的映射。

**双重陷阱**：
1. 改 preset 不重启 → 不生效
2. 重启了但会话复用 → 还是旧 preset

**解法**：清空 `state/sessions.json` 的 sessions 映射，让会话重建。

### 4.3 MCP 重复启动（第三次踩，最隐蔽）

**现象**：每个 MCP 服务有 2 个进程；工具命名空间串了（出现过 `mcp__comfyui__tts_synthesize`）。

**原因**：同一个 MCP 在 **profile**（全局）和 **preset**（会话级）里各定义了一次，DSH 两份都加载。

**解法**：**只放在 preset 里**。profile 只留 `snowluma` / `snowluma-host` / `web-search-safe` 这三个全局的。

### 4.4 RVC 缺 index 导致音色跑偏（第四次踩）

**现象**：唱歌的声音完全不像说话的声音。

**原因**：`malele_e100_s6700.pth` 存在但**没有配套的 `.index`**。

RVC 的原理：
- `.pth` 学「怎么变声」（音高、大体走向）
- `.index` 学「目标音色具体长什么样」（特征检索库）

没有 index，只能用 `.pth` 泛化 → 音色严重跑偏。

**解法**：用 109 分钟原始语音重新生成：
```
切片 826 段（8 秒/段）
 → HuBERT 提取 768 维特征（823 段成功）
 → faiss IVF256 索引（30.1 MB）
```

**还有两个连锁 bug**：
1. 查找条件写死 `startswith("malele")`，但实际文件名是 `added_IVF256_..._malele_v2.index` → 永远匹配不到
2. `outside_index_root` 环境变量没设，RVC 内部 `os.path.abspath(None)` 崩溃

### 4.5 显存泄漏导致降级到 CPU（第五次踩）

**现象**：同样一段音频，有时 7 秒转完，有时 485 秒。

**原因**：`p.kill()` 只杀直接子进程，**Python 派生的 CUDA 子进程活下来继续占显存**。三次中断就能吃满 8 GB 卡，之后所有推理静默从 GPU 掉到 CPU。

**解法**：
```js
// 用 taskkill /T 杀整个进程树
spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
```

**外加**：每次跑重任务前自动清理残留 + 检查显存，不够就调 ComfyUI 的 `/free` 释放。

### 4.6 显存门槛定太高（第六次踩）

**实测数据**（8 GB 卡）：
```
转换前空闲 2857 MB → 峰值只剩 253 MB → 成功
实际吃掉 2604 MB
```

**所以门槛应该是 2200 MB，而不是我最初设的 3500 MB。** 设太高等于白白拦掉能跑的任务。

### 4.7 人声分离的误导性报错（第七次踩）

**现象**：报 `'utf-8' codec can't decode byte 0xbf`。

**真实原因**：**CUDA 显存不足**。错误信息完全是误导，浪费了大量时间往编码方向查。

**解法**：分离脚本内 cuda 失败自动回退 cpu。

### 4.8 锁文件删不掉就退出（第八次踩）

**现象**：重启桥接时反复打印「检测到过期锁文件，删除后重试」，七八次后进程消失。

**原因**：Windows 上文件被杀毒/索引短暂占用时 `unlinkSync` 抛 EPERM，原代码 `catch {}` 吞掉后**只重试一次**就 `exit(2)`。

**解法**：重试 10 次（每次 300ms），最后手段是**改名挪走**（同分区 rename 几乎总能成功）。

### 4.9 重启脚本等待时间不够（第九次踩）

**现象**：每次重启 DSH 都连不上。

**原因**：原脚本 `taskkill` 后只等 6 秒就启动新实例，但端口 43129 还要经历 TIME_WAIT，新实例抢不到端口。

**解法**：轮询等端口真正释放（最多 60 秒），启动后再轮询确认就绪（最多 90 秒）。

### 4.10 SnowLuma Hook 会退化（第十次踩，无解）

**现象**：一切显示正常（`connected=true`、`good=true`、进程活着、API 能调），但**收不到任何 QQ 消息**。

**原因**：SnowLuma 的内存注入句柄会随时间失效。表面上进程在、WebSocket 连着，但收不到 QQ 的数据流。

**唯一的解法**：**重启 QQ**，让 SnowLuma 重新注入。

**这是外部依赖的缺陷，本项目无法根治。** 建议加定期重启保活。

### 4.11 抖音写操作必须走 UI（第十一次踩）

**现象**：点赞/评论接口直接调返回 `status_code=5 参数不合法`。

**原因**：抖音的写接口有服务端强校验（除签名外还有播放器上下文注入的字段）。

**解法**：全部走 UI 自动化。

**但 UI 也有坑**：

| 操作 | 坑 | 解法 |
|---|---|---|
| 发评论 | 发送按钮**没有文字、没有 aria-label**，是编辑器右侧第三个 36×36 圆箭头 | 按坐标取最右 |
| @ 好友 | 点图标会失焦（@ 按钮变灰） | **直接输入 `@` 字符**触发候选 |
| 选好友 | DOM click 无效（React 不认合成事件） | **键盘 ↓ + Enter** |
| 读私信 | 抓到的元素是整块容器，center 全是面板中心 | **按头像位置（左/右）判断谁发的** |

### 4.12 抖音分享链接的三种形态

**必须都能解析**，否则 AI 看到的就是一串乱码：
```
① https://www.douyin.com/video/<id>
② https://v.douyin.com/<short>/            ← 需要跟 302
③ 4.35 :0pm cmd:/ 07/10 p@d.aN 标题... https://v.douyin.com/xxx/ 复制此链接...
```

### 4.13 唱歌的物理限制（重要，写进文档避免后来者返工）

**男声素材转女声必然失真。**

实测数据：
```
男声素材  179.8 Hz  → 需要升 6 半音
女声素材  285.7 Hz  → 微降 2 半音
目标音色  258.1 Hz（实测麻勒勒原始语音）
```

**为什么男声不行**：RVC 能抬**基频**，但抬不了**共振峰**。共振峰由声道长度决定，是物理属性。男声升调后变成「音调被拉高的女声 + 男声共鸣腔」。

**解法**：检测到男声素材时，**回头找女声清唱版**，而不是硬转。

### 4.14 唱歌和说话声音不一致（已知缺陷，未解决）

**原因**：两套完全不同的技术路径。

| | 说话 | 唱歌 |
|---|---|---|
| 技术 | GPT-SoVITS 零样本 | RVC 微调模型 |
| 声音来源 | **8.75 秒参考音频** | **109 分钟训练出的平均特征** |

而 109 分钟素材混杂了 7 种场景：
- 60 分钟深夜电台（气声、低语、手机麦）
- 22 分钟理性思维（另一种录音环境）
- 17 分钟 2025 电台（又一种）
- 6 分钟吐槽（大笑、高音）
- 3 分钟导航包（播音腔、后期处理）

**模型把五种完全不同的声音平均化了。**

**可能的解法**（未实施）：
- 只用单一场景素材重训（比如只用那 60 分钟电台）
- 或者用同一段参考音频同时驱动两个模型

---

## 五、配置文件说明

### 5.1 `config.json` 关键字段

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:43129",
    "provider": "workbuddy",
    "model": "deepseek-v4.1-flash",
    "reasoningEffort": "high"
  },
  "snowluma": {
    "httpUrl": "http://127.0.0.1:3000",
    "wsUrl": "ws://127.0.0.1:3001",
    "accessToken": "<OneBot token>"
  },
  "ownerQQ": <OWNER_QQ>,                    // 主人 QQ，用于主动通知
  "allow": {
    "private": [<OWNER_QQ>, <BOT_QQ>],    // 私聊白名单
    "groups": [<GROUP_ID_1>, <GROUP_ID_2>]      // 群白名单
  },
  "consolePort": 3100,
  "socialV2": {
    "enabled": true,
    "paused": false,
    "proactive": {                          // 主动找人
      "enabled": true,
      "checkIntervalMinMs": 600000,         // 10 分钟检查一次
      "checkIntervalMaxMs": 1800000,        // 最多 30 分钟
      "idleThresholdMs": 480000,            // 安静 8 分钟算「可以开口」
      "probability": 0.55                   // 55% 概率真的开口
    },
    "voice": {
      "enabled": true,
      "dir": "audio",
      "maxSeconds": 300,
      "maxBytes": 20971520,
      "maxPerMinute": 2,
      "maxPerHour": 10
    },
    "sticker": {
      "enabled": true,
      "maxListCount": 100,
      "includeInPrompt": true,
      "promptMaxStickers": 8,
      "collect": { "enabled": true, "maxPerMinute": 2, "maxPerHour": 10 }
    },
    "send": {
      "burstEnabled": true,
      "maxSendPerMinute": 10,
      "maxSendPerHour": 80,
      "burstIntervalMinMs": 800,
      "burstIntervalMaxMs": 2500
    }
  },
  "tts": {
    "baseUrl": "http://127.0.0.1:9880",
    "refAudio": "audio-ref/reference-zh.wav",
    "promptText": "礼物我得写还有所有没有写到礼物的宝贝..."
  }
}
```

### 5.2 `plugins/qq-agent-presets/qq-tool-restrict.mjs`

**工具白名单。不在这里的前缀会被静默拒绝。**

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

### 5.3 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`

**AI 的人格 + 工具使用说明。** 这是整个项目最需要打磨的文件。

结构：
```yaml
# 角色定位
# 说话风格（口语、有脾气、会拒绝）
# 工具使用规则（每个 MCP 怎么用）
# 记忆机制（pendingThought 主动触发）
# 等待与收尾规则
```

**改完必须跑** `node scripts/build-agent-preset-patches.mjs` 生成 patch。

---

## 六、部署步骤

### 6.1 依赖

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24+ | |
| DeepSeek Harness | 0.2.0-rc.2 | Desktop 版 |
| SnowLuma | 最新 | OneBot v11 网关 |
| QQ NT | 最新 | 会被 Hook 注入 |
| Python | 3.10+ | 语音、RVC、抖音脚本 |
| GPT-SoVITS | v2Pro | 语音合成 |
| RVC | 20260718 | 音色转换 |
| bilibili-api-python | 17.4+ | 点歌搜素材 |
| yt-dlp | 最新 | 下载音频 |

### 6.2 启动顺序（重要）

```
1. QQ 客户端（登录）
2. SnowLuma（自动注入，等待 "login detected"）
3. DSH Desktop（等端口 43129 就绪）
4. qq-bridge（等端口 3100）
```

**顺序错了会连不上。**

### 6.3 验证清单

```bash
# 1. 端口全通
3100 桥接 / 5099 SnowLuma / 3000,3001 OneBot / 43129 DSH

# 2. 桥接连通性
curl -H "x-console-token: <token>" http://127.0.0.1:3100/api/status
# 期望：connected=true online=true good=true

# 3. MCP 工具注册
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node src/mcp-douyin.js
# 期望：12 个 douyin_* 工具
```

---

## 七、已知问题与待办

### 7.1 必须修

| 问题 | 影响 | 建议 |
|---|---|---|
| **SnowLuma Hook 会退化** | 每隔几小时收不到消息 | 定期重启 QQ，或写退化检测 |
| **唱歌和说话音色不一致** | 明显割裂 | 用单一场景素材重训 RVC |
| **`bridge.js` 663 KB 单文件** | 难维护 | 拆分模块 |
| **`.bak` 文件散落** | 仓库脏 | 发布前清理 |
| **硬编码绝对路径** | 无法移植 | 全部改成配置项 |

### 7.2 应该改进

| 项 | 说明 |
|---|---|
| 配置校验 | 启动时校验 `config.json` 必填项，别等运行时才炸 |
| 错误提示 | 很多错误信息误导（如显存不足报成 UTF-8 错误） |
| 抖音 UI 选择器 | 全靠坐标和 class，抖音改版就废 |
| 测试 | 几乎没有单测 |
| 文档 | 大量设计意图只存在于提交历史和 `.bak` 文件里 |

### 7.3 可以加的能力

- 唱歌：真正接入歌声合成（DiffSinger/SVS），实现「自由唱新歌」
- 抖音：视频画面理解（抽帧 + 视觉模型）
- 记忆：长期记忆的向量检索（现在只有轻量 KV）

---

## 八、给接手者的建议

### 8.1 先跑通，再改

**不要一上来就重构。** 这套系统有大量「看起来可以合并、实际上分开才对」的设计，很多是因为踩过坑才那样写的。

建议顺序：
1. 按第六节跑通
2. 加日志，观察一整天的实际运行
3. 再动结构

### 8.2 那些注释别删

代码里的大量中文注释记录了**为什么这样做**。比如：

```js
// 为什么必须这么做：p.kill() 只杀直接子进程，Python 派生的 CUDA 上下文会活下来
// 继续占显存。实测三次中断就能吃满 8GB 卡，之后 RVC 从 GPU 掉到 CPU，
// 合成耗时从 7 秒变成 485 秒。
```

**删了下次还会踩。**

### 8.3 改 preset 的完整流程

```
1. 改 dsh/agent-presets/qq-chat-v2/agent.cordis.yml
2. node scripts/build-agent-preset-patches.mjs
3. 确认 plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml 更新了
4. 清空 state/sessions.json 的 sessions 映射
5. 重启 DSH
```

**漏任何一步都不生效。**

### 8.4 加新 MCP 的完整流程

```
1. 写 src/mcp-xxx.js
2. 在 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 加 MCP 定义
3. 在 plugins/qq-agent-presets/qq-tool-restrict.mjs 的 SAFE_PREFIXES 加前缀
4. node scripts/build-agent-preset-patches.mjs
5. 重启 DSH
```

**只放 preset，不要放 profile**（会重复启动）。

---

## 九、外部依赖说明

| 项目 | 用途 | 是否需改造 |
|---|---|---|
| **SnowLuma** | QQ 网关 | 否，直接用 |
| **DSH** | Agent runtime | 否，通过插件扩展 |
| **GPT-SoVITS** | 语音合成 | 否，HTTP 调用 |
| **RVC** | 音色转换 | **需要补 index**，见 4.4 |
| **ComfyUI** | 画图 | 否，HTTP 调用 |

**RVC 的改造是必须的**：本项目提供 `rvc_infer.py` 和 `separate_vocals.py` 两个封装脚本，绕过了原版 CLI 的多个缺陷（argparse 冲突、索引查找、显存管理）。

---

## 十、许可证与致谢

- 本项目代码：建议 MIT
- SnowLuma：遵循其原许可证
- GPT-SoVITS：MIT
- RVC：MIT
- 训练素材（麻勒勒语音）：**仅本地研究使用，不要随仓库分发**

---

*文档最后更新：见 git log*
*如果有问题，先看「四、关键设计决策」——大部分坑都在那里*
