# v0.1.4 后台构建与发布回执

核验日期：2026-10-22。范围：已推送源码、后台 Actions、公开五附件、完整下载摘要与新包签名评估。

- [公开测试版](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.4)，Release ID `420615113`，发布时间 2026-10-22T11:03:26Z。
- [Actions 39766317446](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39766317446) completed/success，verify、build、publish 全部成功。
- 标签 `v0.1.4` 指向 `cba5dc82941770f9decedc21e8777cfe5bbf9b7b`；通过 Git/SSH 与 GitHub 后台 API 核对，未使用浏览器页面或手动上传产物。
- 已发布 v0.1.3 标签保留；v0.1.4 补齐媒体重载后倍速重置的边界，不移动旧标签或覆盖旧附件。

[下载 macOS Apple Silicon DMG](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.4/Lingji-0.1.4-macos-arm64.dmg)。macOS 14.6+，应用 0.1.4，bundle 0.1.26。见[安装说明](../releases/v0.1.4-preview.md)。

## 附件与来源

五附件已完整下载并计算 SHA-256，文件大小与 GitHub API 的服务器摘要逐一相符；DMG 同时与 SHA256SUMS.txt、release.json 相符。

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| SHA256SUMS.txt | 95 | `5fa5add4474a3b9995fc7e013304a5158f4ed9978fe9ebbc9e4a1a7a78280353` |
| package-smoke.json | 389 | `e4392f15ee050cc58401b01a5fa3531a220bd5f99cfa52c8cc4aa7c0bbe49e8c` |
| INSTALL-macos-arm64.md | 3014 | `f0c13f0e1f57ab1c3c845f9da320507d34e658c46f41c2294ef191a13d977b79` |
| release.json | 37564 | `95ff0dce014116e2afb3a59f331d6174b79a1281f6671fd88ab07051d4a822c4` |
| Lingji-0.1.4-macos-arm64.dmg | 47457342 | `b594796843c5196efb728af25a164081df6a9e4278f47390254c211edbb867e6` |

221 个冻结源码文件逐一与标签计算摘要相符。构建来源包括已确认的 A 版单行播放器、前后 15 秒、拖动提交/取消、五档倍速、重试气泡，以及 load() 后恢复倍速的补丁。并行豆包原音纪要改造未进入此标签。

独立源码回归 **375/375**，播放器传输回归 **12/12**；Lint、类型、Web 构建与 116 份文档链接检查通过。CI 另行通过 Node/Rust 门禁与打包冒烟。实际 React + 双轨合成 WAV 的浏览器验证见[播放器证据](playback-a-trust-2026-10-22.md)。

## Apple 提示仍待解决

新 v0.1.4 DMG 只读挂载检查：应用版本与 bundle 相符，codesign 完整性通过；签名仍为 ad-hoc，没有 TeamIdentifier，Gatekeeper 执行评估 exit 3 / rejected。检查后已卸载该卷，未运行或安装应用。

**尚无 Apple Developer Program 账号，本轮未完成 Developer ID 签名或 Apple 公证，因此未消除首次打开的开发者验证提示。** [安全提示说明](../releases/macos-trust.md)提供官方单应用授权步骤及正式签名的前置条件。

真实用户 Mac、Tauri WebKit、真实长会议、蓝牙输出与全新机器首次安装仍未验，合成浏览器与 CI 冒烟不能代替这些证据。

[结构化回执](preview-v0.1.4-2026-10-22/verification.json)记录任务、附件摘要、源码与签名评估。
