# v0.1.24 已发布与核验（2026-10-26）

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.24) · [Actions 40332984046](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40332984046) · [安装与功能说明](../releases/v0.1.24-preview.md)

源码及标签固定为 `0a86d633ec28bed8444985b88e856c8b150ee834`，工作流 SHA 相同。main、独立分支与 v0.1.24 标签已原子推送。package、Tauri、Cargo 为 0.1.24，macOS build 0.1.46。公开发布时间 `2026-10-26T14:24:58Z`，独立验收时间 `2026-10-26T14:49:57.225Z`。

## 修复与验证

- 胶囊窗口 416×84 缩至 416×42，透明背景及关闭原生阴影；提前隐藏预热，渲染就绪后立即切换。主窗聚焦或恢复取消迟到切换，避免两窗并存。
- 修复 SSE 已完成但 HTTP 连接不关闭时继续等待 EOF 的问题，覆盖 Responses 与 Chat Completions。耗尽重试的中断任务明确失败；首次纪要显示已有实时草稿，人工编辑仍受保护。
- 独立绘制时钟平滑推进播放游标，静态波形避免每帧重建；暂停、拖动、键盘和倍速使用实际媒体定位。
- 本地 Node24 全回归 510/510、纪要专项 52/52、Rust 胶囊状态 3/3；ESLint、Web 类型检查、Web 构建及 170 篇 Markdown 检查通过。
- 隔离 Chrome 使用合成 WAV 与 100ms 量化媒体时钟：100 帧明显跳跃由 15 次降为 0；暂停、指针拖动、Home 键和 2× 通过。416×42 透明边界、按钮和键盘焦点通过。
- macOS 原生隔离冒烟包含冷就绪互斥、恢复、最小化后迟到就绪取消、42px 高度、隐藏录音和重启补传。发现并修复聚焦事件先于最小化状态刷新的真实时序问题。

## 后台结果

| 任务 | 结果 |
| --- | --- |
| verify（121606971354） | success |
| build（121607055319） | success |
| build_windows（121607055757） | success |
| publish（121628772246） | success |

Windows 原生回归、六分钟隐藏合成录音及重启补传通过；安装器静默安装、已安装应用探针、资源哈希、卸载与生产后台冒烟通过。macOS 隔离 DMG、签名和生产后台冒烟通过。两平台包内 SenseVoice 使用固定公开中文、英文与静音样本完成原生推理，nativeInference=true。

十个公开附件已独立完整下载并核对字节、GitHub 摘要和两平台校验清单。两平台来源清单与固定标签的 322 份文件逐字节一致，清单 SHA-256：`a512ea1e87baf89e0c6dcd8bcceb1b83230b78c2967299fd8d38994f45cb47cf`。

## 公开附件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.24-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/Lingji-0.1.24-macos-arm64.dmg) | 219571558 | `5485fe464719b4abdaea5e357b9eb128be799d762971efa7fc9e3a4957ca7d72` |
| [SHA256SUMS.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/SHA256SUMS.txt) | 96 | `7fea45e2d1d463361cade38569b117a4c4488eaba888e5452391b2e68dfb1f7d` |
| [release.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/release.json) | 54966 | `c7e27c3baa8e82d715bfd61bcefc4e84a44e52af0afd967f475ba90efd190883` |
| [INSTALL-macos-arm64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/INSTALL-macos-arm64.md) | 1919 | `8794cea9550d7bd977889664fd781eb1ef0cc828d523bcd676e16d522a7e1d89` |
| [package-smoke.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/package-smoke.json) | 421 | `4079c7625811bd823308a05f6c2aa84113256317b10b4f888cc230a459a6bc38` |
| [Lingji-0.1.24-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/Lingji-0.1.24-windows-x64-setup.exe) | 407641876 | `4ba85be0da4118f683034d71e2c33fb623683296be6000e1cab169b2a9048571` |
| [SHA256SUMS-windows-x64.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/SHA256SUMS-windows-x64.txt) | 102 | `3d76e6cd4984b6d8abe1794a06b75031f8b1b45f1aa2ebf7af4881a9e7ccaf25` |
| [release-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/release-windows-x64.json) | 54583 | `1c2ffd6978362abb19fab0caa2f7b52a996d82a971b34e6f5a6c59434aed5475` |
| [INSTALL-windows-x64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/INSTALL-windows-x64.md) | 3110 | `a246d95ff88936fad9d48db8bfd93c1128b541770fab121db692107e5e58c551` |
| [package-smoke-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.24/package-smoke-windows-x64.json) | 421 | `1ca5482d9b5343fcd811e4412b751c187b703ea049e53a2f2157eb6188296c91` |

## GitHub Issues

按用户要求在修复后检查 [仓库 Issues](https://github.com/RoyalLiang/LingJi-Meeting-Studio/issues)。Issue 功能已开启；全状态列表与搜索均为 0，搜索 incomplete_results=false。发布后于 `2026-10-26T14:28:00.383611+00:00` 再查全状态列表仍为 0。因此没有可评论和关闭的相关条目，未新建 Issue，未执行无对象的评论或关闭。

## 验证边界

- 用户环境为 Windows。本轮 Windows CI 与包内探针不等于用户真机的显示缩放、显卡、多显示器与原会议现场验收。
- 没有调用真实云端 LLM，没有读取旧本机会议或复测用户原六分钟会议；不能断言该场问题必然只由已复现的卡住路径引起。SenseVoice 固定样本是运行验证，不是会议准确率评测。
- macOS 为 ad-hoc 签名且未公证，Windows 未代码签名。升级前结束录音、完成补传并从托盘退出客户端；已失败纪要可在升级后手动重新整理。

本回执补记沿用同一版本证据，不移动标签，不覆盖附件，不再触发版本循环。
