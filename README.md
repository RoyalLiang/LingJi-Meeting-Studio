# TTS Platform

面向实时转录、实时翻译、会后纪要与 Live Share 的语音协作平台。

当前仓库用于从 0 到 1 搭建产品与工程基线，先完成以下三件事：

1. 把产品范围压缩到单一强场景。
2. 把实时会话链路拆成清晰服务边界。
3. 把文档、目录和后续代码落点对齐。

## 当前目标

`v1` 聚焦 `Windows + Zoom/Teams/Google Meet + 麦克风/系统音频` 场景，优先交付：

- 实时转录
- 实时翻译
- 浮动字幕
- 会话保存与回放
- Live Share 广播
- AI 会议纪要
- 术语表与参考资料增强

## 仓库结构

```text
.
|-- apps
|   |-- desktop            # Electron + React 桌面端，负责采集、字幕、录制控制
|   `-- web                # Web 端，负责会话列表、回放、Live Share viewer
|-- docs
|   |-- prd-v1.md          # 产品需求文档
|   |-- architecture-v1.md # 技术架构文档
|   `-- roadmap-90d.md     # 90 天实施路线图
|-- packages
|   |-- config             # 共享配置
|   `-- shared-types       # 会话、转录、翻译等共享类型
|-- services
|   |-- ai-worker          # AI 纪要、问答、索引任务
|   |-- session-gateway    # 实时音频接入、provider 编排、Live Share 分发
|   `-- transcript-api     # 业务 API、权限、会话管理、查询接口
|-- package.json
|-- pnpm-workspace.yaml
`-- tsconfig.base.json
```

## 文档入口

- `docs/prd-v1.md`
- `docs/prd-expansion-v2.md`
- `docs/architecture-v1.md`
- `docs/roadmap-90d.md`
- `docs/team-operating-model-v1.md`
- `docs/team-delivery-plan-v2.md`

## 当前原型链路

当前仓库已经包含一个不依赖第三方包的原型实现，用于先验证最短链路：

- `services/transcript-api`: 内存版会话、segment、share link API
- `services/session-gateway`: provider 化的 ASR 网关，当前支持 `mock` 和 `deepgram`
- `apps/web`: 浏览器原型页，支持创建 session、实时查看、回放、生成 share link，以及真实麦克风采集调试
- `apps/desktop`: desktop shell preview + CLI mock 客户端

## 本地启动

分别打开 3 个终端：

```bash
node ./services/transcript-api/src/server.mjs
node ./services/session-gateway/src/server.mjs
node ./apps/web/src/server.mjs
```

可选地再打开一个 desktop shell preview：

```bash
node ./apps/desktop/src/shell-server.mjs
```

也可以继续打开桌面 mock 客户端：

```bash
node ./apps/desktop/src/mock-client.mjs
```

或者直接通过根脚本启动：

```bash
npm.cmd run dev:desktop
npm.cmd run dev:desktop:mock
```

浏览器打开 `http://127.0.0.1:3000` 即可看到原型页。

桌面 mock 客户端支持两种输入：

- 直接输入英文句子：走 `POST /sessions/:id/ingest-text`
- 输入 `/file C:\\path\\sample.wav|hello world`：按 chunk 流式推送二进制音频到 `POST /sessions/:id/audio-chunks`

浏览器调试页当前支持：

- 创建 session
- 连接实时流
- 文本 ingest
- 设备枚举与麦克风权限申请
- 麦克风音频 chunk 采集
- 停止采集时附带 mock transcript hint 完成闭环

Desktop shell preview 当前支持：

- 服务地址配置
- session 创建、连接、停止
- gateway provider 状态显示
- 设备权限申请与设备枚举
- 麦克风采集与 chunk 发送
- 文件 chunk 上传和日志展示

## 测试

- `npm.cmd test`：运行 memory smoke tests
- `npm.cmd run test:postgres`：运行 Postgres smoke test

运行 Postgres smoke test 前，请确保：

- `docker compose up -d postgres`
- `DATABASE_URL` 指向本地 `tts` 库
- `RUN_POSTGRES_SMOKE=true`

## Postgres 模式

`transcript-api` 现在支持两种存储模式：

- `TRANSCRIPT_API_STORAGE=memory`：默认，零依赖快速验证
- `TRANSCRIPT_API_STORAGE=postgres`：真实数据库模式

建议启动顺序：

```bash
docker compose up -d postgres
npm.cmd install
set TRANSCRIPT_API_STORAGE=postgres
set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tts
node ./services/transcript-api/src/migrate.mjs
node ./services/transcript-api/src/server.mjs
```

如果你在 PowerShell 里运行环境变量，请改成：

```powershell
$env:TRANSCRIPT_API_STORAGE='postgres'
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/tts'
node .\services\transcript-api\src\migrate.mjs
```

## 真实 ASR Provider

当前 `session-gateway` 支持：

- `ASR_PROVIDER=mock`
- `ASR_PROVIDER=deepgram`
- `ASR_PROVIDER=doubao-ast`

启用 `deepgram` 时至少需要：

```powershell
$env:ASR_PROVIDER='deepgram'
$env:DEEPGRAM_API_KEY='your-key'
```

说明：

- `mock` 仍然是默认回归 provider
- `deepgram` 已完成 adapter 接入，但我还没有在当前环境里拿真实 key 跑线上请求验证
- 缺少 `DEEPGRAM_API_KEY` 时，网关会在启动阶段快速失败
- 可选配置 `ASR_FALLBACK_PROVIDER=mock`，让 `deepgram` 初始化失败时自动退回 mock provider

豆包同声传译 2.0 当前支持：

```powershell
$env:ASR_PROVIDER='doubao-ast'
$env:ASR_FALLBACK_PROVIDER='mock'
$env:DOUBAO_AST_APP_ID='your-app-id'
$env:DOUBAO_AST_APP_KEY='your-app-key'
$env:DOUBAO_AST_ACCESS_KEY='your-access-key'
$env:DOUBAO_AST_RESOURCE_ID='volc.service_type.10053'
```

说明：

- `doubao-ast` adapter 已接入 provider factory、fallback 和回归测试
- 当前仓库已经内置官方 proto 并使用 `protobufjs` 构建 Node codec
- `DOUBAO_AST_CODEC_MODULE` 现在是可选 override，不再是必填项
- 当前已用官方 `ast_go_client.zip` 里的 `test_audio.wav` 在本地完成 Node 侧在线打通
- 如果你继续扩展到音频回放型 `s2s` 体验，仍需要单独消费豆包返回的 TTS 音频事件

## 开发原则

- 单一 owner：每个关键结果只有一个直接负责人。
- 小步发布：先打透一条链路，再扩功能和平台。
- Provider 抽象：不把业务逻辑绑死在单一 ASR 或翻译厂商上。
- 隐私前置：录音、转录、翻译、分享全部围绕 consent 和保留策略设计。
- 质量内建：实时链路、延迟、准确率、回放一致性都要可观测。

## 下一步建议

1. 选定并接入一个真实流式 ASR provider adapter，替换当前 mock provider。
2. 把 desktop shell preview 演进成正式桌面壳，而不是继续扩大浏览器调试台职责。
3. 用真实会议样本建立内部 benchmark，先测延迟、丢段、术语命中率。
