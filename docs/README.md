# 项目文档入口

本轮新增：[服务与分析边界 ADR](adr/0005-provider-and-analysis-boundaries.md)、[开发账户与配置运行手册](engineering/runbook.md)、[真实合成 ASR 与界面验收](engineering/acceptance.md)。

更新日期：2026-10-12。产品目标：通用实时语音转录、会议 AI 总结与纪要；用户已确认**浏览器优先、尽量免安装**。全阶段工程首版已形成可运行闭环，环境退出门仍逐项保留。

先看 [运行手册](engineering/runbook.md)、[实际 API](engineering/api.md)、[全阶段验收表](engineering/acceptance.md) 和 [本轮实现决策](adr/0004-record-workbench-implementation.md)。视觉依据见 [已确认方向](design/visual-direction.md)。

## 按这个顺序阅读

1. [当前实现与验证边界](engineering/current-state.md)：先分清当前原型、实验和未实现能力。
2. [DeepPage 一手研究](research/deeppage-analysis-2026-10-11.md)：设计动机、功能、价格与配额、隐私、实现公开程度及数据缺口。
3. [产品设计](design/product.md)：首版用户流程、输入来源、范围与指标定义。
4. [领域词汇表](../CONTEXT.md)：Meeting Record、Session、转录版本、纪要和行动的词义。
5. [目标架构](design/architecture.md)：所有权、Web 采集、持久 ACK、停止屏障、版本与隐私。
6. [最强大脑演练](design/brain-rehearsal.md)：三种独立接口、取舍与七种失败场景。
7. [实现与验收实践](engineering/practices.md)：启动、CodeGraph、测试、质量、容量、成本与证据层级。
8. [阶段路线图](design/roadmap.md)：以退出条件推进，不把时间表当成果。
9. [ADR](adr/)：浏览器入口、可靠内容提交、版本化纪要，均标明提议状态。
10. [目标协议切片](design/protocol.md)：目标接口与失败分类；本轮实际接口使用 `/api/records`，实现范围以 [当前状态](engineering/current-state.md) 为准。

## 规则与工程技能配置

- [项目 AGENTS](../AGENTS.md) 与 `.agents/`：项目工作规则和按需加载路由。
- [任务跟踪](agents/issue-tracker.md)：GitHub Issues，仓库地址待提供，本轮没有外部写入。
- [标签约定](agents/triage-labels.md) 与 [领域文档约定](agents/domain.md)：用户已确认。
- `.agent-runtime/`：gitignored 本地状态和检查证据，不进入正式产品文档。
- [本轮计划](../task_plan.md)、[发现](../findings.md)、[进展](../progress.md)：本次整理的过程记录，不是长期架构事实来源。

- [说话人连续性](engineering/speaker-continuity.md)：持续连接、匿名编号复用、重连与未知身份边界。

## 历史文档保留作背景

| 文档 | 使用边界 |
| --- | --- |
| [PRD v1](prd-v1.md)、[扩展 v2](prd-expansion-v2.md) | 早期桌面/语言工作台需求；新首版范围见 product |
| [架构 v1](architecture-v1.md) | 含目标技术和 WebSocket 规划；现状以 current-state 为准 |
| [90 天路线](roadmap-90d.md) | 早期时间假设；新阶段退出条件见 roadmap |
| [前端运行时 ADR](frontend-runtime-adr-v1.md)、[Tauri 迁移计划](react-vite-tauri2-migration-plan-v1.md) | 旧桌面优先计划，不能作为当前已完成能力或 Web 首版选型批准 |
| [迭代 3](iteration-3-adr.md)、[团队模型](team-operating-model-v1.md)、[团队交付](team-delivery-plan-v2.md) | 历史工作组织设想，需结合最新实现和资源重新评估 |

不删除历史内容。本轮在历史文档顶部添加阅读边界，避免新旧方向混用；旧机器绝对路径链接已改为仓库相对链接，便于跨环境阅读。

## 会中 AI 纪要（2026-10-12）

- [飞书一手资料与方案](research/feishu-minutes-analysis-2026-10-12.md)
- [Responses、自动纪要、流式与主题实现](engineering/live-minutes.md)
- [增量纪要 ADR](adr/0006-live-minutes-and-protocols.md)

- [音源检测与智能纪要](engineering/capture-and-minutes.md)：双来源录音、静音提示、虚拟麦克风选择、主题树与发言人/决策视图。
