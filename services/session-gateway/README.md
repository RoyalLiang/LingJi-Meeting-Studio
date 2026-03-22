# Session Gateway

负责实时音频接入、ASR 编排、segment 标准化和实时广播。

## 责任边界

- WebSocket 会话管理
- 音频 chunk 接收
- ASR adapter 编排
- partial/final transcript 广播
- 与 Transcript API 的写入协作

## 首批实现顺序

1. session 连接鉴权
2. 音频流接收
3. mock ASR adapter
4. 标准化 segment 广播
5. final segment 落库

## 当前原型接口

- `GET /health`
- `GET /sessions/:id/stream`
- `POST /sessions/:id/ingest-text`
- `POST /sessions/:id/audio-chunks`
- `POST /sessions/:id/stop`

## 音频 chunk 接口约定

当前原型使用二进制 body，加请求头传 metadata：

- `Content-Type: application/octet-stream`
- `x-audio-chunk-id`
- `x-audio-sequence`
- `x-audio-encoding`
- `x-audio-sample-rate`
- `x-audio-channels`
- `x-audio-duration-ms`
- `x-audio-final`
- `x-source-language`
- `x-target-languages`
- `x-transcript-hint`

说明：

- `x-transcript-hint` 仅用于当前 mock ASR 原型，把音频 chunk 桥接成 transcript
- 当 `x-audio-final=true` 且存在 `x-transcript-hint` 时，网关会合成 final transcript 并写入 `transcript-api`

## 当前 Provider 结构

当前 `session-gateway` 已经抽出 provider 层：

- `src/providers/index.mjs`
- `src/providers/mock-asr-provider.mjs`

规则：

- 默认 provider 为 `mock`
- 可通过 `ASR_PROVIDER` 或 `createSessionGatewayServer({ asrProvider })` 选择 provider
- 不支持的 provider 会在启动阶段快速失败

### 已接入 Provider

- `mock`
  - 默认回归 provider
  - 支持文本 ingest 和 `transcript hint` 驱动的 audio chunk 闭环
- `deepgram`
  - 真实 WebSocket 实时 STT provider
  - 需要 `DEEPGRAM_API_KEY` 或 `ASR_API_KEY`
  - 当前已完成 adapter 接入与启动级配置校验
  - 尚未在本仓库内置真实线上凭证做自动化集成测试
- `doubao-ast`
  - 火山引擎同声传译 2.0 provider
  - 需要 `DOUBAO_AST_APP_KEY`、`DOUBAO_AST_ACCESS_KEY`
  - 可选 `DOUBAO_AST_APP_ID`
  - 当前已接入官方 proto，并通过官方 Go 示例里的 `test_audio.wav` 完成 Node 侧在线联调
  - 当前已打通 source subtitle / translation subtitle 文本链路
  - 当前尚未把返回的 TTS 音频事件持久化进产品层

### Fallback 策略

- 可通过 `ASR_FALLBACK_PROVIDER=mock` 启用 fallback
- 当主 provider 初始化失败时，gateway 会自动退回 fallback provider
- 当前回归已覆盖 `deepgram -> mock` 的启动级 fallback 路径
- 当前回归也已覆盖 `doubao-ast -> mock` 的启动级 fallback 路径
