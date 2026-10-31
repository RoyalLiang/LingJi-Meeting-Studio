# v0.1.43 三平台发布核验回执

核验时间：2026-10-29T04:19:57.035Z。五项CI与四个公开附件核验通过。

源码与控制工作流SHA：`2a4e02f5aa35da8a7088e96fa66ac30739c243e0`。

注解标签 `v0.1.43`，标签对象 `9bb7346118407de6cc9e15a51cb3f55eb1d43ed0`；旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.43)。本回执只补记文档，不产生新版本。

## CI结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997/job/123248354821) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997/job/123248424725) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997/job/123248424655) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997/job/123248424634) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40813272997/job/123259896368) | success |

macOS完成DMG构建、校验与启动；Windows完成原生回归、后台录音/重启回放与安装验证；Linux完成DEB安装、启动及卸载。GitHub-hosted CI不能替代用户设备的真实长会议及原地升级。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.43-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.43/Lingji-0.1.43-macos-arm64.dmg) | 218425348 | `81816814556fab6b7ed0cf0178952e1c3f591945888761ebc429b664350c76cb` |
| [Lingji-0.1.43-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.43/Lingji-0.1.43-windows-x64-setup.exe) | 407140289 | `67b852bef45193cb4fda760c2097d525f27cd0e349cd1d166279f65e75fd0eec` |
| [Lingji-0.1.43-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.43/Lingji-0.1.43-linux-amd64.deb) | 221667176 | `d7857e273980268514a44f8a31a177e6fd2e3534654703b822877ee68d3311f2` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.43/preview-update.json) | 4824 | `c4363884958cb2d8d89526d79c41c1aaeb44b51a448ad20188160b6e1407cc02` |

清单版本、源码SHA、三个安装包名称、地址、大小和摘要与公开Release一致。三个安装包HEAD=200且Content-Length一致。完整安装包未在本机重复下载计算摘要；完整包校验由CI执行。

## Linux依赖

使用HTTP Range读取DEB控制区，依赖：`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。未完整下载DEB。

## 本地验证与边界

[本地证据](settings-v0.1.43-2026-10-29.md)：Node653/653、lint、typecheck、build:web、check:docs和差异检查通过；固定源码独立复审无已确认P1/P2，定向52/52与此前音频链路103/103通过。队列两项失败先复现再修复，真实HTTP/SQLite原音停止排空集成通过。六张界面截图均使用虚构数据；窄窗口、深色、独立弹窗与折叠编辑草稿已验证。Windows用户原机、原会议、真实ASR/LLM与长时录音尚未复验，不能把CI安装验证当作现场修复确认。
