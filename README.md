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

## 项目资料

- [本次修改记录](docs/IMPROVEMENTS.md)
- [可选依赖与目录](docs/guides/VOICE.md)
- [原项目权限边界](RULES.md)
- [来源及许可证](THIRD_PARTY_NOTICES.md)
- [完整文档索引](docs/README.md)

原压缩包中的交接笔记保留在 `docs/ARCHIVE-*`，仅作为历史背景，其“已验证”“目录完整”和待办结论不等于本次验收。运行日志、缓存、个人路径、账号数据、音频素材和实际配置均不随仓库发布。

MIT License；保留上游版权与贡献者声明。
