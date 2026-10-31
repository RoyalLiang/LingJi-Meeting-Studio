# v0.1.26 公开测试发布回执（2026-10-27）

证据截止：2026-10-26T18:33:10.438Z。

源码与标签：`7db6ca6619f5d892f7552a201d6ded73d97a1294` / `v0.1.26`。
[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40372834413)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.26)。

发布前冻结源码 324 文件，清单 SHA-256：`9aedc4b817a277a10b074856f412a70071bf5b24f2fcfa29a9464b68bc21e725`。公开下载的十个附件逐字节核对大小、SHA-256、平台元数据和源码来源一致。

| 任务 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40372834413/job/121747833062) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40372834413/job/121747940194) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40372834413/job/121747940237) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40372834413/job/121766842826) | success |

## 修复及验证范围

- 会中多窗口首个可用正文提前回显，流切换重置预览；首轮最多等待 30 秒。失败状态在转录继续追加时仍可见。用量字段与纪要完成状态分开。
- 明确 Kimi K3.1 Pro ID 的实时请求使用 low 思考强度，纪要请求给出 16384 token 预算；终稿保留供应商默认思考强度。
- 悬浮提示独立显示并避开视口裁切；播放器数字标签样式与提示字体隔离。设置移除底部能力检测、删除统计和冗余说明。
- 本地 Node 518/518，独立相关链路复核 87/87；lint、typecheck、Web build、文档检查通过。浏览器验证包括窄窗口、禁用悬停、键盘/Escape、播放按钮样式组合，以及失败状态和实时草稿回显。
- CI 原生及安装后烟测覆盖设置、提示、窗口切换、后台持续采集、持久队列和重启补传。夹具使用合成音频和本地模型响应。
- 本机 v0.1.26 首次原生复测出现未标注的前端等待超时；增加阶段标签后复测被 PyCharm 占用固定端口 63342 阻断。未停止该应用或改变队列来源地址；本地超时根因未复验，以本版本独立 CI 的结果为原生证据。

## 公开附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.26-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/Lingji-0.1.26-macos-arm64.dmg) | 219569438 | `sha256:512ea69b5ee7c64c8cfd9350daac1d5a7f035d1cb4848c9db79255bb0823eeac` |
| [SHA256SUMS.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/SHA256SUMS.txt) | 96 | `sha256:eb9e50920b6f53e9d7b337fcb1360ea8db9a3081bffd2d9aa561f7b769c4f353` |
| [release.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/release.json) | 55274 | `sha256:a842c6447d9162390c652814baa20f8fb0b0a868fd7a593f91d6a4610130f3c8` |
| [INSTALL-macos-arm64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/INSTALL-macos-arm64.md) | 2826 | `sha256:ec151bce5dfd5951819078ed145a62a53c9d44fd0aba450adc04bf923698afaa` |
| [package-smoke.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/package-smoke.json) | 421 | `sha256:cd933e122376416d9d64b763b9cf18c88588e0cd1a28399111588b41be246876` |
| [Lingji-0.1.26-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/Lingji-0.1.26-windows-x64-setup.exe) | 407620920 | `sha256:8aecd77328002a2556dd69e83de06628cf475b6c77412dcd72aa0ecc80cf44bc` |
| [SHA256SUMS-windows-x64.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/SHA256SUMS-windows-x64.txt) | 102 | `sha256:ab1cd2887c6cc77ce43d1d56eebf19aa8ca00f62a70e8b421bf4dde450712dc5` |
| [release-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/release-windows-x64.json) | 54891 | `sha256:ebb49456f2ce3fee2af3fdc6c6694e368395a4be1675cd1455b2c0dc7207a8a9` |
| [INSTALL-windows-x64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/INSTALL-windows-x64.md) | 4017 | `sha256:8339e8179526e66308ab0746b9734ca5e4b2661041c47e14dd38fd107257f81b` |
| [package-smoke-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.26/package-smoke-windows-x64.json) | 421 | `sha256:7ca702f805dca1e8b53fb2f9421804684c25f5731db0394871435360badcd731` |

## 平台与供应商边界

下列为包内核验标志；不能代替 Windows 真机、真实声卡、原会议现场或真实 Kimi 请求验证。

```json
{
  "mac": {
    "imageVerified": true,
    "copiedAppSignatureVerified": true,
    "productionSmoke": true,
    "realAudioDevicesTested": false,
    "realProvidersTested": false,
    "freshMachineTested": false
  },
  "windows": {
    "peVerified": true,
    "installerSilentSmoke": true,
    "installedAppProbe": true,
    "resourcesVerified": true,
    "uninstallVerified": true,
    "productionSmoke": true,
    "realAudioDevicesTested": false,
    "realProvidersTested": false,
    "bundledAsrTested": true,
    "freshMachineTested": false
  }
}
```

GitHub Issues 检查返回 0 条（含所有状态，查询无后续分页）；相关工单结果按实际查询记录。

尚未重放用户原会议，也未使用真实供应商密钥或录音。真实首字延迟、16K 预算下的完整性和低思考强度的语义质量仍需现场实测；本轮不宣称提速倍数。

v0.1.25 工作流已先行成功发布；本轮不改写其标签或附件，v0.1.26 补齐播放器提示样式，作为本轮最终交付版本。
