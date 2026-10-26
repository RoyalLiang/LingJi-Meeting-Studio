# v0.1.27 公开测试发布回执（2026-10-27）

公开发布时间：2026-10-26T19:58:32Z；独立验收截止：2026-10-26T20:00:59.265Z。

源码和标签：`5b9242a9fed733bd513dfe2472f359d368dd7a6b` / `v0.1.27`。macOS build 0.1.49。
[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40385555751)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.27)；[安装与改进说明](../releases/v0.1.27-preview.md)。

冻结源码 326 文件，清单 SHA-256：`77a3742a1c780542ba4a4c6e3cdda09f374ff1d0b7cf3dc44d9a5e580e1a52b1`。十个公开附件已完整下载并核对大小、SHA-256、平台元数据和源码来源。

| 任务 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40385555751/job/121792751307) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40385555751/job/121792829701) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40385555751/job/121792829819) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40385555751/job/121812944672) | success |

## 五项修订与验证

- 推理强度可保存为自动、模型默认、低、中、高、更高、最高。Chat Completions 和 Responses 均透传显式选择；自动保留 Kimi 实时响应策略，模型默认不附加参数。强度进入缓存策略，相同转录重试也会按新选择请求。
- 整理失败使用可关闭、可重试的浮层，不挤占正文。真实 React 浏览器断言关闭前后正文坐标不变。
- 波形移动裁剪与反向位移保持波形位置固定，显式指定 SVG 百分比参考盒。游标等待真正起播并容忍粗采样、微小回退及设备延迟；保留暂停、缓冲、结束、拖动与实际定位语义。
- 页面与纪要底部共同使用现有共享时间线。双轨各 04:41 时显示 04:41；usage.samples 账本继续累计真实音轨用量。
- 连接标签与待保存数量分开，队列变化不再替换连接文字；服务失败和云端离线仍真实显示。

本地 Node24 全回归 526/526、独立定向复核 81/81、lint/typecheck/Web build 与 175 篇文档检查通过。独立复核发现的缓存键与移动裁剪遗漏均已修复后复跑。

隔离 Chrome + 合成 WAV，将 currentTime 量化到 500ms：100 帧布局从 39 次降为 5 次，异常跳动从 4 次降为 0，起播后停顿帧为 0。暂停、指针拖动、Home 和 2× 通过。0/25/50/100% 填色像素数为 0/1096/2200/4420，最右着色位置 None/246/496/996（1000px 画布），未越过播放边界。真实 App 浏览器验证推理强度选择、保存后重开、无正文位移、双轨时长一致；pageErrors=[]。

CI macOS 原生探针、DMG/签名和包内后台检查通过；Windows 原生探针、长时间合成采集、安装后探针、资源与卸载检查通过。新增原生设置探针确认推理强度字段出现。

## 公开附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.27-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/Lingji-0.1.27-macos-arm64.dmg) | 219569973 | `sha256:90646e7e29d9eff86033cb78156a5c9c3e4004c8406480f430ee274ea98dd179` |
| [SHA256SUMS.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/SHA256SUMS.txt) | 96 | `sha256:93d9a56c18443948be768d6a6659f86b4af06bf3b19c366fa23658a2c60c954a` |
| [release.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/release.json) | 55594 | `sha256:f9337a43cf4c17ded391ef7b339bfc6838a5abde28c0c3db31d3143ea6c01c2d` |
| [INSTALL-macos-arm64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/INSTALL-macos-arm64.md) | 2470 | `sha256:adf94c132fa9036ac73efbbe48c545877fb10d8b050f98775fc9a36e572a15be` |
| [package-smoke.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/package-smoke.json) | 421 | `sha256:aee5fe63de37c2bfba0635993c9a1ff7b96cd52f680b516284166233e18c74ff` |
| [Lingji-0.1.27-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/Lingji-0.1.27-windows-x64-setup.exe) | 407699572 | `sha256:d0b94bf62020f8b1a1bee7c321fdb0450d4068e0070db568dfba8fb40d536cc9` |
| [SHA256SUMS-windows-x64.txt](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/SHA256SUMS-windows-x64.txt) | 102 | `sha256:9881372ff04ead587a5e2679c929495f443f85694e4a29fc3efa96a6ee464663` |
| [release-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/release-windows-x64.json) | 55211 | `sha256:ae634ad9fd5067c781e3b5c5d1c589053a98c3b492027b2ee1fe4b99d4bfe94f` |
| [INSTALL-windows-x64.md](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/INSTALL-windows-x64.md) | 3661 | `sha256:8ab7607d0209864add09ce8af61decf5100bc252f84d88522e2d7d08d338c164` |
| [package-smoke-windows-x64.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.27/package-smoke-windows-x64.json) | 421 | `sha256:7c98246aa534f35dfd56887376f8e6b856217bac57acebf8d03649186646262e` |

## 验证边界

以下为实际平台核验标志；夹具不代替真实 Windows GPU/缩放、原会议和真实供应商验收。

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

没有调用真实 ASR/LLM 或读取旧本机会议。真实模型各强度的首字时间、成本及语义质量尚未测量；Realtime 不使用该 HTTP 推理配置。两平台包内 SenseVoice 的固定公开样本验证不等同于会议准确率评测。

GitHub 全状态 Issues 复查为 0 条，无可评论或关闭的相关工单。

本回执补记沿用 v0.1.27 的标签、附件及工作流证据，不移动标签，不循环创建新版本。
