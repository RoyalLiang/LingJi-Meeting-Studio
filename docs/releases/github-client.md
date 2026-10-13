# 用签名 Git 标签创建客户端 Release

更新日期：2026-10-13。用户指定仓库为 [RoyalLiang/lingji](https://github.com/RoyalLiang/lingji)，已只读核实为公开仓库，默认分支为 `main`。发布到这里的制品可公开下载。本轮提供本地工作流、构建脚本和验收；尚未推送提交/标签、创建 GitHub Release 或配置远程密钥。

工作流在 [.github/workflows/client-release.yml](../../.github/workflows/client-release.yml)。发布分两步：签名标签触发四目标构建并创建 draft；检查 draft 后，通过受保护的发布任务将它转为正式 Release。客户端行为见[更新说明](../engineering/client-updates.md)。

## 先准备签名与 GitHub 设置

在 GitHub 建立 `client-release-signing` 和 `client-release` environments，限制可信分支/标签并按团队要求启用人工审核。保护 `main`，为 `client-v*` 设置标签规则，限制创建、更新和删除。启用仓库的 [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)。公开安装包不包含服务端模型配置或认证令牌。

| 配置位置 | 名称 | 用途 |
| --- | --- | --- |
| Repository variable | `CLIENT_RELEASE_REPOSITORY` | `RoyalLiang/lingji`；省略时使用运行工作流的仓库 |
| Repository variable | `CLIENT_RELEASE_SIGNER_KEYS` | 允许发布者的 OpenPGP 公钥 ASCII armor；不是私钥 |
| Repository variable | `TTS_UPDATER_PUBLIC_KEY` | Tauri updater 公钥，编入安装包并用于发布前验签 |
| signing environment secret | `TAURI_SIGNING_PRIVATE_KEY` | 独立 updater 私钥，不能与 OS 签名混用 |
| signing environment secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 私钥密码 |
| signing environment variable | `APPLE_SIGNING_IDENTITY`、`APPLE_TEAM_ID` | Developer ID Application 身份和团队 |
| signing environment secret | `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD` | P12 的 base64 内容与密码；仅导入临时 runner keychain |
| signing environment secret | `APPLE_ID`、`APPLE_PASSWORD` | 公证账户与 app-specific password |
| signing environment variable | `WINDOWS_SIGN_COMMAND`、`WINDOWS_PUBLISHER_SUBJECT` | 已配置签名服务的命令，须包含 Tauri 的 `%1` 文件占位；验收时核对完整发布者 Subject |
| Repository variable | `CLIENT_WINDOWS_SIGNING_RUNNER` | 可选的 Windows 签名 runner 标签；省略使用 `windows-2022` |
| release environment secret | `RELEASE_TOKEN` | 目标仓库 Contents write 和 Administration read，用于上传及核实不可变策略 |

`RELEASE_TOKEN` 使用范围受限的 GitHub App token 或 fine-grained PAT。普通 `GITHUB_TOKEN` 不具备 Administration read，不能替代策略核实。令牌只在 CI 发布任务中使用，不写进更新清单或客户端。

Windows 的证书与 HSM/云签名工具需要由发行者先配置；工作流中的通用 `signCommand` 不负责申请证书、安装厂商 CLI 或提供硬件访问。使用专用 runner 时，还需隔离不可信 PR，并安装 GitHub Actions 所需运行环境。步骤遵循 [Tauri Windows 签名文档](https://v2.tauri.app/distribute/sign/windows/)。macOS 必须通过 Developer ID 签名、公证票据和 Gatekeeper 检查，见 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)。

updater 私钥需要离线备份和恢复演练。公钥轮换必须让旧客户端先通过原可信密钥接收过渡版本；直接更换 CI 密钥会使已安装客户端无法更新。不得在工单、日志或命令输出中粘贴私钥。

## 对齐版本，再创建签名标签

标签格式为 `client-vX.Y.Z`，预发布为 `client-vX.Y.Z-alpha.N`、`-beta.N` 或 `-rc.N`。不接受 build metadata、前导零或路径片段。以下三个版本必须完全相同，更新对应 lockfile 后提交：

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

Web/API 版本不必随客户端一起变化。先确认后端安全更新协议 v1 可用，完成 Node、Web、Rust 与场景验收，再把待发布提交合入 `main`。标签必须是 OpenPGP 签名的 annotated tag，指向 `origin/main` 可达提交；工作流只导入允许的签名者公钥并验证标签。

本地只读预览示例：

```sh
CLIENT_RELEASE_REPOSITORY=RoyalLiang/lingji npm run release:client:plan -- client-v0.1.0
```

准备正式发布时，由获授权的发布者执行以下远程操作。它们不由本轮本地实现自动执行：

```sh
git tag -s client-v0.1.0 -m 'Lingji client 0.1.0'
git push origin client-v0.1.0
```

不要删除已发布标签、移动同名标签或覆盖资产。需要修复时发布更高版本。GitHub 工作流的手动触发也要求已存在且通过验证的签名标签。

## 四个目标全部成功才汇总 draft

| 目标 | Runner | 安装/更新制品 |
| --- | --- | --- |
| macOS arm64 | `macos-15` | DMG、签名 `.app.tar.gz` |
| macOS x64 | `macos-15-intel` | DMG、签名 `.app.tar.gz` |
| Windows x64 | `windows-2022` 或专用 runner | 签名 NSIS `.exe` |
| Linux x64 | `ubuntu-24.04` | 签名 AppImage |

macOS 最低版本仍为 14.6。首轮不宣称支持 Windows/Linux ARM、Linux 的所有发行版或 Wayland/PulseAudio 组合。需要对应系统的安装、采集、暂停/停止、离线补传和升级测试。Linux 首轮按 Ubuntu 24.04 或兼容环境设定构建基线（glibc 2.39，PipeWire 至少 0.3.53）；不宣称产物可以直接运行于 Ubuntu 22.04。CPAL 0.18.2 启用 PipeWire 的 v0_3_53 接口，而 Ubuntu 22.04 默认开发包为 0.3.48，见[Ubuntu 官方包](https://packages.ubuntu.com/en/jammy-updates/libpipewire-0.3-dev)。

CI 使用 Node 24、Rust 1.92.0、lockfile、`npm ci` 和 Cargo `--locked`；依赖的 GitHub Actions 固定到完整 commit SHA。每个目标记录源码 SHA、版本、工具版本、文件大小和 SHA-256。macOS CFBundleVersion 按 GitHub run number 单调编码；保留工作流运行序列，不复用旧值。当前不宣称逐字节可复现构建。

构建步骤不启用 `smoke-test`，只有签名构建步骤拿到对应密钥。汇总脚本要求四个目标齐全、源码和版本一致、OS 签名已验证，重新计算所有字节的哈希，并用 `minisign` 验证 updater 签名和可信版本注释。只有制品、签名与元数据上传为 Actions artifact，构建配置和私钥不上传。

draft 包含安装包、更新包、`.sig`、四份 `release-*.json`、`SHA256SUMS.txt` 和 `latest.json`。清单中的下载 URL 固定到具体标签；只有清单发现入口使用：

```text
https://github.com/RoyalLiang/lingji/releases/latest/download/latest.json
```

创建失败可能留下部分 draft。脚本拒绝覆盖已有资产，先核实失败原因和 draft 字节，再明确处理未发布 draft；不要用 `--clobber` 掩盖失败。

## 检查 draft 后单独发布

在工作流 **Run workflow** 中填写同一标签，将 `publish_existing` 设为 `true`。发布任务重新下载 draft，核对资产集合、所有哈希、更新签名、可信版本、源码 SHA 和清单一致性，通过后才退出 draft。

stable 设为 latest；alpha/beta/rc 设为 prerelease 且不成为 latest。正式发布后检查 GitHub 返回 `immutable: true`。保护 environment 的审批、签名凭证及 immutable releases 设置是发行准备工作，不能由本地测试替代。

如果未来源码转为私有，可使用独立公开分发仓库，通过 `CLIENT_RELEASE_REPOSITORY` 指定它。私有源仓库的已签名标签与源码 SHA 由源 CI 验证；分发仓库中的同名标签不代表那里包含私有源码。目标仓库仍需相同 token 权限、不可变策略与公开下载条件。

首次对外发布前还需在真实网络中验证 GitHub 下载可达性、签名旧版本到新版本的升级、macOS/Windows/Linux 安装与重启，以及 API 相邻版本兼容。此轮没有执行这些远程和发行验收。
