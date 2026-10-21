# 用 GitHub Actions 构建并发布测试版

此流程用于源码＋macOS Apple Silicon **测试包**，独立于四平台正式签名工作流。产物仍为 ad-hoc 签名、未公证，不建立可信自动更新基线。

## 运行

在仓库 Actions 中选择 **macOS preview release**，从 `main` 点击 **Run workflow**。本次填写：

| 输入 | 本次值 |
| --- | --- |
| tag | `v0.1.0` |
| source_sha | `ef9786c1e811acafc7c3fdda44fa180f81a675a8` |

标签必须已存在、对应版本配置且为 main 祖先，解析出的完整 SHA 必须与输入一致。工作流不会创建或移动标签。

1. verify 验证来源并执行发布器的隔离契约回归。
2. build 使用 `macos-15`，实际检查 arm64，在标签源码上执行 `npm ci`、Node/Rust 测试、lint、类型及文档检查，再冻结构建、校验 DMG 与隔离启动/重启。
3. publish 下载本次 run 的 5 个附件，复查字节哈希、构建来源、完整集合及远端标签；匹配并复用已保存草稿，上传后再发布 pre-release。

build 只有 contents:read；publish 使用短期 `GITHUB_TOKEN` 的 contents:write，不要求 PAT、浏览器本地文件权限、Apple 证书或更新签名密钥。正式签名工作流保持原样。

## 来源与重跑

`release.json.sourceRevision` 对应实际标签源码；新增 `ci` 字段分别记录 sourceRevision、workflowSha、runId、runUrl。发布工具来自工作流提交，应用来自冻结标签，二者可能不同，发布说明会同时列出。

5 个发布附件是 DMG、`SHA256SUMS.txt`、`release.json`、`INSTALL-macos-arm64.md`、`package-smoke.json`；源码 ZIP/TAR 由 GitHub 根据标签提供。CI 重新构建的 DMG 与之前本机包不保证字节相同，应使用该次发布附件的 SHA-256。

已有已发布版本一律拒绝修改；未知附件、不同哈希、不同来源或多个候选草稿也会停止，不自动删除或覆盖资产。发布 job 失败后应选择 **Re-run failed jobs**，复用同一次 run 的已验证构建产物。重新执行全部构建可能生成不同字节，不能用它覆盖旧草稿附件；遇此情况先调查并显式处理，不通过移动标签解决。

Actions 成功证明云端构建与指定自动检查通过，不证明真实会议识别质量、实体采音、长会话或全新 Mac 首次安装已验收。

依据：[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Release API](https://docs.github.com/en/rest/releases/releases)、[附件 API](https://docs.github.com/en/rest/releases/assets)。
