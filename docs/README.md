# 纪要导入与 Skill 发布方案探索（2026-10-30～31）

[可行性研究](research/minutes-feishu-skill-publishing-2026-10-30.md)、[统一导出、技能管理与流式聊天全流程预览](design/minutes-publishing-preview-2026-10-30.md)、[proposed ADR](adr/0017-minutes-publishing-skills.md)。仅研究与独立原型，尚未接入真实飞书、技能安装或 MCP 发布。

# v0.1.5 豆包音频纪要发布准备（2026-10-22）

豆包音频纪要 v0.1.5 已准备后台发布，见[安装与模型配置](releases/v0.1.5-preview.md)；实际发布状态以 Actions 和 Release 回执为准。

# v0.1.3 播放器与 macOS 安全提示说明（2026-10-22）

已按用户选择实现 A 版完整单行控制；新增跳转、拖动与倍速。正式 Developer ID 签名与 Apple 公证仍受账号缺失阻塞。见[安装说明](releases/v0.1.3-preview.md)、[安全提示](releases/macos-trust.md)和[本地验证](evidence/playback-a-trust-2026-10-22.md)。远端发布以 Actions 与发布回执为准。

# v0.1.2 长会议与恢复已发布（2026-10-22）

本轮已将两小时限制移除、单路音源故障隔离及 C 版界面纳入同一测试安装包，发布使用后台 GitHub Actions。见[安装说明](releases/v0.1.2-preview.md)与[修复验证](evidence/recording-unlimited-recovery-2026-10-22.md)。下文“仅本地/尚未发布”描述保留其历史时点；本轮已由 tag push 自动触发后台 Actions，三个任务成功，五附件完整下载及摘要相符，见[发布回执](evidence/preview-v0.1.2-2026-10-22.md)。

## 本地 Realtime 与长会议增量（2026-10-22）

新增可选 OpenAI Realtime 原音理解与并行转录留证，保留旧 ASR＋LLM；移除两小时累计样本与导入时长上限。见[启用说明](engineering/openai-realtime.md)、[本地验证](evidence/openai-realtime-2026-10-22.md)和[proposed ADR 0016](adr/0016-openai-realtime-minutes.md)。本地验证不代表真实供应商或长录制验收，尚未发布。

# 本地 C 版录音区增量（2026-10-22）

用户已确认 C「一体会议头部」。气泡提示、单行录音区、图标工具栏、齿轮设置和跨音源队列优化已实现并通过本地验证，见[验证与截图](evidence/compact-recording-c-2026-10-22.md)。当前公开 v0.1.1 不含本轮增量，尚无新安装包。

# 当前发布入口（2026-10-22）

- [v0.1.1 Actions 后台构建与发布验证](evidence/preview-v0.1.1-2026-10-22.md)：四项修复、公开五附件与完整下载校验。
- [产品首页与快速开始](../README.md)
- [v0.1.1 macOS 测试安装说明](releases/v0.1.1-preview.md)
- [会议收尾、提示条、创建时间排序和启动优化验证](evidence/meeting-lifecycle-startup-2026-10-22.md)
- [转录优化、标注与离线评估](engineering/asr-quality.md)
- [README 与 ASR 一手研究](research/readme-and-asr-quality-2026-10-21.md)
- 历史首发：[v0.1.0 发布验证](evidence/first-public-preview-2026-10-21.md)及[安装说明](releases/v0.1.0-preview.md)。

以下保留历史索引，带日期的历史验收结论仅对应当时版本。

# 项目文档入口

[Alpha 双任务学习与标注](engineering/alpha-learning.md)：Alpha 13 会后生成待标注结果，按会议和发言归组，人工确认后训练回测；尚无人工金标准，主转录未启用自动改写。

- [跨系统客户端实现方式](research/cross-platform-client-implementation-2026-10-13.md)：已按长期轻量与原生采集优先选择 Tauri 2/Rust；[运行说明](engineering/native-client.md)、[proposed ADR](adr/0011-native-desktop-client.md)与[首轮验证](evidence/client-brain-research/native-client-validation-2026-10-13.md)。三系统实体采集和正式发行仍待验。
- [GitHub 发版与客户端自动更新调研](research/git-release-and-client-updates-2026-10-13.md)：用户已选 GitHub Releases；已实现本地安全更新与四目标 draft/publish 工作流，见[客户端更新](engineering/client-updates.md)、[发版步骤](releases/github-client.md)和[本轮证据](evidence/client-brain-research/client-updater-validation-2026-10-13.md)；尚未远程发布或完成三系统正式安装验收。

- [跨平台客户端、性能与最强大脑演进调研](research/client-brain-evolution-2026-10-12.md)：当前代码、合成基准、端云分工与分层更新路线；[架构提议](adr/0010-cross-platform-brain-evolution.md)仍为 proposed，已按用户指令实施其中的 P0/P1；其他阶段未实施。
- [分阶段演进方案](design/evolution-plan-2026-10-12.md)：P0～P5 依赖、15 项本地任务、验收目标与迁移回退；首包为观测、投影、离线队列和分层终稿。

本轮新增：[服务与分析边界 ADR](adr/0005-provider-and-analysis-boundaries.md)、[开发账户与配置运行手册](engineering/runbook.md)、[真实合成 ASR 与界面验收](engineering/acceptance.md)。

更新日期：2026-10-12。产品目标：通用实时语音转录、会议 AI 总结与纪要；用户已确认**浏览器优先、尽量免安装**。全阶段工程首版已形成可运行闭环，环境退出门仍逐项保留。

先看 [当前智能纪要与实时翻译](engineering/intelligent-minutes.md)、[运行手册](engineering/runbook.md)、[实际 API](engineering/api.md)、[全阶段验收表](engineering/acceptance.md) 和 [本轮实现决策](adr/0004-record-workbench-implementation.md)。视觉依据见 [已确认方向](design/visual-direction.md)。

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

[P0/P1 本地实现与场景回归](evidence/client-brain-research/p0-p1-validation-2026-10-12.md)：EP-01～04、回退开关、合成基准与真实环境验证缺口。

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
- [工作台交互反馈](engineering/workbench-feedback.md)：设置保存 toast、Responses 默认值、显式分享系统音频、阅读跟随与备份错误反馈。
- [快速记录、暂停与结束会议](engineering/meeting-lifecycle.md)：可选标题、连续时间轴与紧凑音源摘要；主阅读区以当前智能纪要说明为准。
- [会议启动、连续主题树与标识候选](engineering/meeting-entry-and-brand.md)：双路自动接入、缺失来源引导与本机验收证据。

- [设置稳定性与转录术语验收](engineering/settings-quality.md)：地址原值、单层输入边框、显式关闭、无布局变化保存及本机登录恢复。

- [工作目录与历史会议分析](engineering/workspaces.md)：目录归档、统计口径、有来源的按需洞察、阅读控件与本地验收。

- [智能纪要主阅读区与实时翻译](engineering/intelligent-minutes.md)：当前讨论、可查来源的总结表格与图表、自动跟随，以及专用豆包翻译配置和验证边界。

## 豆包音频纪要本地接入

- [App 配置与验证边界](engineering/doubao-audio.md)
- [2026-10-22 真实接口与本地回归证据](evidence/doubao-audio-2026-10-22.md)
