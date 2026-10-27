# 聆记文档导航

[v0.1.29 纪要保留与紧凑阅读](releases/v0.1.29-preview.md) 正在完成发布前验证；v0.1.28原生冒烟失败，旧标签保留。

[v0.1.27 推理强度、回放与状态优化](releases/v0.1.27-preview.md) 已发布；[核验回执](evidence/preview-v0.1.27-2026-10-27.md) 记录四项 CI、十附件与来源验证，以及真实模型和硬件边界。

[产品与快速开始](../README.md) · [下载预览版](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases) · [问题反馈](https://github.com/RoyalLiang/LingJi-Meeting-Studio/issues)

按要完成的事情选择入口。已实现能力与待验证范围以[当前状态](engineering/current-state.md)和对应版本回执为准；设计稿与路线图表示目标，不自动代表已实现。

## 安装、配置与使用

| 目标 | 文档 |
| --- | --- |
| 安装桌面版、核对当前验证范围 | [v0.1.26 发布说明](releases/v0.1.26-preview.md) · [v0.1.24 交付证据](evidence/preview-v0.1.24-2026-10-26.md) |
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
