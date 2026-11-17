# 构建和发布测试版

发布使用 `preview-release.yml`。版本配置、标签与安装说明一致，只有全部门禁成功后才创建公开 Release；不得手工上传本地安装包、覆盖附件或移动已发布标签。

## 按平台构建

| 安装包 | 构建位置 | 安装验证 |
| --- | --- | --- |
| macOS Apple Silicon DMG | GitHub Actions macOS runner | macOS 原生 CI |
| Linux x64 DEB | WGS 当前代码目录，Ubuntu 22.04 隔离容器 | 容器内安装/卸载与独立后端、Ubuntu 24.04 CI |
| Windows x64 NSIS | WGS 同一当前代码目录，MSVC 交叉工具链 | Windows Actions 验证 WGS 生成的同一个 EXE |

Actions 继续负责调度和留证，所以运行页面仍会显示各平台作业。`WGS build - Linux and Windows` 在自托管 WGS runner 上执行；Windows 和 Ubuntu 作业接收这次构建的产物做原生验证。Windows 还会编译带 `smoke-test` 的调试程序，用于隐藏录音与重启回放；发布安装器来自 WGS，不在该步骤重新打包。最后由发布作业核对并发布同一份已验证产物。

WGS 使用一次性 `lingji-wgs` runner。`scripts/wgs-build-preview.mjs` 对整个目录加锁，核对无未提交修改后切到固定 SHA，串行生成两平台产物。当前目录为 `/home/westwell/builds/lingji-preview-20261107/source-240245aa`；目录名称不是源码版本凭证，实际 SHA 和完整文件摘要才是依据。

构建工具镜像使用 `tools/release/wgs.Dockerfile`，Rust 1.92.0 与 Windows 标准库存放在 WGS `cache/rust-1.92.0` 独立目录；组件按官方发行清单 SHA-256 校验，不切换主机默认工具链。

两平台分别准备 Node 与本地 ASR 资源；切换平台前清空旧 runtime。构建前后比较源码清单，只允许 Tauri 已知的 Cargo 特征生成差异，随后恢复原文件。遇到其他修改立即停止，不能 reset 用户改动。构建不安装到 WGS 主机，不重启业务服务。

## 在后台发布

验证代码与文档后，确认远端 main 是本轮基线祖先，原子推送 main 和未使用的递增 `vX.Y.Z` 标签。首次重建版本为 `v0.3.0`，之后默认递增 patch。

Actions 收集三平台完整源码清单、来源 SHA、安装验证和产物摘要；不同平台源码不一致或校验失败会阻止发布。macOS 测试包使用 ad-hoc 签名且未公证，Windows/Linux 未做发行签名，不能视为正式信任更新通道。

发布后只查询 Actions 与 GitHub API 的标签、源码 SHA、Release 状态、附件名称、大小和 digest。未经用户另行要求，不下载、解包或安装附件；元数据缺失时直接报告。发布回执留在 `.agent-runtime/`，不为补记回执循环发新版本。

## Microsoft Store 提交包

WGS 容器使用同份程序和资源额外封装 MSIX，Windows 作业验证原包，并保留未签名提交包与隔离安装验证回执。它在商店审核前不会加入 GitHub Release 或 OSS 下载目录，具体身份、版本映射和官网启用流程见[微软商店分发](microsoft-store.md)。


发布前执行[功能与发布回归](release-regressions.md)。`preview-release.yml` 在 main 代码推送后自动运行候选；手动触发默认 `publish=false`，可用计划 tag 名和固定 `source_sha` 验证全部平台而不创建 tag。候选全部成功后再创建 tag；tag 触发或显式 `publish=true` 时，verify 会通过 Actions API 强制寻找同产品版本、源码 SHA 与工作流控制器 SHA 的成功候选，缺失则停止。只有通过该门禁才进入发布构建与 publish。

兼容过渡版之后，公开版本使用 `X.Y.Z.R`；工具链、MSIX 和 macOS 交接的映射见回归文档。四段产品号不直接写进 npm/Cargo/Tauri 或签名客户端的 SemVer 清单。

候选产物目录按产品号和完整源码 SHA 隔离：`dist/releases/<产品号>/<SHA>/linux-x64` 与 `dist/wgs-input/<产品号>/<SHA>`。同版本修正重新验证时保留旧候选，不覆盖文件或跳升产品号；同一 SHA 的候选与正式发布仍须先核验完整回执、摘要及平台验证结果才复用。源码继续只使用上述当前目录。
