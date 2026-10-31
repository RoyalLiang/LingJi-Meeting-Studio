# v0.1.34 三平台发布核验回执

核验日期：2026-10-28 01:41:51，Asia/Shanghai。用户在 v0.1.31 交付前自检后追加波形、设置和渲染优化；本轮完成这些修订，保留并合入 v0.1.33 多语种与词表功能。

## 源码与构建

- 源码、工作流与带注释标签 `v0.1.34` 均指向 `0bd866140d359f339c40840fa498909f3a67bfda`；推送时 main、工作分支与标签源码一致，采用原子推送。
- macOS 内部 build `0.1.56`；Web、desktop、Cargo、锁文件与两个 Tauri 配置版本一致。
- 构建源码清单 336 文件，SHA-256 `f24def8c2095b9648375e47b52ccd80bce2902684fb5d7ed68b7847601a062ad`。
- 公开标签源码归档逐文件对照固定提交的 git archive，791 文件一致；排序路径/文件摘要清单 SHA-256 `34119dd357cfb032ccab241b3b05f76e101e092ce85037c02e50dbc4f6dd0219`。
- [Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150) 五项全部成功；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.34) 为公开测试版，包含三个安装器与一个更新清单。

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150/job/122336082624)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150/job/122336201980)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150/job/122336201706)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150/job/122336201842)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150/job/122357655681)：success。

## 公开附件

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.34-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-linux-amd64.deb) | 221485846 | `7c6de047288742d895c481a456d21c07c59dadedaaff1b0e40cdc0718ebe17ff` |
| [Lingji-0.1.34-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-macos-arm64.dmg) | 218389148 | `e0f71d8dd0488e7d13f85ae20c4657e8789d3ba7c09f2b3599835b90e7d405fa` |
| [Lingji-0.1.34-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-windows-x64-setup.exe) | 407133207 | `e262d5d06cf7e1890b3f82b1241eae2868678535baaceafdb71a6a6f84163906` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/preview-update.json) | 5202 | `ae1182df3cae5c69e4bac672ae533827baa5b9561d68d316cdbc1c36e86e7ef7` |

三个安装包均完整下载，分段响应范围/长度检查通过，SHA-256 与 Release 正文一致；本地检查 EXE 的 PE 标记、DMG 的 koly 尾部、DEB 的 ar 容器标记。更新清单完整下载，固定标签/源码、三包 URL、大小和 SHA-256 与实际附件逐项一致。清单自身摘要由下载字节计算，用于本回执留证。

[结构化核验记录](preview-v0.1.34-2026-10-28.json)。GitHub 公共 API 配额不足，元数据使用公开 Actions/Release HTML 与 HEAD；摘要由实际下载文件计算。原始 Actions 报告压缩包需登录，未在本地解包；CI 层以固定源码的校验/发布逻辑和五项公开成功结果为证据。

## 本地验证与交付边界

Node 565/565、Rust 37 通过/1 忽略、lint、TypeScript、Web 构建、文档引用检查通过。独立审查及浏览器边界复验消除了缓冲定位后动画误恢复、暂停拖动结束层未释放两处问题；合并冲突复核确认语言、翻译及词表入口保留。

[波形/设置/渲染验证](waveform-settings-v0.1.34-2026-10-28.md)记录本机合成 50 分钟首次 486ms/缓存 10ms、设置保存与更新安装门禁、390px 无横向溢出，以及 Chromium 节点/合成层/帧采样对照。

Windows 真机 GPU/显存/进程内存、用户原录音的读取耗时、真人倍速听感、真实 ASR/LLM 和全新电脑升级仍需单独验收。CI 安装测试与 Chromium 替代环境不覆盖这些项目。

本回执属于同一版本的证据补记，不创建新标签、不移动已发布标签或覆盖附件。
