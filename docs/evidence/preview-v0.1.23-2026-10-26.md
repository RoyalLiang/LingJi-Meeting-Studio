# v0.1.23 已发布与核验（2026-10-26）

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.23) · [Actions 40251719525](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40251719525) · [安装与功能说明](../releases/v0.1.23-preview.md)

已合并并发布公开测试版。源码及标签固定为 `7a92739806d984a21fbbc8348d7a105244efbd52`，工作流 SHA 相同；main、独立分支和新标签原子推送。package、Tauri、Cargo 均为 0.1.23，macOS build 为 0.1.45。验收时间：`2026-10-26T01:40:07.805Z`。

## CI 与源码

| 任务 | 结果 |
| --- | --- |
| verify（121344869477） | success |
| build_windows（121344907477） | success |
| build（121344907583） | success |
| publish（121354566404） | success |

合并保留 v0.1.22 的手动重试和两分钟默认间隔，并接入本轮 v6 任务标识、历史上下文、更正/撤回及累计纪要校验。SenseVoice 专项使用显式 30 秒间隔，12 分钟合成时间线连续更新 24 次。

本地 Node 24.19.0 完整回归 504/504，ESLint、Web 类型检查、标准 Web 构建、169 篇 Markdown 检查通过；独立领域/重试/发布配置复核 38/38。后台 macOS 完整回归、两平台 Rust/原生回归和隔离包验证均成功。

十个公开附件已独立完整下载，逐字节计算 SHA-256，核对 GitHub 摘要、两平台校验清单、发布元数据、CI run 和源码 SHA。两平台来源清单一致，321 份源码文件与标签逐字节匹配；清单 SHA-256：`09ad3a71dffd7b7b2e96023442840aed70749ab6006012be991a1c7b85f543dd`。

## 公开附件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.23-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/Lingji-0.1.23-macos-arm64.dmg) | 219556545 | `b071a38738713bd5ac492c260f32b7757dc58a1af47d89f13a60c2174e3ddac4` |
| [SHA256SUMS.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/SHA256SUMS.txt) | 96 | `21ad69936d11aeb1a8f5f30a2878ce07e3b1dbd1aaf4ad81333dc89d8e326cd6` |
| [release.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/release.json) | 54812 | `62435c9b5eaedd8bd559203ee6830abc2762c80dc1ebe4439755fe30a331d93c` |
| [INSTALL-macos-arm64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/INSTALL-macos-arm64.md) | 1667 | `39c503d19677483d68949e57f9e65098d09b32104f4f9a4dfdecca3df53b986f` |
| [package-smoke.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/package-smoke.json) | 421 | `fcc51eb1b677971e98d1836d6d8f28354d3ecf572c777d45a1bd75082867f750` |
| [Lingji-0.1.23-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/Lingji-0.1.23-windows-x64-setup.exe) | 407607163 | `9b901114e08be1af828d3c350ff83a168d32b66f2e8fb6095a7fe5c24523ad65` |
| [SHA256SUMS-windows-x64.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/SHA256SUMS-windows-x64.txt) | 102 | `c84453087ce4a83cdc7bed551fb105a58d8923aa65212ae7302a0e221232e5e4` |
| [release-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/release-windows-x64.json) | 54429 | `c7df6b46b6b7609e05f7b27db4f3eaed2832473624b49cfc44c52af7f21da8fa` |
| [INSTALL-windows-x64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/INSTALL-windows-x64.md) | 2858 | `d004a70dc7344f0671563e568f4dea782e5a45c4ae4650a80b0faa37fff6ce48` |
| [package-smoke-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.23/package-smoke-windows-x64.json) | 421 | `da876415bb472cc9bf133f8e9289d302ec6b10c79a29d54192126958a129b8be` |

## 验证边界

- macOS 包内 SenseVoice 使用固定公开中文、英文和静音样例完成原生推理，nativeInference=true；不是会议准确率评测。
- Windows 持续合成采集、隐藏窗口录音、重启补传、安装资源哈希、安装/卸载及包内后台冒烟通过；工作流持续采集配置为六分钟。
- 本轮没有实际调用云端 LLM，也未验收实体录音长会议、真实供应商质量或用户设备的持续表现。12 分钟纪要专项的识别和模型输出为注入夹具。
- macOS 为 ad-hoc 签名且未公证；Windows 未代码签名。升级前结束录音、完成补传、退出常驻进程并备份现有会议数据。

本回执补记使用同一版本证据，不移动 v0.1.23 标签，不覆盖已发布附件，不循环创建版本。
