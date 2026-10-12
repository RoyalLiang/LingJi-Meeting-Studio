# ADR 0010：跨平台能力分层与版本化大脑演进

状态：**proposed**。日期：2026-10-12。本文记录调研建议，尚未批准实施。

后续任务与退出条件见 [分阶段演进方案](../design/evolution-plan-2026-10-12.md)。用户已要求形成规划；该请求不将本 ADR 的实现或部署状态改为 accepted。

## 问题

当前主入口是 React/Vite Web，业务由 Record API/worker 承载。平台采集能力尚未形成完整真机矩阵；整份 Record JSON 更新和全量投影读取在合成基准中随会话长度增长。希望扩展客户端、模型与长期能力，但同时重写 UI、运行时和工作流会掩盖现有可靠性与证据缺口。

## 提议

保留浏览器优先和现有 React/TypeScript。以 CaptureAdapter、RecordClient、BrainService 作为共享边界；系统音频、后台录音和本地推理由能力适配器实现。桌面 Tauri 2/Electron、移动 Capacitor 通过实测门槛选型，不先认定赢家。

优先完成基线测量、增量投影/队列/任务调度和有预算的分层终稿。Record 协调后端保持写入权威；拆分 append 数据时仍要守住 record/session/source/epoch/sequence、内容 hash、持久 ACK、重传幂等、seal/排空、cursor、transcriptRevision 与删除 generation/fence。

大脑采用可恢复的任务工作流，以评测驱动模型路由、结构化记忆与检索。AI 候选保持来源版本，人工修改和授权由确定性边界保护；工具执行单独授权。当前 NeoHorse 实验不自动进入生产路由。

客户端、后端/协议、大脑策略、模型制品独立发布，任务固定版本组合。会中只预下载兼容制品，激活等待安全恢复点；签名、灰度、兼容迁移和回退须分别验收。离线缓存与已撤销记忆不因升级/降级丢失或复活。

## 取舍与重新评估条件

此方向复用当前投入，但增加投影、迁移与版本管理成本。暂缓全量 Go/Rust 重写、Flutter/React Native UI 重写、GraphRAG 和自主多 agent 执行；测量或新业务需求证明收益后重新评估。

若目标变为强制全离线、深度原生移动交互、浏览器无法满足的明确系统采集能力，应重开选型；移动 OS 对其他应用音频的限制不能靠框架规避。

## 验证与生效条件

目前只有本地隔离合成微基准和官方资料，不是生产容量或跨平台支持承诺。用户批准具体阶段后再实施；退出条件、源代码定位、指标与资料见[完整研究](../research/client-brain-evolution-2026-10-12.md)和[原始基准](../evidence/client-brain-research/aggregate-benchmark-2026-10-12.json)。
