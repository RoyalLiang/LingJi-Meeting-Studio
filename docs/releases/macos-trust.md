# macOS 首次打开与开发者验证

核查日期：2026-10-22。本页适用于从本项目 GitHub Release 下载的 macOS Apple Silicon 测试包。

## 已核实的原因

v0.1.2 下载包摘要与公开附件一致；应用通过 `codesign --verify --deep --strict` 完整性检查，但签名是 ad-hoc，`TeamIdentifier` 未设置，Gatekeeper 执行评估返回 `rejected`。这能解释“无法验证开发者”或“无法检查是否包含恶意软件”，完整性通过不代表 Apple 已验证应用。

当前维护者尚无 Apple Developer Program 账号。v0.1.3 继续如实标记 **ad-hoc，未经 Developer ID 签名、未经 Apple 公证**。因此本轮没有消除 macOS 的首次打开拦截。

## 仅对可信测试包允许打开

先从本项目官方 Release 下载，并核对同版本 `SHA256SUMS.txt`。确认来源与摘要后，按 [Apple 的官方单应用步骤](https://support.apple.com/en-us/102445)：

1. 将应用拖到“应用程序”并尝试打开。
2. 打开“系统设置 → 隐私与安全性”，向下找到此应用被拦截的提示。
3. 选择“仍要打开”（Open Anyway），再确认“打开”，按系统要求认证。

此操作只为这台 Mac 的这一个应用建立例外，不会为应用补做公证。不同系统版本的文字可能略有差异，升级后也可能需要再次确认。

若提示“将损坏你的电脑”“包含恶意软件”或“已损坏”，不要沿用上述步骤强行打开；保留原文并重新核验下载。不要关闭全局 Gatekeeper，也不提供移除隔离属性的命令。

## 如何正式消除开发者验证提示

[Apple Developer ID](https://developer.apple.com/developer-id/) 与 [Apple 公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)要求使用有效的 Developer ID 分发身份并完成公证。免费开发者账户与 ad-hoc 签名不能代替这一流程，另见 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)。

具备 Apple Developer Program 账号后，管理员在 GitHub 的加密 Secrets / Variables 配置现有正式工作流需要的证书及公证凭据，再执行签名、公证、装订和 Gatekeeper 验收。仓库已有 `client-release.yml` 正式渠道与签名校验脚本；本轮未配置或运行这个渠道。证书私钥、导出密码和公证凭据不得提交到 Git 或发在聊天中。

正式验收需同时包含：Developer ID 证书链、codesign 完整性、stapler 校验、Gatekeeper 接受，以及一台全新 Mac 从网络下载后的首次打开。CI 打包成功、ad-hoc 完整性通过和手工授权都不能代替这些证据。
