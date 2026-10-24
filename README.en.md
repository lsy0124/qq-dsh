# qq-dsh

A Windows-oriented QQ / OneBot v11 ↔ DeepSeek Harness Desktop bridge, based on the MIT-licensed [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) and a supplied extension snapshot.

This revision adds configuration validation, portable launch and media paths, bounded/cancellable media jobs, song-selection fixes, idempotent YAML setup, a restored upstream console, and offline tests. It preserves existing access controls and does not bundle private configuration or account data.

See the [Chinese README](README.md) for installation and the [validation report](docs/VALIDATION.md) for evidence boundaries. Run `npm ci`, `npm run init`, edit your own local config, run `npm run doctor`, configure your intended DSH profile with `node scripts/setup-dsh.mjs web`, restart DSH, then run `npm start`.

Node.js >=22.13, a working DSH host and a separately installed OneBot gateway are prerequisites. Optional TTS, RVC, ASR, ComfyUI and Douyin adapters require your own installations. No real QQ message, model completion or GPU task was executed during this publication pass.

`npm test` runs offline regressions. The default empty allowlist prevents QQ replies. Voice and proactive sending are disabled in the example config. Never commit config.json, .env, state, logs, audio or model files. Original authors and notices are retained in LICENSE and THIRD_PARTY_NOTICES.md.
