# v0.2.6 三平台发布核验

状态：2026-10-31 已公开发布。五项 CI 与四个完整附件校验通过，核验时间 `2026-10-31T03:34:56.377352+00:00`。

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.6) · [Actions 41162263833](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833) · [安装说明](../releases/v0.2.6-preview.md) · [实现与截图](fullscreen-performance-2026-10-31.md)。

## 固定来源

- 源码 SHA：`b02d90052a48aea86eb40d43ec7e6bb9fb404186`。
- 注释标签对象：`d8086a4052973ef43314a87c1095120581305305`，`v0.2.6^{}` 指向以上源码，已重新核对远端。
- 源码与新标签原子推送；保留 v0.2.5 源码与回执，不移动旧标签或覆盖附件。原目录 IDE/播放改动保留。
- 本回执只补记同一版本证据，不递增新版本。

## 构建与验证

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833/job/124422182975)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833/job/124422225937)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833/job/124422225945)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833/job/124422225946)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41162263833/job/124429630316)：success。

本地默认入口完整779/779回归通过，含新增性能与阶段用例；最终针对性17项、lint、TypeScript、Web构建及277份Markdown检查通过。Standards无确定发现；Spec的ASR耗尽假处理问题与悬浮提示残留已修复并经原评审定点确认。

实际组件与容器CSS验证2560/1920/1280/390视口、浅深主题、正常汇总和失败态。合成600段流水线的源ID查找由1,983,300次降至6,600次；模型调用仍为合成回归，不据此声称真实供应商同比提速。

## 完整下载附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.2.6-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.6/Lingji-0.2.6-macos-arm64.dmg) | 218,611,591 | `b9932c3287840dd93ed2157b32c80462be11006a974433cc89c446bba93cc702` |
| [Lingji-0.2.6-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.6/Lingji-0.2.6-windows-x64-setup.exe) | 407,415,387 | `36b35b1bfbbb5e415d8f5740298535537bcbae5737337aed609e849dd29538a8` |
| [Lingji-0.2.6-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.6/Lingji-0.2.6-linux-amd64.deb) | 221,846,190 | `f719afaed8e3a3db692f33668665f5f18175db476484bdfb8d27a680b4a353d7` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.6/preview-update.json) | 4,616 | `c8eddf0adf91b8a9ceac62b60a7e727b2550842d41632eadcb0f557f79dab291` |

四个完整文件均匹配GitHub附件公布摘要；三平台字节数、URL和摘要同时匹配preview-update.json，更新清单的源码、标签和工作流一致。HTTP Range下载片段合并后重新计算整包SHA-256。

[机器可读回执](assets/fullscreen-performance-20261031/release-verification.json) · [尺寸与读取次数](assets/fullscreen-performance-20261031/regression-metrics.json)。

## 验收边界

- 未连接真实ASR/LLM，未验证真实供应商耗时和总结质量，未验证真实Windows全屏、GPU和Chrome/飞书音频活动。浏览器视口与合成音频CI不替代这些现场验收。
- Windows自动会议继承v0.2.5：默认关闭，仅覆盖可观察的共享音频会话，独占流或切换不可完整观察；其他音视频也可能误触发。
- 已开始的纪要与尾段任务继续执行；ASR重试耗尽明确显示待重试，仍在运行的独立纪要保留进度。本轮未降低上下文或引用/人工编辑保护。
- v0.2.4留存的本机窗口恢复交互缺口仍未作本机复测，本轮CI成功不替代它。
