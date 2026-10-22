# v0.1.5 豆包音频纪要发布回执（2026-10-22）

[GitHub pre-release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.5) 已公开发布；[Actions run 39767980520](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39767980520) 的 verify、build、publish 均成功。触发方式为 main 与新标签的原子 SSH 推送，没有使用浏览器发布或手工上传本地产物。

## 源码与版本

- 发布源码与 workflow SHA：`fae01b0c499ebdb6fcfc95a64a79ba980b20c486`。
- 标签：`v0.1.5`；版本 0.1.5，macOS bundle 版本 0.1.27。
- 豆包实现 `f189cf7`、配置文档 `0216e99` 和已发布播放器修复 `cba5dc8` 均在发布历史中；并行占用的 v0.1.4 标签保持原样。
- 五附件于 2026-10-22T11:18:39Z 发布。本回执作为同版本文档增量补记推送，不循环创建新版本。

## 交付完整性

五个公开附件均已完整下载，字节数和 GitHub API SHA-256 全部匹配。DMG 的 SHA-256 同时与 `SHA256SUMS.txt`、`release.json` 一致。

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| INSTALL-macos-arm64.md | 3609 | `a11f788f6dab58c80687360287d84f837a7c84be5f4848dde01a8ac6958ff864` |
| Lingji-0.1.5-macos-arm64.dmg | 47460661 | `7b28bf6f85e516da3d826fa0d1438f145e1a44ac2329e90fbd8e4df9a74eae6c` |
| package-smoke.json | 389 | `55f626566ed973cb55d6704d7c7958253dd98e6dc864cc99615e7307c26942de` |
| release.json | 37891 | `75b5a53a96df51277cd5769c8d30a589a4bc9fe106cf5a77379b61e4778eb41d` |
| SHA256SUMS.txt | 95 | `5db271e3a93bcf4cf68d70e0fd144d516944f3b0ff1e072036060f1284953fcc` |

`release.json` 中 223 个冻结源码文件均与发布提交逐字节核对，整体源码清单摘要一致。包内 `doubao-audio-minutes.mjs` 与发布源码一致，确认本轮豆包模块进入安装包。完整机器回执见 [verification.json](preview-v0.1.5-2026-10-22/verification.json)。

## 验证结果

- 隔离合并源码：386/386 Node 回归、lint、typecheck、Web 构建、119 Markdown 引用与围栏检查通过。
- 云端：Node 回归、静态/类型/文档检查、Web 资源准备、Rust 原生测试、固定源码构建、安装包与发布检查均通过。
- 公开 DMG 本机只读检查：映像、deep/strict 签名、arm64、应用标识 `com.tts.meeting`、版本 0.1.5 / 0.1.27、最低 macOS 14.6，以及包内豆包模块与源码一致均通过；检查后已卸载映像，没有安装或启动 App。
- 包内独立后端：Node v24.21.0、SQLite 3.53.4，启动与重启持久化、稳定 WebView 数据配置、父进程管理、本地账户和开发账户禁用检查通过；开发后台请求为 0。

## 配置与边界

升级后打开“设置与诊断 → 模型与转录服务”，选择“豆包音频 · 直接理解＋转录留证”，使用 Responses、方舟完整 `/api/v3/responses` 地址、`doubao-seed-2-1-lite-260915` 及自己的方舟密钥。ASR 保留原独立配置；本场需明确允许原音发送。详见[安装说明](../releases/v0.1.5-preview.md)和[App 配置](../engineering/doubao-audio.md)。密钥不随包分发。

本版仍为 ad-hoc 签名测试包，未经 Apple 公证。包体验证不等于真实 ASR/LLM 实录、多人会议准确率、实体长录音、休眠恢复、全新 Mac 安装或原生界面验收。真实豆包证据来自此前授权的合成语音测试；本次 CI 和本机验包没有打开真实设备或调用供应商。现有安装和会议数据未改动。
