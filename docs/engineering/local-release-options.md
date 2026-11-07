# 构建和发布测试版

发布使用 `preview-release.yml`。版本配置、标签与安装说明一致，只有全部门禁成功后才创建公开 Release；不得手工上传本地安装包、覆盖附件或移动已发布标签。

## 按平台构建

| 安装包 | 构建位置 | 安装验证 |
| --- | --- | --- |
| macOS Apple Silicon DMG | GitHub Actions macOS runner | macOS 原生 CI |
| Linux x64 DEB | WGS 当前代码目录，Ubuntu 22.04 隔离容器 | 容器内安装/卸载与独立后端、Ubuntu 24.04 CI |
| Windows x64 NSIS | WGS 同一当前代码目录，MSVC 交叉工具链 | Windows Actions 验证 WGS 生成的同一个 EXE |

WGS 使用一次性 `lingji-wgs` runner。`scripts/wgs-build-preview.mjs` 对整个目录加锁，核对无未提交修改后切到固定 SHA，串行生成两平台产物。当前目录为 `/home/westwell/builds/lingji-preview-20261107/source-240245aa`；目录名称不是源码版本凭证，实际 SHA 和完整文件摘要才是依据。

构建工具镜像使用 `tools/release/wgs.Dockerfile`，Rust 1.92.0 与 Windows 标准库存放在 WGS `cache/rust-1.92.0` 独立目录；组件按官方发行清单 SHA-256 校验，不切换主机默认工具链。

两平台分别准备 Node 与本地 ASR 资源；切换平台前清空旧 runtime。构建前后比较源码清单，只允许 Tauri 已知的 Cargo 特征生成差异，随后恢复原文件。遇到其他修改立即停止，不能 reset 用户改动。构建不安装到 WGS 主机，不重启业务服务。

## 在后台发布

验证代码与文档后，确认远端 main 是本轮基线祖先，原子推送 main 和未使用的递增 `vX.Y.Z` 标签。首次重建版本为 `v0.3.0`，之后默认递增 patch。

Actions 收集三平台完整源码清单、来源 SHA、安装验证和产物摘要；不同平台源码不一致或校验失败会阻止发布。macOS 测试包使用 ad-hoc 签名且未公证，Windows/Linux 未做发行签名，不能视为正式信任更新通道。

发布后只查询 Actions 与 GitHub API 的标签、源码 SHA、Release 状态、附件名称、大小和 digest。未经用户另行要求，不下载、解包或安装附件；元数据缺失时直接报告。发布回执留在 `.agent-runtime/`，不为补记回执循环发新版本。
