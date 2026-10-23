# v0.1.14 发布验证

2026-10-23；后台发布完成。本轮最终推荐版本，包含旧会议主动重新整理兼容修复。

- 源码：`e5cf04e2ebc8a87c1417b2524c68f58fe2d78325`；标签 `v0.1.14` 保持该来源。远端 main 推送前已核对祖先关系，源码与标签原子推送；没有 force push 或移动已有标签。
- [Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39964988275)：verify、build、publish 全部 success；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.14) 于 `2026-10-23T14:06:37Z` 发布。
- [Apple Silicon 安装包](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.14/Lingji-0.1.14-macos-arm64.dmg)：47,473,448 字节，SHA-256 `70d02569f819abd2f193ee3427d41b1874923b819f1ffcc40002dc27c6058f57`。
- 独立重新下载五个附件；文件长度和 GitHub API SHA-256 均一致；校验和文件与 release.json 一致。冻结清单 231 个文件逐一与标签源码比对，清单摘要匹配。
- DMG 只读挂载、映像与 App 签名检查通过；arm64，App 0.1.14 / bundle 0.1.36，最低 macOS 14.6；ad-hoc 测试签名、未公证。
- 包内十个纪要关键模块与冻结源码逐字节一致；空临时数据目录中的包内 App 启动通过。原生私有页面代理正确拒绝缺少会话的请求。没有安装覆盖用户 App，也没有打开真实录音设备。

[下载与源码核验](preview-v0.1.14-2026-10-23/verification.json)、[独立包内验证](preview-v0.1.14-2026-10-23/package-local.json)、[后台发布回执](preview-v0.1.14-2026-10-23/publication.json)。功能与实际模型/原生界面验收见[本轮验证](minutes-quality-2026-10-23.md)。包内启动与 CI 不代替真实长会议、新机器安装和实际原音理解质量验证。
