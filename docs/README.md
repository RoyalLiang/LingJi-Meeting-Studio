# 聆记文档导航

[v0.1.45 树形层级与用量栏](releases/v0.1.45-preview.md)：保留主题背景、连续分支层级，移除供应商说明与明细标题；[布局证据](evidence/layout-v0.1.45-2026-10-29.md)，已发布，[五项 CI 与公开附件核验通过](evidence/preview-v0.1.45-2026-10-29.md)。

[v0.1.44 性能与界面修复](releases/v0.1.44-preview.md)：8 项实现、量测与验证边界见[本轮证据](evidence/performance-fixes-v0.1.44-2026-10-29.md)，已发布，[五项 CI 与公开附件核验通过](evidence/preview-v0.1.44-2026-10-29.md)。

[v0.1.43 性能与可靠性专家评审](evidence/performance-review-v0.1.43-2026-10-29.md)：四方向定点审查确认 8 项问题（3 P1、5 P2），含复现、反证与覆盖清单；对应修复见 v0.1.44。

[v0.1.43 录音保存与界面修复](releases/v0.1.43-preview.md)：已发布，五项CI与四个公开附件核验通过；[发布回执](evidence/preview-v0.1.43-2026-10-29.md)。[本轮证据](evidence/settings-v0.1.43-2026-10-29.md)。

[v0.1.42 纪要完整呈现与修订](releases/v0.1.42-preview.md)已发布，五项CI与四个公开附件核验通过；[发布回执](evidence/preview-v0.1.42-2026-10-29.md)。[调用链验证](evidence/minutes-completeness-v0.1.42-2026-10-29.md)。

[v0.1.41 纪要完整性与人工修订兼容](releases/v0.1.41-preview.md)已发布，五项CI与四个公开附件核验通过；[发布回执](evidence/preview-v0.1.41-2026-10-29.md)。[补充验证](evidence/minutes-completeness-v0.1.41-2026-10-29.md)。

[v0.1.40 纪要完整性与编号显示修复](releases/v0.1.40-preview.md)已发布，五项CI与四个公开附件核验通过；[发布回执](evidence/preview-v0.1.40-2026-10-29.md)。[修复说明](engineering/minutes-completeness.md)、[本地证据](evidence/minutes-completeness-v0.1.40-2026-10-29.md)。此前纪要样式与内容修复未获用户验收，本轮以具体失败路径重新验证。

[v0.1.39 录音与处理链路优化](releases/v0.1.39-preview.md)已发布，五项CI与公开附件核验通过；[发布回执](evidence/preview-v0.1.39-2026-10-28.md)；[恢复与进度说明](engineering/capture-reliability.md)、[本地证据](evidence/capture-reliability-v0.1.39-2026-10-28.md)、[自动起止研究](research/meeting-lifecycle-signals-2026-10-28.md)。

[v0.1.36 纪要效率与界面修复](releases/v0.1.36-preview.md)已发布，五项 CI 与公开附件核验通过；[发布回执](evidence/preview-v0.1.36-2026-10-28.md)；[配置与用量说明](engineering/minutes-efficiency.md)、[验证记录](evidence/minutes-efficiency-v0.1.36-2026-10-28.md)。

[v0.1.35 设置与转录界面优化](releases/v0.1.35-preview.md)已发布，五项 CI 与公开附件核验通过；[发布回执](evidence/preview-v0.1.35-2026-10-28.md)、[验证边界](evidence/settings-update-v0.1.35-2026-10-28.md)、[网络/离线词库研究](research/network-offline-vocabulary-2026-10-28.md)。

[多语种与词表纠错](engineering/multilingual-vocabulary.md)已随 v0.1.34 发布；[补充验证与回执](evidence/multilingual-vocabulary-2026-10-28.md)记录五语种、真实翻译闭环与人工修订保护。

[v0.1.34 波形与渲染优化](releases/v0.1.34-preview.md)已发布；[核验回执](evidence/preview-v0.1.34-2026-10-28.md)记录 565 项 Node、37 项 Rust、五项 CI 与四个公开附件。


[v0.1.31 回放与计时优化](releases/v0.1.31-preview.md)已发布；[核验回执](evidence/playback-timing-v0.1.31-2026-10-27.md)记录五项CI、三个安装包及源码归档核对。

