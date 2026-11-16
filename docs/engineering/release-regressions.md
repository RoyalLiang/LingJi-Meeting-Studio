# 功能冒烟后的发布回归

每次功能修改先执行 `npm run test:smoke`，通过后执行 `npm run test:release-regression`；`npm run verify:feature` 串行完成两步。随后运行完整 Node 回归、lint、Web 类型检查和构建。发布工作流也按这一顺序执行，不能以功能冒烟代替安装包回归。

| 已出现的故障 | 固定回归入口 | 验收边界 |
| --- | --- | --- |
| 后端嵌套依赖、缺失锁定依赖、可选 peer 被误打包 | `records-backend-dependencies` | 检查真实依赖树与打包闭包 |
| WGS 复用旧产物、源码漂移或平台资源混用 | `records-wgs-build-contract` | 固定 SHA、完整文件摘要与目录锁；两个平台串行 |
| MSIX 包内 Fixed WebView2 无法从 WindowsApps 启动、缓存不完整 | `records-windows-msix`、`test-windows-msix.ps1` | 临时签名副本安装，正常 AUMID 冷启动及再次启动，验证真实 WebView 进程与缓存摘要 |
| 包内后端、模型路径与用户数据位置混淆 | `records-desktop-entry`、原生测试、Windows MSIX 脚本 | 包内后台启动及只读本地模型推理；不以文件存在代替运行 |
| Windows 音频落盘刷新方式不兼容 | `records-audio-storage-sync` | Windows 文件刷新与 POSIX 目录屏障分别检查 |
| 隐藏目录的验证证据未上传、混淆源 SHA 与工作流 SHA | `records-preview-release`、平台 artifact 上传 | 隐藏证据显式保留；源码、运行、产物与摘要一致 |
| 官网下载 503、旧脚本缓存、HEAD/Range 行为退化 | `records-site-downloads`、`records-site-download-upload` | 本地合约后，发布后单独核对 API 元数据与公网行为 |
| 四段修订被旧解析器忽略、按字符串比较或重复编码 | `records-preview-version`、Rust preview updater 测试 | 旧三段补零；`.9 → .10`；native 与 MSIX 单调；macOS 交接身份与版本 |

三平台构建、Windows NSIS 与 MSIX、Ubuntu 22.04/24.04、macOS 原生检查在 Actions 中执行。推送 main 的代码改动会自动对固定 SHA 运行候选验证；也可用 `preview-release.yml` 的 `publish=false`、计划版本和固定 `source_sha` 手动验证，无需预建 tag；全部检查成功后才创建不可变 tag 并发布。候选成功不等于已经发布或商店审核通过。

公开版本从兼容过渡版之后使用 `X.Y.Z.R`，修订号 R 为 0–99。npm/Cargo/Tauri 和安装器采用合法三段版本 `X.Y.(Z*100+R)`；MSIX 为 `(X+1).Y.(Z*100+R).0`，编码后的 patch 不超过 65535。根 `package.json.releaseVersion`、Rust `product-version.txt` 与对外标签、文件名、说明使用同一产品版本；工具链配置和包内部版本使用 native 映射。旧三段版本保留原义，不重新编码已发布包。

v0.3.34 是一次兼容过渡版，使现有只识别三段 tag 的客户端获得新版解析器；其后的修补从 v0.3.34.1 开始，不移动旧标签。普通签名客户端的 Tauri `latest.json` 仍使用合法 SemVer，不能把四段产品号直接放进该清单。

真实 PostgreSQL/S3、声卡与供应商验收单独留证。公开附件发布后仅核对 Actions/API 中的名称、大小和摘要；未另行要求时不下载、解包或安装复测。
