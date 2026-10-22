# v0.1.2 后台 Actions 构建与发布回执

核验日期：2026-10-22。范围：远端源码、Actions、公开附件和完整下载校验；不代表实体设备与供应商验收。

## 交付结果

- [公开测试版 v0.1.2](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.2)，Release ID `420496194`，2026-10-22 08:54:02 UTC 发布；非 draft、标记 prerelease。
- [Actions 39749681733](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39749681733) 由 **tag push** 自动触发，状态 completed/success。verify、build、publish 三个任务全部成功。
- 构建与工作流 SHA 均为 `c14f06db0466a4f7c2814cbc18d775cfeb2818e1`。推送后使用 `git ls-remote` 核对 main 和标签解引用均等于该 SHA；后续回执补记允许 main 前进，不移动标签。
- 全程使用后台 Git、GitHub API 和附件下载端点，没有使用网页操作、手工上传或本地替代构建。

## 安装包与附件

[下载 Apple Silicon DMG](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.2/Lingji-0.1.2-macos-arm64.dmg)。[安装说明](../releases/v0.1.2-preview.md)。macOS 14.6+，版本 0.1.2，bundle 0.1.24，ad-hoc 签名、未做 Apple 公证。

五个附件均完成完整字节下载，文件大小和 SHA-256 与 GitHub API 服务器摘要逐一相符；DMG 摘要也与 `SHA256SUMS.txt`、`release.json` 相符。下载受限时使用同一附件的 HTTP Range 续传，最终对完整文件计算摘要。

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| INSTALL-macos-arm64.md | 3084 | `54294729f7566a955e3b3dc275775bf0b0d1f039dde1f2851e4d2304461a1b6d` |
| Lingji-0.1.2-macos-arm64.dmg | 47443524 | `d0752b7cdedac862e00036f7a778bf29bde95af77ebc0d8290c9639246d3da5c` |
| package-smoke.json | 389 | `ff39705783cfeb0b153e53330babb4d4b9f3079573f7c4eb744f2d9a061001ac` |
| release.json | 37564 | `3bb8300e9408afaeda17418f676876773ee1337e1315dcd11d91627d757171ca` |
| SHA256SUMS.txt | 95 | `a57d351a15942b6b4ad143cba5f17e5d26e51529b589136268e09c52fb19eed5` |

## 源码与验证

221 个冻结源码文件逐一与标签中的文件计算 SHA-256 相符，包括 `packages/records/src/record.mjs`、`services/records/src/server.mjs` 和浏览器/原生录音控制器。移除两小时上限及单路故障隔离已包含在本次构建来源中。

发布源码的本地 369 项 Node 回归、48 项录音定向回归、ESLint、类型检查、Web 构建与 111 份 Markdown 检查通过。[修复与独立评审记录](recording-unlimited-recovery-2026-10-22.md)。发布回执补记通过 112 份 Markdown 引用与围栏检查。CI 重新运行 Node/Rust 回归及构建门禁，包体检查确认 DMG、arm64、签名结构、独立后台、隔离启动与重启持久化通过。

发布配置复核发现标签快照 README 下载步骤残留旧文件名；当前 main 的本轮回执补记改正下载名及产物目录，未移动已推标签。随包安装说明及实际附件名均为 0.1.2。

## 运行边界

必须安装并重启到 0.1.2；旧 0.1.1 进程仍有两小时限制。本轮未替换用户当前安装应用，未修改用户会议。

两小时限制移除有三小时双音轨合成元数据及 HTTP bootstrap 回归支撑，不等于实体设备连续录制已验收。未打开真实音频设备，未调用真实 ASR/LLM/Realtime，未验证全新机器、锁屏和长会议。容量与任务预算保护仍然有效。

[结构化核验回执](preview-v0.1.2-2026-10-22/verification.json)含任务状态、附件 URL/大小/摘要、包内后台报告和未验边界。
