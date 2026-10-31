# v0.1.40 三平台发布核验回执

核验时间：2026-10-28T17:16:45.082Z。五项CI与四个公开附件核验通过。

源码与控制工作流SHA：`96517352a024cc88caa53a5e2fb9262fc4dc8b51`。

注解标签 `v0.1.40`，标签对象 `8c44226181bc30a849c88950382dab0beeebc697`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.40)。本回执只补记文档，不产生新版本。

## CI结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055/job/122955042342) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055/job/122955203687) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055/job/122955203464) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055/job/122955203625) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40727625055/job/122976658495) | success |

macOS完成DMG构建、校验与启动；Windows完成原生回归、后台录音/重启回放与安装验证；Linux完成DEB安装、启动及卸载。GitHub-hosted CI不能替代用户设备的真实长会议及原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.40-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.40/Lingji-0.1.40-macos-arm64.dmg) | 218411609 | `e58bd966466994612a05bf80e49f97ab081889ed5ce381b54f51e5a37c5297f3` |
| [Lingji-0.1.40-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.40/Lingji-0.1.40-windows-x64-setup.exe) | 407160393 | `3dd9d7e98dcfcf5597e9d6c714c68ecdad9381bc6392d419936cb4eb16402203` |
| [Lingji-0.1.40-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.40/Lingji-0.1.40-linux-amd64.deb) | 221644906 | `1f276ae0462fe3feafb490cb929a443d0b1257cc49cdbbce342c2e114df30359` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.40/preview-update.json) | 4571 | `756b122e0dbd9b5c97310cf8de3f3321f4ab94112f515b0c2ec9b22794e53a85` |

清单版本、源码SHA、三个安装包名称、地址、大小和摘要与公开Release一致。三个安装包HEAD=200且Content-Length一致。完整安装包未在本机重复下载计算摘要；完整包校验由CI执行。

## Linux依赖

使用HTTP Range读取DEB控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载DEB。

## 本地验证与边界

[本地证据](minutes-completeness-v0.1.40-2026-10-29.md)：Node628/628、独立定向71/71、lint、typecheck、build:web、文档及差异检查通过。虚构文本的实际模型和缓存修复保留60/60项数值；完整App核对三人编号、30行表格及窄屏。真实音频、用户原记录与70分钟现场会议尚未复验。旧短纪要需在对应会议重新整理；不会在升级后自动扩写。
