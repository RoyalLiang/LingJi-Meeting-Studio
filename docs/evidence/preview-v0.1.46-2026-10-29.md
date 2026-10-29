# v0.1.46 三平台发布核验回执

核验时间：2026-10-29T21:48:56.841000+08:00（Asia/Shanghai）。五项 CI 与四个公开附件核验通过。

源码与构建工作流 SHA：`f2c8d95ea679c1bad831649ffc1704ba62db2341`。
注解标签 `v0.1.46`，标签对象 `909851a2cb7fedc845cd8d1d3ca762a89e218a8e`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.46)。本回执只补记文档，不产生新版本。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851/job/123465088673) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851/job/123465236005) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851/job/123465236104) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851/job/123465236052) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40878977851/job/123485718331) | success |

macOS 完成 DMG 构建及原生回归；Windows 完成原生回归、后台录音/重启回放与安装器验证；Linux 完成 DEB 安装、启动与卸载。GitHub-hosted CI 不能替代用户设备真实长会议与原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.46-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.46/Lingji-0.1.46-macos-arm64.dmg) | 218421417 | `fc6a65e1c03e1e6a3e71468ddb5d8ba29713b6b03c5e04345be8f3e88084f842` |
| [Lingji-0.1.46-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.46/Lingji-0.1.46-windows-x64-setup.exe) | 407160374 | `6de4d66fb8d4d731e2729352c6ca734f4c19944d95b43dba3ebc938be1d03cb8` |
| [Lingji-0.1.46-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.46/Lingji-0.1.46-linux-amd64.deb) | 221667676 | `02a2a3c5a3d2d673c66900dbc564edf0c30e830b6796dea56ab694a0a0831558` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.46/preview-update.json) | 4262 | `4980e00217466d96958e81a69b5e6ee1fa34b81bd5296dac031a8b029a634934` |

清单版本、源码 SHA、三个安装包名称、地址、大小和摘要与公开 Release 一致。三个安装包 HEAD=200 且 Content-Length 一致。完整安装包未在本机重复下载计算摘要；完整包校验由 CI 执行。

## Linux 依赖

HTTP Range 读取 DEB 控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载 DEB。

## 本地修复与边界

[本轮证据](alignment-v0.1.46-2026-10-29.md)：Node 668/668、lint、typecheck、build:web、check:docs 均通过。实际浏览器先复现 summary 边框造成的 1px 原点偏移，再验证修复后 1280/496 下主干与弯头坐标差均为 0。独立复核覆盖 18 个 summary、普通、visual、table 及单子节点，无确认 P1/P2；CSS 哈希已核对。主题和小结背景、层级缩进、居中正文与实际用量数值均保留。此前 8 项性能修复的独立复审与量测仍见 v0.1.44 证据。

Windows 用户原机、原会议、真实 ASR/LLM、长会议录制、PG/S3 和实体故障未复验。完整 aggregate 压缩与序列化仍存在；不把 CI 和合成性能量测描述为现场所有卡顿已消除。
