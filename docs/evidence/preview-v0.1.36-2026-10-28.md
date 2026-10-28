# v0.1.36 三平台发布核验回执

核验时间：2026-10-28T06:27:37.168Z。五项 CI 全部成功，三平台安装包与更新清单已公开发布并核验。

- 产品源码与工作流 SHA：`cd689415d833756a53eefc3536f765141b0f2b11`。
- 注解标签：`v0.1.36`，标签对象 `eaf85eb2affa269fe7ebc5f468321c629f411931`；未移动旧标签。
- [Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.36)。
- 本回执为同版本补记，未重新构建、创建新版本或覆盖附件。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058/job/122654627095) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058/job/122654687342) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058/job/122654687355) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058/job/122654687374) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40639673058/job/122666687360) | success |

macOS 完成 DMG 构建、包校验与启动；Windows 完成原生回归、后台录音和重启恢复、EXE 构建与安装验证；Linux 完成 DEB 构建、安装、启动和卸载验证。以上为 GitHub-hosted CI，不能替代用户设备与真实会议质量验收。

## 公开附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.36-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.36/Lingji-0.1.36-macos-arm64.dmg) | 218392749 | `07a50fc82a55bed4b7f89a85479d5c3fdd1f754ea674b5320143685f665aca58` |
| [Lingji-0.1.36-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.36/Lingji-0.1.36-windows-x64-setup.exe) | 407153230 | `389b231945edc53b79acc574211bb5bcbd9983f43059327ef7e4135b321f2b9d` |
| [Lingji-0.1.36-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.36/Lingji-0.1.36-linux-amd64.deb) | 221624270 | `a88d33b0c69036afc28943f766c8681e4e707070c18fa784fb08962686c7703b` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.36/preview-update.json) | 4917 | `16f5c4b79e9a1532fa3f28ed521bc65232b8acb5e25ddeb341a35e9ef5855196` |

更新清单中的版本、源码 SHA、三个安装包名称、下载地址、大小和 SHA-256，与公开 Release 的四个附件摘要一致。三个安装包 HEAD 均为 200，Content-Length 与清单一致。本机未全量下载三个安装包再计算摘要，完整包构建校验由 CI 完成。

## Linux 运行库核验

对公开 DEB 范围读取，HTTP 206，读取 5512 字节取得 control 归档；版本 0.1.36、架构 amd64。运行依赖：

`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`

托盘运行库已包含在最终安装包依赖中；用户桌面环境下的托盘观感未验收。

## 纪要验证与边界

[本地实现证据](minutes-efficiency-v0.1.36-2026-10-28.md)：Node584/584、Rust37通过1忽略、lint/typecheck/build/docs通过；1280/390纪要样例、标题连线、单一处理状态、引用还原、跨窗语义整理和人工保护回归通过。用户提供服务的版本基址复现404，两个完整模型端点和虚构会议短样例通过。

[效率基准与配置](../engineering/minutes-efficiency.md)：合成50分钟300段的等价输入载荷176153→127033字节，等价输出引用载荷67786→49076字节；文字叶窗25→10。保留300项独立事实的压力桩中，旧编排在30次调用后因元数据预算失败，本版13次完成；不是两次成功的付费模型A/B对照。

未重放用户原始50分钟会议，未测得其实际token或费用降幅。模型推理输出和缓存命中会波动；引用合法性校验也不能证明完整事实召回。真实会议质量、目标模型长上下文、实体音频和用户设备仍需单独验收。

[官方来源研究](../research/minutes-token-efficiency-2026-10-28.md)区分缓存计费、推理子项和上下文压缩，不把载荷字节数当作token数或费用。
