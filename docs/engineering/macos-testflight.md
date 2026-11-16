# macOS TestFlight 可行性

核查日期：2026-11-16。**官方支持当前 Tauri 技术栈，但本项目尚未具备直接上传即可分发的条件。** 当前 DMG 使用的签名和运行权限不能充当 TestFlight 验证证据。

Tauri 的官方路径是签名 `.app`、生成并签名 `.pkg`、上传 App Store Connect，再通过 TestFlight 测试。TestFlight 构建有效期为九十天；外部测试需要相应的 Beta App Review。[Tauri 商店分发](https://v2.tauri.app/distribute/app-store/)、[Apple TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

## 当前需要补齐的部分

- Apple Developer Program、App Store Connect 应用记录、Bundle ID、Team ID、分发证书和 provisioning profile，以及供 CI 使用的上传凭证。
- App Sandbox、主程序与内置 Node helper 的权限和逐层签名。Apple 允许嵌入命令行 helper，不能仅凭存在子进程就判定不兼容；当前 Node、SQLite 和本地 ASR 原生模块需要在真实签名沙盒中运行验证。[Apple helper 要求](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- 回环网络服务、真实麦克风/系统音频、按应用采集、停止排空和重启恢复。当前使用的 Core Audio taps 是 Apple 公开 API，仍不能据此推断其在本应用沙盒配置中已验证。[Apple Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- 用户选择的备份目录需要持久化的沙盒访问授权；现有路径字符串不等于重启后的访问权限。应用数据进入容器后的迁移也需要明确方案。[Apple 文件访问](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- 独立的 TestFlight 更新渠道，关闭该渠道中的外部 DMG 安装更新。

## 最小可执行路线

先做独立的签名沙盒验证构建，使用隔离的测试数据目录。确认内置后台、本地 ASR、音频采集、云端连接、保存与重启、目录授权都能工作，再接 App Store Connect 的内部 TestFlight。通过后再开放外部测试。

本轮交付可行性与实施边界，没有创建证书、上传构建、提交审核或生成 TestFlight 公测链接。原始研究与源码检查保存在 `.agent-runtime/tasks/20261116-proxy-testflight/testflight-research.md`。
