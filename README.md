# qq-dsh

QQ ↔ DeepSeek Harness Desktop 桥接。基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 MIT 项目及提供的增量代码整理，保留 QQ 会话、白名单、控制台、预设、MCP、图片、语音与可选扩展，重点完善配置、部署路径、媒体任务和发布测试。

QQ 消息经 SnowLuma / OneBot v11 到本桥接，再调用 DSH；是否发送回复受白名单、会话模式、工具令牌和发送限制约束。它不是独立大模型服务，需要使用者自己安装并登录 DSH 和 OneBot 网关。

## 本次完善

- 补齐压缩包缺失的 `public/console.html`，来自上游相同版本 `v0.2.0-r4`。
- 启动器改用当前 Node，不写死用户名、Node 安装路径、DSH 端口或媒体工具位置。
- 配置在启动前校验；错误不包含凭据原文；环境覆盖只在内存生效。
- RVC、ASR、ffmpeg、Python、抖音适配目录改为配置项，可选扩展缺失时给出说明。
- 提取媒体进程管理和点歌筛选模块；修复“无伴奏”误判、非法时长、异常播放量，以及 UTF-8 分块输出。
- 媒体任务限制输出、支持取消／超时；不再按命令行关键词批量杀其他 Python 进程。
- 安装器修复重复 MCP 行、旧的根节点 `[]`、带 `!!js` 标签和注释的 YAML 保留问题。
- 带本机路径的预设放入 DSH 私有运行目录，仓库只保存可移植模板；不再依赖已移除的 `{{cwd}}` 提示词变量。
- 新增离线回归与 CI；隐私检查的高置信凭据规则覆盖原本被整体跳过的核心文件。

## 安装

需要 **Node.js ≥22.13**、npm、已工作的 DSH Desktop 和 SnowLuma / OneBot v11 网关。仅处理代码和测试时不需要运行 QQ 或 DSH。

### 方式一：一键安装（推荐）

```powershell
git clone https://github.com/lsy0124/qq-dsh.git
cd qq-dsh
node scripts/install.mjs
```

Windows 用户也可以双击 **`安装.bat`**。

它会自动做：

```
1. 检查 Node 版本
2. 装依赖（npm ci / install）+ playwright-core
3. 创建 config.json（从模板，不覆盖已有）
4. 编译 agent preset
5. 挂载到 DSH profile
6. 跑完整体检，把缺的东西全列出来
```

装完会告诉你**还差什么、怎么补、影响哪个功能**。之后随时可以复查：

```powershell
node scripts/doctor-full.mjs       # 只看不缺什么
```

体检会自动发现 RVC / GPT-SoVITS / FFmpeg / Python 的路径（不要求它们在 PATH 里）。

### 方式二：手动安装

```powershell
git clone https://github.com/lsy0124/qq-dsh.git
cd qq-dsh
npm ci
npm run init
```

编辑本机的 `config.json`：

1. `dsh.baseUrl` 填 DSH 当前实际地址，示例端口不保证适用于你的安装。Desktop 默认凭据目录是 `%APPDATA%\dsh-desktop\harness`；使用其他目录时设置 `DSH_HOME`。
2. `snowluma.wsUrl`、`httpUrl`、`accessToken` 填自己的 OneBot 配置。
3. `ownerQQ` 填自己的管理员 QQ；`allow.private` / `allow.groups` 明确填允许的对象。**默认白名单为空，不回复任何 QQ。**
4. 若使用 WorkBuddy 等供应商，在 `dsh.provider` / `dsh.model` 填自己 DSH 中实际可用的值。

```powershell
npm run doctor
node scripts/setup-dsh.mjs web
```

安装器会修改所选 DSH profile、备份已有配置并挂载桥接插件，完成后重启 DSH Desktop。自动安装 bundle 的步骤需要可用的 `dsh` CLI；若只有 Desktop 内置 CLI，请按 [DSH 安装说明](docs/guides/DSH_SETUP.md) 确认目标 profile 的依赖已物化，不要拿全局旧 CLI 的成功冒充 Desktop 成功。

```powershell
npm start
```

也可双击 `start.bat`。默认控制台是 <http://127.0.0.1:3100/>，使用本机生成的控制台 token 授权。关闭前台终端会结束桥接。`node --env-file-if-exists=.env launch-bridge.mjs` 可选择后台启动，但显示 PID 只表示进程已创建，仍需检查日志和连接。

