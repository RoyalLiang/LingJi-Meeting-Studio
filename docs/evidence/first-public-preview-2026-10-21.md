# v0.1.0 首次公开测试发布证据

核查日期：2026-10-21。范围：完整 README、ASR 请求修正与离线评估方案、源码和 macOS Apple Silicon 测试安装包。用户明确要求改由 GitHub Actions 构建与发布。

## 已核实的公开结果

- [Release v0.1.0](https://github.com/RoyalLiang/LingJi-MS/releases/tag/v0.1.0)：`draft=false`、`prerelease=true`，release id `419172424`，发布于北京时间 2026-10-21 14:05:26。
- [成功的 Actions run](https://github.com/RoyalLiang/LingJi-MS/actions/runs/39552320372)：verify、build、publish 均 success。
- 应用源码/tag：`ef9786c1e811acafc7c3fdda44fa180f81a675a8`。标签未移动；源码 ZIP/TAR 由 GitHub 根据该标签提供。
- 构建/发布工作流：`cf6110550a5fa47a28459ebe66dabd20becb2f51`。应用源码与控制发布的工具提交分别留证。
- 5 个显式上传附件均由 Actions 产出并发布；另有 GitHub 自动提供的 2 个源码归档。

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Lingji-0.1.0-macos-arm64.dmg` | 47432093 | `c2e749680967eb05f493d0ff8b919323a6932c5024b19856ebdaf6e69f37f90a` |
| `INSTALL-macos-arm64.md` | 3815 | `3881432c492c89f4292bb52bc03bae6e3d2cec5219a2d6b56b6e884b1eebb864` |
| `release.json` | 36882 | `334a1f9f11278cbb3f9227a4e5c41dd442625c73a34ef952ed83eaa20669380c` |
| `package-smoke.json` | 389 | `4292528f949f0c8180d472ac0189c4f9535d0f40151706efb713a57a54424708` |
| `SHA256SUMS.txt` | 95 | `9fe4724ff4cb2659acb76dbc8a6a95091a3306203b2865b5d43f348fa1c53a35` |

发布器逐项核对远端名称、状态、大小、摘要与完整集合后才发布。发布后另从公开下载地址取得上述五文件，实际字节与 GitHub digest 全部一致；安装包曾因本机链路超时使用 HTTP Range 续传，最后对完整 47,432,093 字节核对 SHA-256 通过。

公开 `release.json` 的 sourceRevision、ci.workflowSha、ci.runId 与上面的源码、工作流和 run 一致。CI 包与之前本机测试包不保证字节相同，应使用本次公开附件的校验文件。

## 验证层级

| 层级 | 结果与边界 |
| --- | --- |
| 本地源码 | 最新主分支的 329 项 Node 回归、ESLint、类型检查/Web 构建（应用阶段）、文档检查通过；发布器 6 项契约独立复核通过 |
| Actions 应用源码 | 冻结标签上的 323 项 Node 回归、21 项 Rust 测试、lint、类型、文档及 Web 构建通过 |
| 工作流 | actionlint 通过；verify 执行发布器测试，校验 tag 等于预期完整 SHA 且属于 main 历史 |
| 安装包 | macOS ARM、DMG 完整性、签名结构、`.DS_Store`、背景字节及源码冻结检查通过 |
| 包内独立后台 | Node 24.21.0 / SQLite 3.53.4；独立后台、本机账户、稳定 WebView profile、启动/重启持久化及父进程退出清理通过，开发后台请求为 0 |
| 外部读取 | 公开 Release 状态、五附件 digest、完整文件字节及来源元数据分别核验通过 |

首轮 [run 39549912292](https://github.com/RoyalLiang/LingJi-MS/actions/runs/39549912292) 在 Rust 编译时发现干净 checkout 缺少生成资源；工作流已改为原生测试前准备随包 Node/后台与 Web。第二轮 [run 39550698804](https://github.com/RoyalLiang/LingJi-MS/actions/runs/39550698804) 通过原生测试及 DMG 构建，但 Tauri 默认 CI 行为省略 Finder 布局；已使用官方 DMG CI 开关保留布局生成，未删除相关断言。第三轮上述成功 run 验证修复有效。操作方法见 [Actions 测试发布](../releases/actions-preview.md)。

## 尚未证明的事项

- ad-hoc 签名，未完成 Developer ID 签名与 Apple 公证；没有验证全新 Mac 的 Gatekeeper 首次安装。
- 没有打开真实音频设备、调用真实供应商或验证实体设备长会议、真实 ASR/LLM 质量、PG/S3、Windows/Linux 安装。
- ASR 请求协议和合成评估器回归不等于真实 CER 改善。尚无本轮人工金标准，不提供提升百分比；后续按[标注与评估方案](../engineering/asr-quality.md)进行同音频 A/B。
- 项目尚未指定开源许可证；公开源码不等于授权任意复用或再分发，README 已标明。
- 没有替换现有 Alpha、改写真实会议或开启 Chrome 文件网址权限。IDE 的既有未提交改动保留。

构建、发布与下载证据证明本次测试版本交付链路通过，不代表生产部署、真实会议质量或用户验收已经完成。
