# v0.1.48 三平台发布核验回执

核验时间：2026-10-30T01:29:17.304000+08:00（Asia/Shanghai）。五项 CI 与四个公开附件核验通过。

源码与工作流 SHA：`44d594148e6745c53e98ab47f48db454f451f712`。
注解标签 `v0.1.48`，标签对象 `2ed2dcb87f4ae1941670dee5a5cf867c39f8dcdf`。v0.1.47 因 Windows C4324 严格编译失败未发布，旧标签保留且未移动。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.48)。本回执只补记文档，不产生新版本。main 后续 v0.1.49 学习与翻译候选不属于本次附件。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792/job/123592921293) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792/job/123593056876) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792/job/123593057114) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792/job/123593056850) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915046792/job/123615021569) | success |

macOS 完成 Apple Silicon DMG 构建与原生回归；Linux 完成 DEB 安装、启动与卸载。Windows 完成原生回归、隐藏录音与重启回放、安装器严格编译及主题弹窗测试、安装卸载和后台占用后同一实例重试；静默占用阻断保留。Windows 安装器步骤从 17:06:00Z 到 17:25:38Z 成功。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.48-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.48/Lingji-0.1.48-macos-arm64.dmg) | 218443139 | `d7b0e513539a9c903fc7c4b43f369ba50ef2a2f624d02fec0187ea880fbb1b50` |
| [Lingji-0.1.48-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.48/Lingji-0.1.48-windows-x64-setup.exe) | 407157665 | `27c3b0753254bd24eb0f3d996a332c0fb848c4ed163890190ef7194677573d1d` |
| [Lingji-0.1.48-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.48/Lingji-0.1.48-linux-amd64.deb) | 221660286 | `cfeb96a87584aacadd2ef53e992c94c22ddaa86b610eb610582b5e34608c6d2b` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.48/preview-update.json) | 5186 | `66f466eccb3e68260d945a7ff104736e63e912129f2f58a0e6bddabf39408c82` |

清单版本、源码 SHA、三个安装包名称、地址、大小与摘要和公开 Release 一致。三个安装包 HEAD=200 且 Content-Length 一致；更新清单已下载并在本机计算 SHA-256。完整安装包未在本机重复下载计算摘要，完整包校验由 CI 执行。

## 本地修复与验证边界

[本轮证据](settings-minutes-v0.1.47-2026-10-29.md)：Node 675/675、lint、typecheck、build:web、发布契约 15/15 与文档检查通过。浏览器使用示例数据检查真实 React 页面，确认标题状态整行移除、设置一级标题继承绿色、下拉框与延迟加载、组间连线、会后速览、键盘焦点和窄屏状态。Windows 模板变量对齐保留字段偏移，portable padding 检查先失败后通过，最终 MSVC 与原生模态测试由本轮 Windows CI 验证。

用户原会议、真实 ASR/LLM、Windows 用户原机及长会话未重放。旧纪要不会自动重写；新汇总策略需重新整理已有纪要，人工修订保护仍保留。
