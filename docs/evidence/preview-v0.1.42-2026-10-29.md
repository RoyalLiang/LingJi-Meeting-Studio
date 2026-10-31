# v0.1.42 三平台发布核验回执

核验时间：2026-10-28T20:52:27.692Z。五项CI与四个公开附件核验通过。

源码与控制工作流SHA：`0adb0d7e68de539cff29a65596ca81b9ca6a05a9`。

注解标签 `v0.1.42`，标签对象 `f9e47d5333656a56b8b2ea2b42797f7bf0827b59`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.42)。本回执只补记文档，不产生新版本。

## CI结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746/job/123071874090) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746/job/123072016607) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746/job/123072016614) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746/job/123072016449) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40760798746/job/123092448462) | success |

macOS完成DMG构建、校验与启动；Windows完成原生回归、后台录音/重启回放与安装验证；Linux完成DEB安装、启动及卸载。GitHub-hosted CI不能替代用户设备的真实长会议及原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.42-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.42/Lingji-0.1.42-macos-arm64.dmg) | 218421093 | `096bb8930ef2be9010353680e5d510cd70a07d78ca1f1a411fe163befaaeeb6a` |
| [Lingji-0.1.42-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.42/Lingji-0.1.42-windows-x64-setup.exe) | 407188765 | `4837764eba8d2b5226d7a15c1ffba63a9770b98c53c26542c1b86e45d84b7207` |
| [Lingji-0.1.42-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.42/Lingji-0.1.42-linux-amd64.deb) | 221663868 | `6ecc29b9449aee4846d72288444e0acbeb8a080c289c91f72b0033a9ca59d9e1` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.42/preview-update.json) | 4971 | `06c5c8bc8d1f84aadfb01b6e00b383a96d3b6ff27d8d2fe2a579459126ed5ee9` |

清单版本、源码SHA、三个安装包名称、地址、大小和摘要与公开Release一致。三个安装包HEAD=200且Content-Length一致。完整安装包未在本机重复下载计算摘要；完整包校验由CI执行。

## Linux依赖

使用HTTP Range读取DEB控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载DEB。

## 本地验证与边界

[本地证据](minutes-completeness-v0.1.42-2026-10-29.md)：Node647/647、独立定向130/130及人工修订HTTP补充检查、lint、typecheck、build:web、文档及差异检查通过。虚构文本的实际模型和缓存修复保留60/60项数值；完整App核对三人编号、30行表格及窄屏。真实音频、用户原记录与70分钟现场会议尚未复验。旧短纪要需在对应会议重新整理；不会在升级后自动扩写。
