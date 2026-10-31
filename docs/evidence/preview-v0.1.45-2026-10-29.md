# v0.1.45 三平台发布核验回执

核验时间：2026-10-29T20:49:54.623000+08:00（Asia/Shanghai）。五项 CI 与四个公开附件核验通过。

源码与构建工作流 SHA：`e8f34d29176bcc93a4e149bca2e1b996baa16136`。
注解标签 `v0.1.45`，标签对象 `ce0ad961951bb9f12bd4cce9366077152bf702d6`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.45)。本回执只补记文档，不产生新版本。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596/job/123436854781) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596/job/123436949313) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596/job/123436949334) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596/job/123436949131) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40870749596/job/123454672930) | success |

macOS 完成 DMG 构建及原生回归；Windows 完成原生回归、后台录音/重启回放与安装器验证；Linux 完成 DEB 安装、启动与卸载。GitHub-hosted CI 不能替代用户设备真实长会议与原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.45-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.45/Lingji-0.1.45-macos-arm64.dmg) | 218419360 | `cd7fc51832dbd0490354b709a6ecf1bba152d927f8df406024cb50b1ae54d21c` |
| [Lingji-0.1.45-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.45/Lingji-0.1.45-windows-x64-setup.exe) | 407167903 | `e40f3c08be4c943037408408de8cfd43280c1b8a4c3e58a49867d012a4e0cd3d` |
| [Lingji-0.1.45-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.45/Lingji-0.1.45-linux-amd64.deb) | 221662914 | `1b4d7a9872c7e67cfa2671a80b0a64d60126bfef9ffd497946b37e99e516f794` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.45/preview-update.json) | 4394 | `4b5eba20b53dc02b62acfc5c99ad7fa5e0fce0d6d2bea115d09322f17d92b60e` |

清单版本、源码 SHA、三个安装包名称、地址、大小和摘要与公开 Release 一致。三个安装包 HEAD=200 且 Content-Length 一致。完整安装包未在本机重复下载计算摘要；完整包校验由 CI 执行。

## Linux 依赖

HTTP Range 读取 DEB 控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载 DEB。

## 本地修复与边界

[本轮证据](layout-v0.1.45-2026-10-29.md)：Node 668/668、lint、typecheck、build:web、check:docs 均通过。完整样式浏览器在 1280px 和 496px 断言通过：主题底色保留，主干连续、子卡片缩进、分支在背景后重叠 8px，正文居中且无横向溢出；供应商说明与用量明细标题已移除，实际 token 数值仍保留。此前 8 项性能修复的独立复审与量测仍见 v0.1.44 证据。

Windows 用户原机、原会议、真实 ASR/LLM、长会议录制、PG/S3 和实体故障未复验。完整 aggregate 压缩与序列化仍存在；不把 CI 和合成性能量测描述为现场所有卡顿已消除。

后续用户截图确认树形主干仍有 1px 横向错位，v0.1.46 追加修正；五项 CI 与附件校验不能替代像素布局验收。
