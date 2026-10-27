# 用 GitHub Actions 构建并发布测试版

此流程用于源码＋macOS Apple Silicon、Windows x64 和 Linux x64 DEB **测试包**，独立于四平台正式签名工作流。产物为 ad-hoc 签名、未公证，不建立可信自动更新基线。

## 后台触发

推荐使用 Git 推送版本标签自动触发，全程不需要访问发布页面、上传附件或提供本地 PAT。核对远端 main 是本轮提交的祖先，再创建从未使用的 `vX.Y.Z` 标签，优先原子推送 main 与标签。例如发布 0.1.29：

```bash
git tag -a v0.1.29 <已核对的完整源码提交> -m 'Lingji v0.1.29 public preview'
git push --atomic origin HEAD:refs/heads/main refs/tags/v0.1.29
```

标签版本必须与该源码的 `tauri.preview.conf.json` 一致；对应提交必须是远端 main 的祖先。不要复用、移动或强推已发布标签。校验 job 将 GitHub push SHA 解析为 commit 后，与实际标签提交比较；tag push 的控制器和源码必须同一提交。

保留 `workflow_dispatch` 作为后台重跑入口，只允许 main，必须传入已存在的标签及其完整源码 SHA；没有默认源码 SHA。可通过已认证的 GitHub CLI/API 调用。重跑需要遵守下方附件不可变约束，不由浏览器接管上传。

## 工作流与来源

1. verify 验证严格的 `vX.Y.Z`、实际 tag 提交、main 祖先关系和配置版本，执行发布器契约回归；输出冻结源码与控制器的完整 SHA。
2. build 使用 `macos-15` 并实际检查 arm64，在标签源码上执行 `npm ci`、Node 测试、lint、类型及文档检查，准备随包 Node 与 Web，再运行 Rust 测试、冻结构建、校验 DMG 与隔离启动/重启。
3. build_windows 构建并验证 Windows NSIS 安装器；build_linux 在 Ubuntu 24.04 构建 DEB，验证安装资源、原生应用启动/重启、公开样例离线推理及卸载。
4. publish 下载本次 run 的三个平台验证文件，复查哈希、来源、精确集合与远端标签；复用匹配草稿，只上传三个成品安装包后发布 pre-release。

build 只有 contents:read；publish 使用 Actions 短期 `GITHUB_TOKEN` 的 contents:write，无需本地 PAT、浏览器本地文件权限、Apple Developer ID 或公证密钥。发布器再次拒绝分支 push、PR、错误 tag/来源以及非 main 的手动调用。

DMG 步骤使用 `TAURI_BUNDLER_DMG_IGNORE_CI=true`，让 macOS runner 保留配置的背景和 Finder 图标位置。没有取消 `.DS_Store` 与背景字节检查，也没有清空整个 CI 环境。

`release.json.sourceRevision` 是应用源码；`ci.workflowSha` 是控制器提交。tag push 两者相同；手动后台重跑可以不同，均须完整记录。

## 附件与变更说明

公开附件只有 macOS DMG、Windows EXE 和 Linux DEB；源码 ZIP/TAR 由 GitHub 根据标签提供。SHA-256、安装步骤、版本变更和源码 SHA 直接写入 Release 正文；验证 JSON、源码清单、校验文件和安装文档留在 Actions artifacts（保留 14 天），长期核验摘要另存仓库发布回执。

打包器根据版本选择 `docs/releases/vX.Y.Z-preview.md`。正文提取“版本改动与修复”、“本版变化”或“修复与设置”段落；没有非空改动说明时拒绝发布。发布器仍校验全部构建报告，只将通过验证的安装包列入远端上传集合。

已公开 release 和冲突附件一律不覆盖、不删除。若只是 publish 失败，可后台重跑该失败 job，复用同一 run 的已校验附件；重新构建产生不同字节时，不应向旧草稿强行替换附件，应先核对失败回执并选择新的发布版本。

依据：[GitHub push 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)、[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Release API](https://docs.github.com/en/rest/releases/releases)、[附件 API](https://docs.github.com/en/rest/releases/assets)。
