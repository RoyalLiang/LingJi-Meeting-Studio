# P0 / P1 本地实现验证

本文件记录当前本地验证。真实浏览器采集、真实 ASR/LLM、Postgres/S3、生产部署和现场长会话需要分别验证。

## P0：诊断基线

- 已实现：`RECORD_TRACE_ENABLED=true` 开启服务端有界诊断，默认关闭；仅记录标识、耗时、字节、用量和状态。后台配置权限用户可读取 `/api/diagnostics/traces`。
- 浏览器通过 sessionStorage 的 `meeting-trace=1` 开启本地诊断。浏览器与服务端各使用自己的单调时钟，不能直接相减；HTTP trace ID 用于关联。
- 诊断不保存 PCM、转录、模型提示或凭据；sink 抛错不影响业务。分位数来自最近 512 条保留样本，不是全量统计或生产 SLA。
- 已接入 HTTP、聚合存储、音频 ACK、ASR 文本、纪要生成/用量及 UI 提交。队列指标随 P1 有界队列实现补齐。
- 当前本地验证：125 项 Node 回归通过，ESLint 和 Web TypeScript 检查通过。回归包含重复/冲突 ACK、断线、租约与停止排空等既有协议场景，不能替代现场录音。
