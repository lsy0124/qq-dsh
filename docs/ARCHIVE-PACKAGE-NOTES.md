> Historical source-package documentation. See the root README for current setup and validation limits.

# 交付包说明（给 codex）

> 这是一个可解压后直接审阅的代码包。本文档说明包里有什么、如何开始、以及哪些地方需要你重点处理。

---

## 一、这个包是什么

**QQ ↔ DeepSeek Harness 桥接项目**的一个完整工作副本，包含：

- 原始上游 `qq-bridge` 的全部代码
- 本项目新增的能力（语音、唱歌、抖音、画图、主动消息）
- 两份说明文档（`HANDOVER.md` / `CHANGES.md`）
- 一套配套脚本（服务启动、看护、重启）

**上游来源**：https://github.com/Derpyu520/qq-bridge
**本项目做的是 fork + 大量增量**，不是从零写的。

---

## 二、先读什么

按这个顺序：

| 顺序 | 文件 | 为什么 |
|---|---|---|
| 1 | `HANDOVER.md` | 整体架构、18 个踩坑记录、部署步骤 |
| 2 | `CHANGES.md` | 相对上游做了什么、待办清单 |
| 3 | `README.md` | 上游原有的说明（了解基础设计） |
| 4 | `docs/` | 上游的技术文档 |

**`HANDOVER.md` 第四节最重要** —— 那 18 个坑每个都花过真实时间，很多设计看起来奇怪就是因为踩过。

---

## 三、代码结构速览

```
qq-bridge/
├── HANDOVER.md          ★ 先读这个
├── CHANGES.md           ★ 再读这个
├── config.example.json  ← 配置模板（真实 config.json 已排除）
│
├── src/
│   ├── bridge.js                【663 KB】核心，最需要拆分
│   ├── mcp-snowluma-safe.js      QQ 能力（45 个工具）
│   ├── mcp-douyin.js             抖音（12 个工具）★新增
│   ├── mcp-voice-say.js          语音/唱歌（5 个工具）★新增
│   ├── mcp-comfyui.js            画图 ★新增
│   ├── mcp-host-server.js        宿主能力
│   ├── mcp-web-search-safe.js    联网搜索
│   │
│   ├── sing.mjs                  RVC 音色转换（分段、显存管理）★新增
│   ├── song.mjs                  点歌（B站搜素材、音高检测）★新增
│   ├── voice-in.mjs              收语音→ASR ★新增
│   └── sing_search.py            B站搜索/下载 ★新增
│
├── plugins/qq-agent-presets/
│   ├── qq-tool-restrict.mjs      【关键】工具白名单
│   └── presets/*.patch.yml       编译产物
│
├── dsh/agent-presets/qq-chat-v2/
│   └── agent.cordis.yml          【关键】AI 人格 + 工具说明（源文件）
│
└── scripts/build-agent-preset-patches.mjs   【关键】源文件→patch 的编译器
```

---

## 四、你接手后最该做的四件事

### 4.1 `bridge.js` 拆分（优先级最高）

**663 KB 单文件**，包含：消息路由、会话状态机、唤醒调度、二代仿真逻辑、语音库、限流、敏感词。

建议拆法：

```
src/bridge/
├── index.js            入口，组装各模块
├── message-router.js   消息接收、格式化、分发
├── session-state.js    会话状态机（沉睡/唤醒/繁忙）
├── wake-scheduler.js   定时唤醒、主动机会、回复检查
├── persona.js          二代仿真逻辑（文本不发出去，必须调工具）
├── voice-lib.js        语音库、发送限流
└── guard.js            白名单、敏感词、状态 ACL
```

**注意**：拆的时候保持行为不变，先补测试再拆。

### 4.2 补齐配置驱动

`config.json` 已排除，模板在 `config.example.json`。

**还需要做的**：

- 启动时校验必填项（现在缺了要到运行时才炸）
- `CHANGES.md` 里提到的 `paths` 段要真正被代码读取（目前 `song.mjs` 已读 `biliPython`，其他还没接）
- 写一份 `.env.example`

### 4.3 补单元测试

现在几乎为零。优先补这几个纯函数：

| 函数 | 文件 | 测什么 |
|---|---|---|
| `scoreItem` | `song.mjs` | 素材打分（清唱 +100、伴奏 -300） |
| `trimSegments` | `sing.mjs` | 分段逻辑（55 秒上限、8 秒丢弃） |
| `parseDuration` | `song.mjs` | "3:12" / "1:02:03" 解析 |
| `extractShareLink` | `douyin-reader.mjs` | 三种分享形态 |
| `forceRemoveLock` | `bridge.js` | 重试 + 改名挪走 |