[产品与快速开始](../README.md) · [下载预览版](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases) · [问题反馈](https://github.com/RoyalLiang/LingJi-Meeting-Studio/issues)

按要完成的事情选择入口。已实现能力与待验证范围以[当前状态](engineering/current-state.md)和对应版本回执为准；设计稿与路线图表示目标，不自动代表已实现。

## 安装、配置与使用

| 目标 | 文档 |
| --- | --- |
| 安装桌面版、核对当前验证范围 | [v0.1.36 安装说明](releases/v0.1.36-preview.md) |
| 处理 macOS 安装与系统信任提示 | [macOS 安装与信任](releases/macos-trust.md) |
| 使用内置 SenseVoice、选择云端转录或外部 FunASR | [本地转录与高级配置](engineering/funasr.md) |
| 配置豆包音频纪要 | [两种音频模式与权限](engineering/doubao-audio.md) |
| 配置 OpenAI Realtime | [音频直接理解与并行留证](engineering/openai-realtime.md) |
| 配置服务、部署、诊断与恢复 | [运行手册](engineering/runbook.md) |
| 使用时间线、表格、图表和翻译 | [智能纪要](engineering/intelligent-minutes.md) |
| 管理工作目录、历史记录与分析 | [工作目录](engineering/workspaces.md) |
| 改善专有名词与转录质量 | [识别质量与标注](engineering/asr-quality.md) |

## 开发、设计与验收

| 目标 | 文档 |
| --- | --- |
| 了解已实现能力、限制及证据截止点 | [当前状态](engineering/current-state.md) |
| 遵循实现、协议与验证约定 | [工程实践](engineering/practices.md) · [验收表](engineering/acceptance.md) |
| 了解纪要输入、流式输出与主题处理 | [会中纪要实现](engineering/live-minutes.md) |
| 了解设置、反馈与保存行为 | [设置质量](engineering/settings-quality.md) · [工作台反馈](engineering/workbench-feedback.md) |
| 核对纪要阅读与录音播放器设计 | [纪要阅读](design/minutes-reading.md) · [录音播放](design/recording-playback.md) |
| 了解会议入口与品牌设计 | [会议入口](engineering/meeting-entry-and-brand.md) |
| 构建、测试安装包与发布 | [预览版 Actions](releases/actions-preview.md) · [客户端发布](releases/github-client.md) |
| 查看更新机制及其约束 | [客户端更新](engineering/client-updates.md) |
| 查阅架构决策与后续目标 | [ADR](adr/) · [路线图](design/roadmap.md) |

## 发布与证据

- [v0.1.30会议修复](evidence/minutes-fixes-v0.1.30-2026-10-27.md) · [三平台发布核验](evidence/preview-v0.1.30-2026-10-27.md) · [v0.1.27回执](evidence/preview-v0.1.27-2026-10-27.md)。v0.1.28/v0.1.29失败标签保留，相关修正已包含在后续版本。

- [发布说明](releases/)：版本行为、安装方式和发布流程。
- [验收证据](evidence/)：源码版本、构建、公开附件校验与原生界面记录。
- [v0.1.22 回执](evidence/preview-v0.1.22-2026-10-26.md)：单窗口覆盖、胶囊暂停/继续、两分钟整理和异常重试；含十附件、原生与安装器证据及未验边界。
- [v0.1.17 回执](evidence/preview-v0.1.17-2026-10-25.md)：应用内置原生 SenseVoice 与安装器。
- [研究记录](research/)：方案依据与调研结论，不作为运行成功的证据。

## 项目规则与历史背景

工程规则从仓库 [AGENTS.md](../AGENTS.md) 开始，领域术语与决策约定见[领域文档约定](agents/domain.md)。

早期 PRD、架构和团队方案保留用于理解背景；其中技术选型与时间计划应结合当前实现重新评估。

| 材料 | 入口 |
| --- | --- |
| 早期产品需求 | [PRD v1](prd-v1.md) · [扩展需求](prd-expansion-v2.md) |
| 早期架构与运行时方案 | [架构 v1](architecture-v1.md) · [前端运行时 ADR](frontend-runtime-adr-v1.md) |
| 桌面迁移与迭代记录 | [Tauri 迁移计划](react-vite-tauri2-migration-plan-v1.md) · [迭代 3](iteration-3-adr.md) |
| 团队组织与历史排期 | [团队模型](team-operating-model-v1.md) · [交付计划](team-delivery-plan-v2.md) · [早期 90 天计划](roadmap-90d.md) |

## 维护这两份 README

根 README 介绍当前产品、快速开始和使用入口；本页负责文档导航。新增版本写入 `docs/releases/`，验证结果写入 `docs/evidence/`，能力与限制更新到 `engineering/current-state.md`。更新最近发布链接和受影响说明，不在 README 顶部持续叠加发版流水。

修改后运行 `npm run check:docs`；涉及命令、平台要求和模型方式时，同时核对当前源码、配置与发布附件。
