# macOS 首次打开与开发者验证

本页适用于本项目 GitHub Release 的 macOS Apple Silicon 测试包。预览构建采用 **ad-hoc 签名，未经 Developer ID 签名和 Apple 公证**。打包与完整性验证通过，不等于 Apple 已验证开发者。

从[官方 Release](https://github.com/RoyalLiang/lingji/releases/latest)获取对应版本，核对附件页面提供的摘要。确认来源后，按 [Apple 的单应用放行说明](https://support.apple.com/en-us/102445)操作：

1. 将应用拖到“应用程序”，尝试打开。
2. 打开“系统设置 → 隐私与安全性”，找到此应用的拦截提示。
3. 选择“仍要打开”，按系统要求确认。

这只为本机的该应用建立例外，不会为应用补做公证。不同 macOS 版本的提示可能不同。

正式签名渠道需要 Developer ID 身份、公证和装订验证，并在全新 Mac 验证首次打开。仓库的 `client-release.yml` 提供正式渠道；它与本次预览发布独立。证书、密码和公证凭据只放入加密 Secrets，不提交到 Git 或聊天。
