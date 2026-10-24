# 可选语音与媒体依赖

**AI 发语音默认关闭**，默认是关的。启用前，明确选择自己的语音素材目录，在 `config.json` 同时打开 `socialV2.voice.enabled` 和 `socialV2.tools.sendVoice`。现有语音库发送与 TTS 动态合成是两条不同链路；先用当前桥接控制台的操作端预览，再进行自己授权的 QQ 验证。

TTS 需要自行安装 GPT-SoVITS 服务，配置 `tts.baseUrl`、自己的 `tts.refAudio` 和与参考音频逐字一致的 `tts.promptText`。本仓库没有附带音色、训练素材、音频模型或参考音频。程序能返回成功不代表音质合格，仍需实际试听。

路径统一配置在 `paths`：

| 字段 | 用途 |
| --- | --- |
| ffmpeg / ffprobe | 音频工具；空值从 PATH 查找 |
| biliPython | 安装了 bilibili-api-python 和 yt-dlp 的 Python |
| rvcDir | 你自己的 RVC 应用目录 |
| rvcScriptsDir | 放置 separate_vocals.py / detect_pitch.py 等扩展脚本的目录 |
| rvcPython | RVC Python 可执行文件 |
| rvcInferScript | 你自己的 rvc_infer.py |
| rvcOutputDir | 可选输出位置，默认本仓库 state/sing-work |
| asrPython / asrScript | 自行安装的 ASR Python 及转写适配脚本 |
| voiceLibrary | 语音库；默认 audio，与 socialV2.voice.dir 保持一致 |

`src/sing_search.py` 在仓库内；RVC 推理、分离、音高和 ASR 的外部适配脚本不在原压缩包中，因此不声称仅下载本仓库即可完成唱歌或转写。请只使用有权使用的素材和音色。

上游曾提供独立的图形界面 `voice-gui.mjs`、CLI `voice-cli.mjs` 和 `发语音-图形界面.cmd`。这些属于独立的 `voice-tool` 工程，本压缩包没有包含它，故本仓库不提供这三个入口，也不会将对应测试的跳过冒充功能通过。若已有该工具，可通过 `QQ_BRIDGE_VOICE_TOOL_DIR` 指定。

自动化回归只验证纯函数、mock 和临时音频；真实 QQ 语音、GPU 推理、唱歌音质仍需由使用者单独验收。
