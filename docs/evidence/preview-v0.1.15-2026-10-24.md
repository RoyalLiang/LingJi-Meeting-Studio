# v0.1.15 FunASR＋SenseVoice 发布回执

核验日期：2026-10-24。测试版 0.1.15，macOS bundle 0.1.37；Apple Silicon，最低 macOS 14.6。

已发布：[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.15)；[后台 Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40073041706) 的 verify、build、publish 均成功。安装包固定源码为 `044f390777e5d26b31e2e4dca7b147a3e9d0f950`，标签 `v0.1.15`。本回执补记不移动标签，不覆盖附件，不创建新版本。

新增可选 FunASR 转录服务，默认模型 SenseVoiceSmall。后端按来源和 epoch 聚合原生短包，静音边界优先提交，暂停和结束排空尾部；保留原音、人工转录版本和纪要引用，保留现有其他模型模式。

## 如何配置

先按[服务安装与启动说明](https://github.com/RoyalLiang/LingJi-Meeting-Studio/blob/044f390777e5d26b31e2e4dca7b147a3e9d0f950/docs/engineering/funasr.md)启动模型服务，再打开聆记“设置与诊断”。

| 配置项 | 值 |
| --- | --- |
| 会议理解 | ASR＋LLM · 转录后整理 |
| 转录服务 | FunASR · SenseVoice 本地转录 |
| FunASR 转录地址 | `http://127.0.0.1:18586/v1/audio/transcriptions` |
| 识别模型 | `sensevoice` |
| 服务密钥 | 本机无认证服务留空；网关要求认证时填写 |
| 纪要模型 | 保留已配置的豆包或其他文字模型 |

点击“保存服务配置”，再点击“测试转录”。原生发布包已实际显示“连接测试通过。真实会议识别质量仍需试录核对。”关闭后重新打开设置，配置仍保留。模型服务是独立进程，App 不附带 Python、模型权重或开机自启；本地转录不等于云端纪要也已离线。

下载附件中的 INSTALL 文件保留构建前快照，其发布状态和相对配置链接不适用于单独下载阅读；当前发布状态以本回执为准，请使用上方完整在线配置链接。已发布附件保持不可变。

## 验证范围

- PASS：451 项 Node 回归，其中 16 项 FunASR 定向回归；26 项串行 Rust 回归；lint、typecheck、Web 构建、文档检查及原生构建通过。独立规范和规格评审发现的两项 P2 已修复并复核关闭：未发送后缀不计失败次数，切换服务后旧失败结果不消耗新服务重试次数。
- PASS：本机真实 FunASR 1.4.14 / SenseVoiceSmall / Torch 2.8.0 CPU。两个公开中文短样本聚合后归一化 CER 为 0%；英文参考、暂停尾包和录制中逐包测试通过。经已有豆包模型生成纪要，来源 ID 与修订版本有效。短样本结果不能推广为会议准确率。
- PASS：下载五附件，大小与 GitHub SHA-256 摘要一致；DMG 校验和、只读镜像验证、完整性签名、arm64 架构和包内版本一致；源码清单 234 份与固定提交逐一匹配，清单摘要 `721bcdf3793bd4f44dfe0e382e8f33eca883c9fabc288a09e620ef79e522a38d`。包内 FunASR 客户端、聚合器、WAV 模块及相关已有模块与源码一致。
- PASS：发布包在隔离空数据目录启动；通过原生 App 操作选择服务、检查默认值、留空可选密钥、保存、重新打开和真实模型连接测试，并复核原生截图布局。未使用浏览器调试，未修改用户现用配置。CI 独立包冒烟还验证了后端独立运行、重启持久化与开发账户禁用。
- NOT_VERIFIED：实体麦克风/系统音频采集、真实长会议、持续双路吞吐、噪声与重叠说话，以及各硬件上的表现。CI 包冒烟未调用真实供应商；真实模型和原生连接结论来自上述本机验证。

验证专用模型服务、原生 App、临时数据目录和 DMG 挂载已清理。模型缓存、虚拟环境与验证证据保留；原工作目录的既有未提交文件未纳入本轮提交。

## 发布附件

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| [INSTALL-macos-arm64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.15/INSTALL-macos-arm64.md) | 819 | `2dfc1f9e2904fabb356c5f21df265da6354989aa3cf59a2324af45206379c5ba` |
| [Lingji-0.1.15-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.15/Lingji-0.1.15-macos-arm64.dmg) | 47,481,640 | `7cedb8bc0fb77fa49ba22d97e1e344b52ac872bc449f6e178da5481589e8d5e6` |
| [package-smoke.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.15/package-smoke.json) | 389 | `890cd935c90451853bb80879f9857053f73eda4655c2dd1b5eef0fe89ed42fe2` |
| [release.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.15/release.json) | 39,684 | `c7d206807cb90ae52f09fd06be413753ea259e978525edc7c806e97ea9313a01` |
| [SHA256SUMS.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.15/SHA256SUMS.txt) | 96 | `7f04b1b4807b47d31cc6afc9aef8221429043baf96cc22aaa3755190c4340ddd` |

本轮实现与模型验证细节见 [FunASR 接入证据](funasr-sensevoice-2026-10-24.md)。