### 4.4 统一错误信息

现在很多错误**极其误导**。典型例子：

```
显存不足 → 报 "'utf-8' codec can't decode byte 0xbf"
```

这个错误浪费了大量时间往编码方向查，实际是 CUDA OOM。

**建议**：所有底层异常都包装一层，把「真实原因」和「建议动作」写清楚。

---

## 五、包里没有什么（故意排除的）

| 排除项 | 原因 |
|---|---|
| `config.json` | 含真实 OneBot token、QQ 号 |
| `state/` | 会话状态、日志、token 账本 |
| `audio-ref/` | **真人语音参考片段（版权）** |
| `audio/` | 生成的语音文件 |
| `node_modules/` | 依赖，`pnpm install` 即可 |
| `*.bak` | 备份文件（已清理 23 个） |

**训练素材（109 分钟真人语音）不在包里，也不会发布。**

---

## 六、跑起来需要的外部依赖

| 组件 | 用途 | 备注 |
|---|---|---|
| Node.js 24+ | 运行时 | |
| DeepSeek Harness 0.2.0-rc.2 | Agent runtime | Desktop 版 |
| SnowLuma | QQ 网关（OneBot v11） | 第三方 |
| QQ NT | 会被 Hook 注入 | |
| Python 3.10+ | 语音/RVC/抖音脚本 | |
| GPT-SoVITS v2Pro | 语音合成 | |
| RVC 20260718 | 音色转换 | **需要补 index，见下** |
| bilibili-api-python 17.4+ | 点歌搜素材 | |
| yt-dlp | 下载音频 | |
| FunASR | ASR（GPT-SoVITS 自带） | 语音转文字 |

### RVC 必须做的改造

原版 RVC 有 7 个缺陷，本项目提供 `RVC/rvc_infer.py` 和 `RVC/separate_vocals.py` 绕过。

**这些脚本不在包里**（在上级目录的 `RVC/` 下），但 `CHANGES.md` 第三节完整记录了每个缺陷和解法。

**最关键的一条**：`outside_index_root` 环境变量必须设，否则 RVC 内部 `os.path.abspath(None)` 直接崩溃。

---

## 七、已知的严重问题

### 7.1 SnowLuma Hook 会退化（无解，需保活）

**现象**：一切显示正常（`connected=true`、`good=true`、进程活着、API 能调），但**收不到任何 QQ 消息**。

**原因**：SnowLuma 的内存注入句柄会随时间失效。

**唯一解法**：重启 QQ。

**建议**：加检测 —— 如果一段时间内完全没收到事件，自动重启 QQ。

### 7.2 唱歌和说话音色不一致（未解决）

**原因**：两套完全不同的技术路径。

| | 说话 | 唱歌 |
|---|---|---|
| 技术 | GPT-SoVITS 零样本 | RVC 微调模型 |
| 声音来源 | 8.75 秒参考音频 | 109 分钟训练出的平均特征 |

而 109 分钟素材混杂了 7 种录音场景（电台、导航包、吐槽、不同设备），模型把它们的**平均音色**学了出来。

**可能解法**：用单一场景素材重训。

### 7.3 抖音 UI 自动化脆弱

全靠坐标和 class 选择器，抖音改版就废。

**已经踩过的坑**（全在 `HANDOVER.md` 4.11）：
- 发送按钮没有文字、没有 aria-label
- @ 好友点图标会失焦 → 必须输入 `@` 字符
- 选好友 DOM click 无效 → 必须键盘 ↓ + Enter
- 读私信靠头像位置判断谁发的

---

## 八、发布到 GitHub 前的检查清单

- [ ] 确认 `config.json` / `state/` / `audio-ref/` / `audio/` 不在提交里
- [ ] `grep -r "<OWNER_QQ>\|<BOT_QQ>" .` 应该无结果
- [ ] `grep -r "D:\\\\Users\\\\" src/` 应该无结果（已处理完）
- [ ] README 顶部加一句「fork 自 Derpyu520/qq-bridge」
- [ ] 许可证：本项目 MIT，上游按其原许可证
- [ ] `.gitignore` 覆盖 `state/`、`config.json`、`*.log`、`*.bak`

---

## 九、一句话总结

**这是一个能跑的个人项目，但离「可维护的开源项目」还有距离。**

最需要你做的：**拆 `bridge.js`、补测试、统一错误信息**。

最有价值的部分：**`HANDOVER.md` 第四节那 18 个坑** —— 那是这个项目真正的技术积累。

---

*有任何看不懂的设计，先查 `HANDOVER.md` 第四节，八成在那里。*
