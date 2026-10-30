# v0.2.2 三平台发布核验

状态：2026-10-30 已通过 GitHub Actions 发布公开测试版。核验时间 2026-10-30 13:46 UTC。[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.2) · [Actions 41059428166](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41059428166) · [安装说明](../releases/v0.2.2-preview.md)。

## 固定来源与远端

- 产品源码与工作流 SHA：`aa78dcffbfec62e972c93a8cc1c8da3b28444cbb`。
- 注释标签对象：`8a783d4b8c77373b8894a7458afc743420a31445`，`v0.2.2^{}` 指向以上源码。主线在发布时为同一 SHA；后续仅补记本回执，不移动标签、不再次递增版本。
- 原子推送前已合并并保留 main 的 `0a95ddf` Beta 浏览器发布/读取/撤销回执。原始共享目录的 IDE 与播放实验未纳入本轮提交。

## 构建与本机验证

`verify`、macOS `build`、`build_windows`、`build_linux`、`publish` 五项均成功，公开 Actions 汇总状态为 Success。GitHub 匿名 REST 后续限流，最终状态由公开汇总页面及附件列表交叉核对；没有将接口限流视为构建失败。

本地 Node 738/738、持续定位增量 43/43、结束路径定向 57/57、Rust 串行 44 通过/1 忽略，以及类型、lint、Web 构建与文档检查通过。[实现、测量与独立评审](desktop-reliability-2026-10-30.md)。

- macOS：用户解锁后，最终源码在实际 WKWebView/原生窗口上完成两轮隔离冒烟；340×42、顶部间距 16 逻辑像素、中心偏差不超过 1 像素、真实移位后恢复、暂停/继续、主窗恢复、迟到 ready 保护、设置取消重开、隐藏采集和重启补传均通过。[精简结果](assets/desktop-save-capsule-20261030/mac-native.json)。CI 另验证 DMG、包内资源、独立后台启动与持久化重启。
- Windows：CI 原生窗口完整冒烟通过，包括两轮各六分钟隐藏录音、实际队列补传、悬浮条几何/移位恢复及重启。安装器构建、安装及验证成功。
- Linux：Rust 几何/状态回归、Ubuntu 24.04 DEB 安装、包内资源、独立后台启动/重启、公开 ASR 样例和卸载验证通过；没有将这些检查当作实体 PipeWire 或悬浮条完整 GUI 验收。

以上均使用隔离账户及合成/公开测试资料，没有打开用户真实音频设备或调用真实供应商。

## 公开附件完整下载

三个安装器和更新清单均已下载完毕。安装器实际字节数与清单一致；四份本地 SHA-256 与公开 Release 附件摘要一致。清单固定本版标签、源码 SHA、Actions 链接及三个安装器地址。

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Lingji-0.2.2-macos-arm64.dmg` | 218,591,776 | `49a67787b0eb41a67670b58cc1bb237bf01148f369eeb656aae4d49a01df36c2` |
| `Lingji-0.2.2-windows-x64-setup.exe` | 407,348,817 | `dcefc859ca293f77bebd18f2c5d4a692466bdabfef1ba4883ea8908a6e271557` |
| `Lingji-0.2.2-linux-amd64.deb` | 221,824,294 | `2500018c9d82157daf0640640b4fb70b630ee917dc704d2be8cdc14dc9bcee71` |
| `preview-update.json` | 4,782 | `6f548d0e9bfd3bf95b09c4e382ead15518de798a6c29e28ca27e766ed4efc341` |

[机器可读回执](assets/desktop-save-capsule-20261030/release-verification.json) · [公开附件与摘要](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/expanded_assets/v0.2.2)。

## 官网与剩余边界

同一标签的 [Pages 41059427939](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41059427939) 成功；[官网](https://rookiecode.com)、[公开示例](https://rookiecode.com/example) 及状态端点均为 200，发布服务已配置。分享实现本版未变，浏览器文件预览/发布、匿名访问和撤销的完整回执见 [v0.2.1](preview-v0.2.1-2026-10-30.md)；继续不启用 R2。

本机 Applications 仍为 v0.1.49，未覆盖用户安装或资料；需安装新版本后使用这些修正。原本机旧记录未留存且已清理原音，对应文件缺失，不能证明用户原始波形等待已消除或恢复已清理录音。合成双路 50 分钟 HTTP 首次/缓存波形为 367/15ms。三端完整冷启动、真实长会议、实体采音与多显示器混合 DPI 仍未验收。