`restart.bat` 只会结束锁文件中且能核对为**这个仓库绝对入口**的 Node 进程。旧实例使用相对路径启动或 PID 身份无法确认时会停止操作，请在其终端手动结束；不会扫描并杀掉所有同名桥接。

## 可选功能

**AI 发语音默认关闭**。TTS、唱歌、ASR、ComfyUI 和抖音依赖自行安装的服务／适配代码，原压缩包不包含 RVC/ASR/抖音适配工程、模型权重、参考音频或账号 Cookie，下载仓库不等于这些功能已经可用。见 [语音与媒体配置](docs/guides/VOICE.md)。

独立语音工具 `voice-gui.mjs` / `voice-cli.mjs` 属于另一个 `voice-tool` 工程，不在本仓库；相关测试明确跳过。默认模板关闭主动发送和语音发送。抖音评论、私信写操作还需在其 MCP 进程中显式设置 `DOUYIN_ALLOW_WRITES=1`，桥接进程的 `.env` 不会自动传入已经运行的 DSH。

`config.json` 是供桥接和独立 MCP 共同读取的本机配置；`.env.example` 仅列出桥接进程支持的可选覆盖项。DSH 独立启动的 MCP 需配置自己的环境或读取本机配置，不能假设继承桥接终端的变量。

## 测试与验收

```powershell
npm test
npm run privacy-scan
```

`npm test` 运行核心单元测试及原项目的离线审计套件，只用临时文件和模拟服务，不向真实 QQ 发消息、不调用模型。没有独立 voice-tool 时，对应断言会明确跳过。安装包工具名核对是宿主集成检查，需要显式设置 `DSH_TOOL_PACKAGES` 指向实际目标 host 的 `@deepseek-ai` 目录；不能自动拿机器上的旧版全局 DSH 对账。

本次在 Windows / Node 24 上进行离线验证；**没有执行真实 QQ 收发、GPU 推理或模型端到端验收**。其他平台、Node 版本和 DSH 新协议仍需验证。验证结果见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 能力清单

桥接本身只负责消息路由。**下面这些能力全部通过 MCP server 挂给 DSH**，AI 按需调用。

### QQ（`mcp-snowluma-safe.js`，45 个工具）

| 类别 | 代表工具 |
|---|---|
| 消息 | `qq_send_message` / `qq_send_burst`（分多条带随机间隔）/ `qq_reply`（引用）/ `qq_send_poke` |
| 读取 | `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_wait_for_messages` |
| 群管理 | `qq_list_groups` / `qq_get_group_members` / `qq_get_active_members` |
| 资料 | `qq_set_signature` / `qq_set_profile` / `qq_set_avatar` / `qq_get_self_image` |
| 空间 | `qq_post_qzone`（最多 9 图）/ `qq_delete_qzone` / `qq_comment_qzone` |
| 表情 | `qq_list_stickers` / `qq_send_sticker` / `qq_collect_sticker` / `qq_sticker_note` |
| 语音 | `qq_send_voice`（发语音库文件）/ `qq_list_voices` |
| 记忆 | `qq_memory_append`（activeTopic / pendingThought / memberImpression）/ `qq_set_wake_config` |

### 抖音（`mcp-douyin.js`，18 个工具）

| 能力 | 工具 | 是否需要额外配置 |
|---|---|---|
| 读推荐流 / 详情 / 评论 / 搜索 | `douyin_feed` / `douyin_detail` / `douyin_comments` / `douyin_search` | Playwright + 浏览器 profile |
| **听懂口播**（下载 + ASR 转写） | `douyin_transcribe` | 需 FunASR |
| **解析别人发来的分享** | `douyin_read_share` | — |
| **读私信并区分谁发的** | `douyin_read_im` | — |
| **读 @ 提醒 / 评论回复** | `douyin_notifications` | — |
| **列评论 + 精准回复** | `douyin_comment_list` / `douyin_reply` | 写操作需 `DOUYIN_ALLOW_WRITES=1` |
| **发作品**（图文 / 视频 / 配乐） | `douyin_publish_images` / `douyin_publish` / `douyin_publish_auto` | 同上 |

> 抖音全部走**浏览器自动化**（不是逆向接口）。抖音每个 web 接口都要 `a_bogus` 签名，只能借页面环境发请求。写操作走 UI 自动化。
> 需要本机有可用的 Chromium 与抖音登录态；别人 clone 后这部分**代码可读但跑不起来**。

