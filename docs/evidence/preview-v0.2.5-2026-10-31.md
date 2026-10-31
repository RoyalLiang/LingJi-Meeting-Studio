# v0.2.5 三平台发布核验

状态：2026-10-31 已公开发布，五项 CI 与四个附件完整下载校验通过。核验时间 `2026-10-31T02:31:01.884446+00:00`。

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.5) · [Actions 41157018178](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178) · [安装说明](../releases/v0.2.5-preview.md) · [实现与边界](meeting-finish-windows-2026-10-31.md)。

## 固定来源

- 源码 SHA：`30d999069376419f84893aea74d2bc561a6264af`。
- 注释标签对象：`b2f92e0cf37b3348f1be79a7575ddc87c938b619`，`v0.2.5^{}` 指向以上源码，已重新核对远端。
- main 与新标签原子推送；没有移动标签、覆盖附件或改写已推送历史。原目录 IDE 与播放实验改动保留。
- 本回执仅补记同一发布的证据，不递增版本。用户追加的全屏、重点内容与性能优化单独进入下一测试版。

## 构建与验证

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178/job/124405935197)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178/job/124405987551)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178/job/124405987569)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178/job/124405987574)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41157018178/job/124415419965)：success。

本地 Node 774/774、Rust 46 通过/1 忽略、lint、TypeScript、Web 构建与文档检查通过。Standards 与 Spec 各发现1项 P2，修复后分别定点复核关闭。Windows 完整产品原生回归和后台隐藏录制/重启补传由本轮 CI 验证；只读音频采样接口允许环境不可用返回 unknown，不等于真实浏览器/飞书活动验收。

## 完整下载附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.2.5-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.5/Lingji-0.2.5-macos-arm64.dmg) | 218,616,233 | `f5984229aeae6a5ee7351e7b6cfb6ff74c86698d338a2c7fc4d2ec1ef53663fd` |
| [Lingji-0.2.5-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.5/Lingji-0.2.5-windows-x64-setup.exe) | 407,436,231 | `1396761f16cb12dc29ee3cbfef5a5427fea20115c58d8be8b2b77e3767129257` |
| [Lingji-0.2.5-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.5/Lingji-0.2.5-linux-amd64.deb) | 221,843,328 | `f375a2bd9700687f63a4390f9d1e19ab07b38d95815a5c87d598bcd5edf4a364` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.5/preview-update.json) | 4,550 | `c02c76cd7fc1798faa7b94bbbb498bc9db371c1078ca11f465ac7433627b6ada` |

四个完整文件均匹配 GitHub 附件公布摘要；三平台文件的字节数、URL、摘要同时匹配 `preview-update.json`，更新清单源码与标签一致。下载使用服务器确认支持的 HTTP Range，合并后重新计算整包 SHA-256。

[机器可读回执](assets/meeting-finish-20261031/release-verification.json) · [标题与收尾截图](meeting-finish-windows-2026-10-31.md)。

## 验收边界

- Windows Chrome/Edge/飞书监听默认关闭，只覆盖可观察的 WASAPI 共享会话；独占流及其切换不可完整观察，可能影响自动结束，应使用手动控制。视频/音乐等也可能误触发。
- 未验证真实 Windows Chrome/飞书会议、设备切换、锁屏、耗电、真实 ASR/LLM 服务与实际会议总结质量；合成数据和 CI 不替代这些试点。
- 此轮解决用户确认的“后台继续处理但页面没有提示”，并提前/优先调度尾段总结；不把模型响应时间视为已测得提速。
- v0.2.4 留存的本机窗口恢复交互缺口未在此轮修复；本轮 CI 成功不替代该本机交互验收。
