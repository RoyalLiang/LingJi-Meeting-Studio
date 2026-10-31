# v0.1.41 三平台发布核验回执

核验时间：2026-10-28T18:10:16.039Z。五项CI与四个公开附件核验通过。

源码与控制工作流SHA：`1d26e3ef14f1e011c61b3c7a512b17174609f867`。

注解标签 `v0.1.41`，标签对象 `028497ad001535be8fb06d86272a9470e842f9c7`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.41)。本回执只补记文档，不产生新版本。

## CI结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117/job/122981447900) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117/job/122981589132) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117/job/122981589141) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117/job/122981589028) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40735114117/job/123002605636) | success |

macOS完成DMG构建、校验与启动；Windows完成原生回归、后台录音/重启回放与安装验证；Linux完成DEB安装、启动及卸载。GitHub-hosted CI不能替代用户设备的真实长会议及原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.41-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.41/Lingji-0.1.41-macos-arm64.dmg) | 218406867 | `b69e8c29efccb31430e47e6d63f0ac98275ab77f0f261cab2dd2fb4dd47c9993` |
| [Lingji-0.1.41-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.41/Lingji-0.1.41-windows-x64-setup.exe) | 407089512 | `8678b27f1c18c98fbc3d3c8f9aad2643a4db568f4fcc1f78aa360f7b95de7fd3` |
| [Lingji-0.1.41-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.41/Lingji-0.1.41-linux-amd64.deb) | 221642844 | `86c1aa6ae847cd9a176de9618e8db9610f1557a32fe4d54ca75658a952cdc0eb` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.41/preview-update.json) | 4762 | `c2a855f49162f5ddcb9e63f80e6f72ddc43841e7ba6d72516f534e797c270bd3` |

清单版本、源码SHA、三个安装包名称、地址、大小和摘要与公开Release一致。三个安装包HEAD=200且Content-Length一致。完整安装包未在本机重复下载计算摘要；完整包校验由CI执行。

## Linux依赖

使用HTTP Range读取DEB控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载DEB。

## 本地验证与边界

[本地证据](minutes-completeness-v0.1.41-2026-10-29.md)：Node628/628、独立定向71/71及人工修订HTTP补充检查、lint、typecheck、build:web、文档及差异检查通过。虚构文本的实际模型和缓存修复保留60/60项数值；完整App核对三人编号、30行表格及窄屏。真实音频、用户原记录与70分钟现场会议尚未复验。旧短纪要需在对应会议重新整理；不会在升级后自动扩写。
