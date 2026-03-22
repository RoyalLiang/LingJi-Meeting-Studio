# Iteration 3 ADR

- 状态：`Draft`
- 更新时间：`2026-03-19`

## 背景

当前仓库已经具备以下能力：

- `transcript-api` 支持 `memory / postgres`
- `session-gateway` 支持文本 ingest 和二进制 `audio-chunks`
- Web 调试台支持设备枚举、麦克风采集和 chunk 发送
- smoke tests 已覆盖 memory、postgres 和 invalid chunk

下一阶段的主要风险不再是“链路能不能跑通”，而是：

1. `session-gateway` 仍把 mock ASR 逻辑写在主服务里，真实 ASR 接入点不够清晰
2. `apps/desktop` 仍以 CLI mock 为主，缺乏正式桌面 UI 的收敛方向
3. 自动化回归尚未显式覆盖 provider 选择和 desktop shell 可用性

## 决策

### 1. 引入 ASR Provider Adapter

`session-gateway` 应该抽象为：

- `provider interface`
- `mock provider`
- `provider factory`
- `server integration`

约束：

- 默认 provider 仍为 `mock`
- provider 选择通过 env 或 options 注入
- 不支持的 provider 在启动时快速失败

### 2. Desktop 先做 Shell Preview，不急着上 Electron 依赖

`apps/desktop` 当前先交付一个最小桌面壳预演层，目标是固化以下状态机：

- session 创建
- 设备列表
- 采集开始 / 停止
- chunk 发送状态
- transcript / log 展示

原因：

- 当前环境已经有可运行的 Node 原型基础
- 先把状态机和交互骨架做清楚，比过早引入 Electron 依赖更稳
- 等真实 ASR provider 接入后，再决定 Electron 主进程 / preload 的最终落法

### 3. 测试继续以 Smoke Gate 为主

本轮不扩展大型测试体系，只补最小可靠门：

- provider 默认值
- unsupported provider 失败行为
- desktop shell preview 基础可用性

## 结果 Owner

- `Tech Lead`：维护这份 ADR，并负责集成时不偏离主线
- `Backend Expert`：负责 adapter 抽象
- `Frontend Expert`：负责 desktop shell preview
- `QA Automation Lead`：负责 smoke gate

## 完成标准

当以下条件同时满足时，本轮算完成：

1. `session-gateway` 已解耦 provider 实现与服务主逻辑
2. `apps/desktop` 具备最小壳层入口，不再只有 CLI mock
3. `npm.cmd test` 仍然通过
4. 若新增 provider / shell 相关测试，则这些测试默认可运行
