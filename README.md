# TTS：浏览器中的实时转录与会议纪要

项目旨在提供通用、面向用户的实时语音转录、会议 AI 总结与纪要。首版方向已于 2026-10-11 确认为**浏览器优先、尽量免安装**。

当前仍是原型：Node API/网关、原始 HTML/JS 界面、mock/真实 provider adapter、内存及可选 Postgres 存储。AI worker 仍为占位；React/Tauri 与 Go 主链替换尚未完成。具体事实和验证边界见 [当前状态](docs/engineering/current-state.md)。

## 阅读设计与实践

从 [文档入口](docs/README.md) 开始，重点阅读：

- [DeepPage 官方研究](docs/research/deeppage-analysis-2026-10-11.md)：产品理念、能力、价格与公开信息边界。
- [产品设计](docs/design/product.md)：浏览器来源选择、可靠记录、可信纪要与用户流程。
- [系统架构](docs/design/architecture.md)：持久 ACK、转录修订、停止排空、引用与隐私。
- [最强大脑演练](docs/design/brain-rehearsal.md)：三个独立接口方案与故障挑战。
- [工程实践](docs/engineering/practices.md) 与 [路线图](docs/design/roadmap.md)：本地开发、验收与阶段退出条件。

旧文档保留作为历史材料；其中桌面优先、Next.js/WebSocket 等描述不能作为当前实现事实。新架构均为建议，不代表已实现或已部署。

## 本地运行原型

安装依赖：

```bash
npm ci
```

分别在三个终端运行：

```bash
npm run dev:api
```

```bash
npm run dev:gateway
```

```bash
npm run dev:web
```

访问 `http://127.0.0.1:3000`。默认是内存和 mock，用于本地开发。真实 ASR 需按 [.env.example](.env.example) 配置供应商；mock/fallback 行为不是生产录制成功的证据。

当前 Web 首页复用 desktop shell 文件。可选 `npm run dev:desktop` 提供 preview，但它不是已经发布的桌面安装包。标签页/屏幕音频仍需新增；浏览器权限和能力边界见产品设计。

## 验证边界

```bash
npm test
```

本轮本地 Node 回归：22 通过、0 失败。Go 实验在 `services/engine-go` 中运行 `go test ./...` 通过，目前只有领域包包含测试。`lint` 与 `typecheck` 仍是 TODO 占位。

未在本轮验证真实麦克风/共享音频、ASR/LLM、Postgres、长会话、部署或生产。Postgres 可选启动与配置见 transcript-api 原有说明；本轮没有执行数据库迁移。

## 规则与导航

[AGENTS.md](AGENTS.md) 与 `.agents/` 管理项目规则和最小上下文路由；[CONTEXT.md](CONTEXT.md) 统一领域词汇。GitHub Issues 已选定，远程仓库待提供，本轮没有外部工单操作。

CodeGraph 已建立本地索引，可使用：

```bash
codegraph status .
codegraph explore -p . 'SessionGatewayApp stopSession'
```

`.agent-runtime/` 保存 gitignored 本地检查与记忆；`.codegraph/` 的索引数据库也保持本地。保留现有未提交实现，不自动提交或部署。