### 语音（`mcp-voice-say.js`，5 个工具）

| 工具 | 说明 | 依赖 |
|---|---|---|
| `qq_say` | 文本 → 语音条，支持情绪（soft/normal/lively/sleepy） | GPT-SoVITS + 参考音频 |
| `qq_sing` | 给音频换音色 | RVC + `.pth` + `.index` |
| `qq_song` | **点歌**：搜清唱素材 → 音高检测 → 自动变调 → 换音色 | bilibili-api + yt-dlp + RVC |
| `qq_song_search` | 只搜不下 | bilibili-api |
| `qq_tts_status` | 查 TTS 在线状态 | — |

> `clip_seconds` 是**总共唱多少秒**，不是单段长度。传 120 会自动切成 2-3 条语音（每段 ≤55 秒，不顶 QQ 60 秒上限）。

### 画图与视频（`mcp-comfyui.js`，7 个工具）

| 工具 | 说明 |
|---|---|
| `comfy_generate` | 文生图 |
| `comfy_video` | **文生视频**（Wan2.2），无声 mp4 |
| `comfy_status` / `comfy_free` | 状态 / 释放显存 |

> 视频很慢：720P/16fps 约 2 分钟出 1 秒。8 GB 卡默认 2 秒，工具会先查显存，不够直接拒绝。

### 联网搜索（`mcp-web-search-safe.js`）

`web_search` / `web_fetch`，带 SSRF 防护。

## 依赖清单（按必需程度）

### 必须

| 组件 | 用途 | 版本 |
|---|---|---|
| Node.js | 运行时 | ≥ 22.13 |
| DSH Desktop | Agent 运行时 | 0.2.0-rc.2 |
| SnowLuma | QQ 网关（OneBot v11） | 最新 |
| QQ NT | 被 Hook 注入 | — |

### 可选（缺失时对应能力不可用）

| 组件 | 影响的功能 | 备注 |
|---|---|---|
| Playwright + Chromium | 全部抖音能力 | `npx playwright install chromium` |
| 抖音登录态 | 同上 | 手动登录一次，profile 存本地 |
| GPT-SoVITS | `qq_say` 说话 | 需 8.75 秒参考音频 |
| RVC + 音色模型 | `qq_sing` / `qq_song` 唱歌 | 需 `.pth` + 配套 `.index` |
| bilibili-api-python | 点歌搜素材 | 建议单独 venv |
| yt-dlp | 下载音频 | |
| FFmpeg | 音频处理 | 需支持 h264 编码器 |
| FunASR | `douyin_transcribe` / 语音转文字 | GPT-SoVITS 自带 |
| ComfyUI | 画图 / 视频 | 需 Wan2.2 模型 |

## 启动顺序（顺序错了连不上）

```
1. QQ 客户端（登录）
2. SnowLuma（等到日志出现 "login detected"）
3. DSH Desktop（等端口就绪）
4. qq-bridge
```

## 已知问题

**SnowLuma Hook 会退化。** 表现为：进程活着、端口通、API 正常、`get_status` 心跳有，但**收不到任何 QQ 消息事件**。

这是外部依赖的缺陷，桥接无法自愈。唯一解是重启 QQ 让 SnowLuma 重新注入。

本仓库的 `bridge.js` 已加入 token 自愈重试（解决另一类「重启后必断」），但 Hook 退化需要外部巡检。参考实现见 `hook-watchdog.mjs`（不在仓库内，需要时可按 HANDOVER.md 的思路自建）。

## 项目资料

- [交接文档](HANDOVER.md) —— **架构图 + 18 个踩坑记录 + 部署步骤**（建议先读）
- [增量说明](CHANGES.md) —— 相对上游做了什么、每个工具的实现细节
- [给接手者](README-FOR-CODEX.md) —— 交付说明与优先事项
- [本次修改记录](docs/IMPROVEMENTS.md)
- [可选依赖与目录](docs/guides/VOICE.md)
- [原项目权限边界](RULES.md)
- [来源及许可证](THIRD_PARTY_NOTICES.md)
- [完整文档索引](docs/README.md)

原压缩包中的交接笔记保留在 `docs/ARCHIVE-*`，仅作为历史背景，其“已验证”“目录完整”和待办结论不等于本次验收。运行日志、缓存、个人路径、账号数据、音频素材和实际配置均不随仓库发布。

MIT License；保留上游版权与贡献者声明。
