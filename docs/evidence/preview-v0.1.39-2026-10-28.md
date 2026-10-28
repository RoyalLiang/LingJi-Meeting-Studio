# v0.1.39 三平台发布核验回执

核验时间：2026-10-28T13:03:35.462Z。五项CI与四个公开附件核验通过。

源码与控制工作流 SHA：`bfce73a2c087713521794c402b1bf80e818af30f`。

注解标签 `v0.1.39`，标签对象 `1b6d10730be1d79195fec6c77c81422947ec5a17`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.39)。同轮回执只补记文档，不产生新版本。

## CI结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176/job/122816203822) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176/job/122816289031) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176/job/122816288982) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176/job/122816289041) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40688271176/job/122831006879) | success |

macOS完成DMG构建、校验与启动；Windows完成原生回归、后台录音/重启回放及安装验证；Linux完成DEB安装、启动和卸载。这些是GitHub-hosted CI证据，不能替代用户设备上的真实会议与原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.39-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.39/Lingji-0.1.39-macos-arm64.dmg) | 218407283 | `f9db1969423052b096df4fbbe098370ecc282cf3bfe58af6c9ef9f738fe0bf5c` |
| [Lingji-0.1.39-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.39/Lingji-0.1.39-windows-x64-setup.exe) | 407135429 | `be0df2552ef46c0ede0e7e8e4a3fc7b89d241fe2e27baf822c57b89b7d7733eb` |
| [Lingji-0.1.39-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.39/Lingji-0.1.39-linux-amd64.deb) | 221637282 | `6fef411f65462051a0029e1e938e1fb83132033cd84b37d2fd68bdfce6c9e79a` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.39/preview-update.json) | 6586 | `3104abb9eb6cf4edf8fd1c62acc41e580be0fbad10670a59795c462fe2a9057c` |

清单版本、源码SHA、三个安装包名称、下载地址、大小和摘要与公开Release一致。三个安装包HEAD=200且Content-Length一致。完整安装包未在本机再次下载并计算摘要；完整包校验由CI执行。

## Linux运行库

公开DEB范围读取HTTP206，读取5512字节；版本0.1.39，架构amd64。运行依赖：

`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`

## 验证与边界

[本地与完整页面证据](capture-reliability-v0.1.39-2026-10-28.md)：607项Node、独立可靠性9项与采集39项、Rust40/smoke41、lint/typecheck/build和212份文档检查通过。完整App连续刷新十次保持单份纪要，原有树形卡片样式保留。

本轮先发布并核验v0.1.37；v0.1.38因Linux资源准备失败未发布。v0.1.39保留这些标签并补齐即时错误与重复渲染修复。v0.1.38的唯一失败原因未取得原始日志确认；有限下载重试仍保留固定官方来源及SHA256验证。

真实70分钟会议及其唯一故障根因、真实ASR/LLM、三平台用户设备升级尚未验收。未确认的原生临时音频仍依赖进程存活，请在故障时保持应用开启。先备份并完成补传，再完全退出旧版安装本版。进程级存储隔离和会议自动起止仍是明确标记的建议。
