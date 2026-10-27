# v0.1.30 三平台预览版发布回执（2026-10-27）

公开发布时间：2026-10-27 19:50:09（Asia/Shanghai，UTC 2026-10-27T11:50:09Z）；独立核验截止：2026-10-27T11:58:38.944972+00:00。

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.30) · [Actions 40494259772](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772) · [安装与改动](../releases/v0.1.30-preview.md) · [结构化回执](preview-v0.1.30-2026-10-27.json)。

源码、工作流及远端标签提交均为 `46d45a8e71de0d821d34d098110a88825cc2ca03`，macOS build 为 `0.1.52`。远端 main 与标签已读回核对；回执补记不移动此标签、不重建安装包。

## 发布结果

| 任务 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155584899) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659059) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659066) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659220) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122171690724) | success |

Release 正文首段为版本改动与修复，包含下载、安装步骤、SHA-256、来源与验证边界。公开下载列表恰好五项：三个成品安装包，以及 GitHub 自动生成的 Source code ZIP/TAR.GZ。无测试 JSON、单独校验文件或安装文档附件；验证材料保留于 Actions artifacts（14 天），永久核验摘要保存在本回执。

## 完整下载与摘要

三个公开安装包均已完整下载；实际字节数与官方 Release API 的 size 一致，文件 SHA-256 同时匹配 Release 正文和官方 asset digest。

| 安装包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.30-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-macos-arm64.dmg) | 219565122 | `5f7370709fc680eeaf90c187fbdba56c9ece0a3ff7cd4c527874f36e8d5211df` |
| [Lingji-0.1.30-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-windows-x64-setup.exe) | 407698114 | `29e9e4de43ca3685425aa08dace7b74f43bb9fa27b8fd8397804fe40a61947a8` |
| [Lingji-0.1.30-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-linux-amd64.deb) | 222650826 | `ef6265a41053c1409fc965c25d1e8390526517ceeaaf144d9261d8b711972999` |

GitHub 标签源码 TAR.GZ 已逐项核对全部 **775 个 Git blob**，内容与上述提交一致；所下载归档 SHA-256 为 `413be72c1132dc44bfe99655a12c4c11da639c34af34e392acc2baf9f896e7bc`。ZIP/TAR.GZ 入口均指向 `v0.1.30`。

## 验证范围

- 本地 Node 24.21.0 完整回归 537/537、发布与原生定向回归 30/30、ESLint、Web 类型检查和构建通过。文档引用检查通过；独立复核覆盖发布差异与两项 CI 阻断修复，第三方 npm/Cargo 锁文件未改变。
- macOS：DMG、Apple Silicon 架构、签名结构、独立后台、隔离启动/重启与公开语音样例原生推理通过。
- Windows：两轮各六分钟隐藏合成录音及重启补传、NSIS 构建、静默和交互安装器检查、安装资源摘要、包内后台、模型选装、升级保留与卸载通过。
- Linux：Ubuntu 24.04 x64 上 Rust 原生回归、DEB 版本/架构、系统安装、全部打包资源摘要、Xvfb 下实际应用启动/重启、公开样例离线 ASR 推理与卸载通过。校验的是实际安装包，不以开发服务启动代替。

## 失败版本与边界

并发主线占用 `v0.1.28` 后，本轮先尝试 `v0.1.29`。Windows 测试探针沿用旧按钮序号，新增麦克风后误点；Linux Tauri 打包器缺 appindicator 库。两项均在真实 CI 失败后定点修复：原生探针改按实际无障碍名称点击，Linux 补官方构建依赖。JSX 回归先失败后通过，v0.1.30 的真实任务全部成功。失败标签保留，未公开其安装包。

Linux 实体声卡、PipeWire 采音、其他发行版/旧版系统兼容性、全新电脑交互安装、真实会议和云端 ASR/LLM 质量、PG/S3 与长会议仍未验收。macOS 为 ad-hoc 签名且未公证，Windows 未代码签名；Linux 不提供托盘常驻，关闭窗口进入退出确认流程。CI 与公开样例不替代实体环境验收。
