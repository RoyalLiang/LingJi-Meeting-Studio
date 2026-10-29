# v0.1.44 三平台发布核验回执

核验时间：2026-10-29T20:31:03.630000+08:00（Asia/Shanghai）。五项 CI 与四个公开附件核验通过。

源码与构建工作流 SHA：`cc212a46aa5f008c7dc479536009e7f4d4946459`。
注解标签 `v0.1.44`，标签对象 `d4c13fa2f1af45852e3442225edc8c5f3e72bd3c`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.44)。本回执只补记文档，不产生新版本。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705/job/123427839609) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705/job/123427949786) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705/job/123427949890) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705/job/123427949764) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40868088705/job/123445750605) | success |

macOS 完成 DMG 构建及原生回归；Windows 完成原生回归、后台录音/重启回放与安装器验证；Linux 完成 DEB 安装、启动与卸载。GitHub-hosted CI 不能替代用户设备真实长会议与原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.44-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.44/Lingji-0.1.44-macos-arm64.dmg) | 218423582 | `474ca7f168f3b42619bc426d7da220d30e898a93aee3e0ad3655215832e105e7` |
| [Lingji-0.1.44-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.44/Lingji-0.1.44-windows-x64-setup.exe) | 407182762 | `d16d585b424cedd1dbcbeaa145ef0378eb6836f04ac6f0d909606f0c91faca9e` |
| [Lingji-0.1.44-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.44/Lingji-0.1.44-linux-amd64.deb) | 221667646 | `f2cffbd87de2e4141485137bb27ad1263cff404baf316ca91600fa24fb190b18` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.44/preview-update.json) | 5047 | `800312219987baad77caa2e0ebba3d32d8626268baa1b9b536cbde602e90ed1d` |

清单版本、源码 SHA、三个安装包名称、地址、大小和摘要与公开 Release 一致。三个安装包 HEAD=200 且 Content-Length 一致。完整安装包未在本机重复下载计算摘要；完整包校验由 CI 执行。

## Linux 依赖

HTTP Range 读取 DEB 控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载 DEB。

## 本地修复与边界

[本轮证据](performance-fixes-v0.1.44-2026-10-29.md)：8 项修复、Node 668/668、原生 43 通过/1 项既有真实更新源测试忽略、lint、typecheck、build:web、check:docs。三方向固定文件哈希独立复审无剩余已确认 P1/P2，前端实际源码浏览器 35/35；评审发现的草稿编号漂移已修复。树形主题标题底色、小结背景、此前分支连线及说话人位置已按用户澄清保留。

Windows 用户原机、原会议、真实 ASR/LLM、长会议录制、PG/S3 和实体故障未复验。完整 aggregate 压缩与序列化仍存在；不把 CI 和合成性能量测描述为现场所有卡顿已消除。
