# v0.2.4 三平台发布核验

状态：2026-10-31 已由 GitHub Actions 公开发布，四个附件完整下载核验通过。核验时间 `2026-10-30T17:43:03.431365+00:00`。

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.4) · [Actions 41090774763](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763) · [安装说明](../releases/v0.2.4-preview.md) · [实现与边界](rolling-summary-2026-10-30.md)。

## 固定来源与远端

- 源码与本轮工作流 SHA：`a1ebdb539a0bfcecd4d1ce95bea33d1f5be779aa`。
- 注释标签对象：`b78d99b520551600002861aa0e5473e4d588cf65`，`v0.2.4^{}` 指向以上源码；已通过远端 Git 引用重新核对。
- 已整合 v0.2.3 的源码 d17d158 及发布回执 70a7b8c；main 与新标签原子推送。原目录的 IDE、播放实验改动保留。
- 本回执另作文档提交，沿用 v0.2.4 证据，不移动标签、不替换附件、不再递增版本。

## 构建与校验

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763/job/124183763999)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763/job/124183904534)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763/job/124183904419)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763/job/124183904462)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41090774763/job/124203856146)：success。

匿名 REST API 在等待期间限流；最终五项状态来自公开 Actions 汇总，附件摘要来自公开 Release 附件页，并与更新清单及完整下载逐项比较。没有把限流视为构建失败。

本地 Node 24.21.0 全量 768/768、Rust smoke-test 45 通过/1 忽略、lint、typecheck、Web 构建、文档与独立评审通过。原生 CoreAudio ABI 故障注入和本机空闲只读采样已验证；最终设置截图已补拍。

## 完整下载的附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.2.4-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.4/Lingji-0.2.4-macos-arm64.dmg) | 218,616,334 | `e4b968547e1363f6b283286a0e2424f75c8dac16fa157fada7a77e01c81e4a09` |
| [Lingji-0.2.4-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.4/Lingji-0.2.4-windows-x64-setup.exe) | 407,400,197 | `9650c5828cfbabab2c160bdaf932c7fe07d3eaf4386236f705020488c8d55386` |
| [Lingji-0.2.4-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.4/Lingji-0.2.4-linux-amd64.deb) | 221,834,368 | `0462c1b17a527d79812a09343c4e2c16411fedd000184edd8d0e3c9ef4f7b13f` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.4/preview-update.json) | 4,691 | `6eaaebfd9a6a56c0a2bbe48adedc0969ef792c846d6a8423a268111c00bc9dcc` |

下载遇超时后改用服务器确认支持的 HTTP Range，复用已有完整片段；合并后重新计算整包摘要。所有四个文件均匹配 GitHub 公布值；三平台字节数、摘要和 URL 同时匹配 `preview-update.json`，清单源码与标签一致。

[机器可读回执](assets/rolling-summary-20261031/release-verification.json) · [最终设置截图](rolling-summary-2026-10-30/settings-learning.png)。

## 验收边界

- 初版后台监听默认关闭，仅 macOS 14.6+ 的 Chrome、Edge 与飞书；Safari、Windows/Linux 监听未实现。其他音视频可能误触发或延迟自动结束，退出应用后不监听。
- 未覆盖真实 Chrome/Edge/飞书会议启停、长会议、锁屏、设备切换与耗电；未调用真实 ASR/LLM 或远端学习服务。本轮结果不能证明模型总结必然准确。
- 额外本机完整原生窗口恢复冒烟未通过：缺失 Focused/Resized 事件，恢复主窗与迟到 ready 场景失败。试验性窗口兜底全部撤回，产品窗口逻辑沿用 v0.2.3；CI 成功不替代该本机交互验收。
- 未覆盖当前安装或原会议资料；旧版已丢失重点不会自动回填，可依原转录重新整理。
