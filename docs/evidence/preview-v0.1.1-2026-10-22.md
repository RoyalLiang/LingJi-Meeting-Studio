# v0.1.1 Actions 后台构建与发布证据

核查日期：2026-10-22。用户授权推送四项会议体验修复，并通过 GitHub Actions 后台构建、发布 macOS Apple Silicon 测试安装包。以下是已取得回执的结果。

## 发布与来源

- [公开测试版 v0.1.1](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.1)，release ID `420315736`，公开时间 `2026-10-22T04:43:09Z`，状态 `draft=false`、`prerelease=true`。
- 规范仓库 `RoyalLiang/LingJi-Meeting-Studio`，稳定 ID `1416481402`，与旧 `LingJi-MS` 为同一项目；保留本地 origin 别名，没有重建仓库或修改权限。
- 四项修复源码：`9db49823483923d612f2cba0af999551bac01104`。具体行为与本地验证见[修复证据](meeting-lifecycle-startup-2026-10-22.md)。
- 发布源码与工作流：`6e719c7874a955e86f4133288b930fd0bbc55294`。版本 `0.1.1`，bundle `0.1.23`，平台 `macos/arm64`，最低 macOS `14.6`。
- 注释标签 `v0.1.1` 对象 `7d3fb69169f8e7c01e2f2c13a52acf4cfd9dd608`，解引用为上述源码。推送后通过 SSH 核对远端 main 与标签；原 v0.1.0 未移动。
- 用户已回应本轮交付前自查并明确授权发布；本次不重复门禁。

## 后台执行与验证

SSH 推送 main，再单独推送新标签；tag push 自动触发 [Actions run 39722736145](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39722736145)。事件 `push`，head branch `v0.1.1`，head SHA 为上述发布源码；运行结论 `success`。触发、构建、发布、附件上传及结果核验均走 SSH、Actions 与 API，没有通过页面触发或页面上传。

| 任务 | Job ID | 结果 |
| --- | --- | --- |
| verify | 119639684742 | success |
| build | 119639722651 | success |
| publish | 119643318900 | success |

本地发布准备通过 340 项 Node 回归、ESLint、类型检查、104 份 Markdown 和官方 actionlint；独立审查及发布器 8 项契约通过。云端依次通过来源与版本校验、Node 回归、lint/type/docs、Web 构建、Rust 检查、冻结源码 DMG 构建及隔离包检查。

构建运行在 macOS ARM，只有独立发布任务获得 `contents:write`，使用当次短期 `GITHUB_TOKEN`；未使用本机 PAT。已发布版本、来源不匹配和冲突附件保护保留。

公开下载的 `release.json` 中，源码修订和 `ci.workflowSha` 均为 `6e719c7874a955e86f4133288b930fd0bbc55294`，`ci.runId=39722736145`；`sourceDirty=false`、`frozenSourceBuild=true`。公开下载的 `package-smoke.json` 确认包内独立后端、重启持久化、稳定 WebView profile、父进程持有后端与本地账号检查通过，开发后端请求为 0。

## 公开附件完整核验

通过公开下载地址完整下载全部五附件，核对实际字节数与 API 的 SHA-256。DMG 同时匹配 `release.json` 和 `SHA256SUMS.txt`；安装说明包含本版 bundle 版本，发布正文包含四项变化。

| 附件 | 实际字节 | SHA-256 |
| --- | ---: | --- |
| `INSTALL-macos-arm64.md` | 3551 | `ba8a0dac8c719199e59061bfd2c828081c8ac6d9803e9d9a31818f2c1d1d2d38` |
| `package-smoke.json` | 389 | `371306813f0eed3d52b97057724068d1852a3248df1e34aaefcdba1c6f67e211` |
| `release.json` | 37075 | `0c4dfb70cb79d1b8d8e7a8340f5f117c6fd57bba6722d0dbe12369b1034534b5` |
| `SHA256SUMS.txt` | 95 | `589dae394c6f13f87950707123f26496467a2e9988348f83ab24086e425b42b4` |
| `Lingji-0.1.1-macos-arm64.dmg` | 47432862 | `b4bd5902e8bdd0ba14cf23fbb0606e93d0a4928f4f463915206ea90d05d1c941` |

## 交付边界

本次交付包含会议收尾与接入状态修复、语音处理提示布局、新会议按创建时间置顶及过期请求防护、历史恢复写入和首屏并发优化。启动基准约 60→27 ms 是合成历史场景的后端就绪时间，不是完整原生 App 冷启动测量。

测试包为 ad-hoc 签名、未公证。安装前结束录音、等待补传、完全退出旧版并备份数据；Preview 与 Alpha 使用相同应用标识，勿同时运行。见[版本安装说明](../releases/v0.1.1-preview.md)。

未替换本机已安装应用，未读取或改写真实会议。包检查没有打开真实音频设备或调用真实 ASR/LLM。实体设备、真实供应商识别质量、长会议、全新 Mac、PG/S3 和完整原生冷启动仍未验收。
