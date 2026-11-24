# macOS TestFlight

macOS 商店版沿用 GitHub Actions 构建，由 Apple Distribution 签名应用、Mac Installer Distribution 签名 `.pkg`，上传 App Store Connect 后通过 TestFlight 安装和更新。安装后的名称为“聆记”，商店展示名为“聆记 LingJi”，Bundle ID 为 `com.tts.meeting`。

2026-11-24，产品 v0.3.39.1 的 TestFlight 构建 **0.3.39（166.1）** 已获 Apple 接受，完成出口合规确认并加入内部测试组；构建显示“准备测试”，仅账户持有人的邀请状态为“已邀请”。[正式流水](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/45302555949)的签名、沙盒检查和上传均已通过。真实 TestFlight 安装尚未验收，普通 DMG 的运行结果不能替代商店版验证。[Tauri 商店分发](https://v2.tauri.app/distribute/app-store/)、[Apple TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)。

## 使用商店版

商店版的数据保存在 macOS 为应用分配的沙盒容器中。内置 Node 后台继承应用沙盒，SQLite、本地转录和临时音频使用容器内目录。原音备份到容器外时，需要在系统目录选择器中重新选择目标目录；授权书签会在下次启动时恢复。目录移动、权限撤销或书签失效后，需要重新选择。

从 DMG 切换到 TestFlight 前，先结束录音并完成待保存音频，备份完整旧数据目录。两个渠道使用相同 Bundle ID；切换安装可能替换已有应用。旧 DMG 数据不会被自动删除，也不会自动复制到商店容器。若使用账户加密同步，应先确认同步完成，再在商店版登录同一账号恢复；不要把不含原音的 JSON 导出当作完整备份。

商店版的客户端更新由 TestFlight 管理，应用内不再下载或启动独立版安装包。会议导出继续保存到系统“下载”目录，应用为此声明 Downloads 读写权限。模型、转录和第三方服务仍使用各自配置，服务连接与录音权限分别授权。

## 配置签名与上传权限

Apple Developer 团队需要有效会员资格、已接受的 App Store Connect 条款，以及与 Bundle ID 对应的 macOS 应用记录。创建 Apple Distribution、Mac Installer Distribution 证书及 **Mac App Store Connect** 描述文件。描述文件的团队、App ID、有效期和分发证书必须匹配；不要套用 iOS 描述文件的 `beta-reports-active` 要求。

上传使用**团队 API 密钥**，授予 Developer 角色。工作流使用 Issuer ID 签发短期 JWT；个人 API 密钥的认证方式不同。首次 API 访问承诺、账号验证和新的法律条款由账户持有人处理。[App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)。

在仓库 Actions **Secrets** 中配置：

| 名称 | 内容 |
| --- | --- |
| `APPLE_APP_STORE_P12_BASE64` | 应用分发证书及私钥的加密 P12，Base64 编码 |
| `APPLE_APP_STORE_P12_PASSWORD` | 上述 P12 密码 |
| `APPLE_INSTALLER_P12_BASE64` | 安装器分发证书及私钥的加密 P12，Base64 编码 |
| `APPLE_INSTALLER_P12_PASSWORD` | 上述 P12 密码 |
| `APPLE_TESTFLIGHT_PROFILE_BASE64` | macOS 商店描述文件，Base64 编码 |
| `APPLE_API_PRIVATE_KEY` | 团队 API 密钥的完整 P8 PEM |

在仓库 Actions **Variables** 中配置 `APPLE_TEAM_ID`、`APPLE_APP_STORE_IDENTITY`、`APPLE_INSTALLER_IDENTITY`、`APPLE_APP_ID`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。签名身份填写证书的完整 Common Name，App ID 填 App Store Connect 的数字应用 ID。

私钥不进入 Git 或构建附件。签名工作流只在 GitHub 托管的 macOS runner 中创建临时钥匙串，完成后恢复原钥匙串搜索列表并清理凭证。证书或描述文件过期时更新对应 Secret，API 密钥撤销后重新配置。

## 构建与发布

`preview-release.yml` 在原有 macOS 构建中增加真实 App Sandbox 后台探针及商店包构建。主应用与继承沙盒的后台可执行文件分别使用对应 entitlement；所有 Mach-O 文件重新签名，清除派生应用的 quarantine 属性，再核验嵌套签名、团队、Bundle ID、描述文件和版本字段。

签名前只对派生 `.app` 规范目录和文件权限，保留可执行位且不跟随符号链接；签名后再次检查，避免包内文件仅 root 可读而被 Apple 以 `90255` 拒绝。私钥等签名输入保持私有权限。

产品版本继续使用 `X.Y.Z.R`。Apple 的显示版本为 `X.Y.Z`，构建号为该工作流的运行计数和重试次数；当前分别限制在 1–9999 和 1–99，超过前需调整编码。签名包回执包含固定源码和控制器 SHA、文件 SHA-256、描述文件 UUID 及 Xcode/SDK 版本。

先按[构建和发布](local-release-options.md)执行固定 SHA、`publish=false` 的全部候选检查。候选通过后才创建不可变版本标签并运行发布流水。正式流水下载同次构建的签名包，验证来源与摘要后上传，等待 Apple 返回有效构建；同一显示版本与构建号已存在时复用处理结果。上传失败不会把构建标成已交付。

上传成功与可供测试是不同状态。还需在 App Store Connect 核对出口合规问题、内部测试组和测试员可用性。外部测试需要额外的测试资料与 Beta App Review；发布到公开 Mac App Store 也需要独立提交，不由本流程自动完成。[上传构建](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)。

## 验证边界

本地沙盒探针验证内置 Node 启动、SQLite 写入与重开、真实离线 ASR 模型推理、容器外写入拒绝，以及系统目录选择后向已运行后台传递授权和重启恢复。这些结果不覆盖完整 Apple 签名应用的安装、真实麦克风与系统音频、外部供应商服务、旧 DMG 数据恢复和长会议；上述能力需要对应商店构建的单独证据。
