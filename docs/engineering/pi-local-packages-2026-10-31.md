# Pi 本地真机测试包

2026-10-31。源码冻结于 `221dc554f331e5b5db700e2faa7b66e3a5823015`，版本 0.2.6。只生成本地产物，没有推送、标签、GitHub Release 或替换已安装客户端。

## 产物状态

| 目标 | 状态 | 产物 |
| --- | --- | --- |
| macOS Apple Silicon，14.6+ | 本地构建与包级检查通过 | 230.0 MiB DMG；243.9 MiB ZIP，含同一次构建的 app 与隔离启动器 |
| Windows x64 | 未生成安装包，等待构建环境 | 25.8 MiB 源码构建套件；不等于可安装 exe |

本地目录：`dist/local-tests/pi-221dc55/`。详细大小、SHA256 与精确源码在[产物清单](../evidence/pi-local-packages-20261031/local-test-manifest.json)。该目录被 Git 忽略，二进制未入库。

Mac 建议解压 `Lingji-Pi-0.2.6-221dc55-macos-arm64.zip`，使用其中的 `启动Pi隔离测试.command`。已支持的 `TTS_CLIENT_DATA_DIR` 将会议、设置和 WebView 配置隔离到 `~/Library/Application Support/Lingji-Pi-Test-221dc55`，不覆盖或读取原客户端数据；测试实例需自行配置纪要/agent 模型。包内 SenseVoice 可直接用于本地转录。

程序使用本地 ad-hoc 签名，未做 Apple 公证。应用内仍显示 0.2.6，应以文件名的 `221dc55` 和清单识别本候选，不能当成新版远程发行。

## 构建与检查

执行既有 `scripts/release-macos-alpha.mjs`，以 `TTS_RELEASE_CHANNEL=preview` 和完整 `TTS_RELEASE_SOURCE_REF` 冻结已提交源文件，依赖从当前锁定 node_modules 复制并核验版本。原生 release 编译、DMG 校验/挂载、拷贝 app 签名、原生 arm64、Info.plist/最低系统版本等既有脚本检查通过。

- 包内 Node 26.12.1 / SQLite 3.54.0，Pi `pi-durable` / `pi-ai` / `chord` 均为 1.4.0。
- [包级冒烟](../evidence/pi-local-packages-20261031/package-smoke.json)：真实 app 启动独立后端、创建记录并重启恢复、稳定 WebView 配置、父进程拥有并关闭后端、本地账户、开发账户禁用；外部开发服务请求为 0。使用临时测试目录，没有打开实体音源或调用云模型。
- [包内本地 ASR](../evidence/pi-local-packages-20261031/bundled-asr-macos-arm64.json)：原生 SenseVoice 中/英公共音频及静音推理通过；不依赖 Python，不在推理时下载模型；不等于真实会议质量评估。
- [ZIP 解压验证](../evidence/pi-local-packages-20261031/zip-verification.json)：再次核对 app 签名、启动器 zsh 语法与原生可执行文件、Node、agent 后端字节一致性。
- [独立包内 Pi 冒烟](../evidence/pi-local-packages-20261031/packaged-pi-smoke.json)：实际包内 Node 与后端，agent API 200；官方 Pi Harness 经显式 faux 模型执行只读工具并完成，人工纪要不变；干净关闭/重开后结果与请求幂等保留、无模型重放。76 个后端源文件逐字节匹配冻结基线，独立签名检查通过。模型是测试 fixture，没有云调用，未声称 SIGKILL 恢复或实体采集。
- 包内资源没有 `.env`、`providers.json`、`records.sqlite` 或 `records.db`；没有拷贝既有会议或用户模型配置。

前轮 [803 项回归与整链证据](pi-full-chain-validation-2026-10-31.md) 对应同一产品源码；本轮只打包与补充包内验证，没有改产品逻辑，也没有用文档提交冒充二进制基线。

## Windows 缺口

当前主机 Darwin arm64，未发现 Windows VM/MSVC 原生安装器工具链。已安装的 `x86_64-pc-windows-gnu` Rust 标准库不足以构建本项目安装器：原生 UI 用 CMake Win32、MSVC 参数和 Win32 库，既有准备脚本需 `pwsh.exe`；发行脚本还明确限定隔离的 GitHub-hosted Windows CI，并执行安装/卸载。没有伪造 CI 环境变量或绕过这些守卫。

提供 `Lingji-Pi-221dc55-windows-build-kit.zip`，包含此精确提交的完整 `git archive` 源码和 Windows 构建/隔离启动说明。源码套件可离线传输，首次依赖准备仍需联网；Windows 上未执行的命令不得记为通过。已询问用户可用 Windows 构建机/虚拟机与连接方式，收到后才能继续生成和验证 exe。没有为此上传未发布源码到远端。

## 真机测试范围

通过隔离启动器测试录制、暂停/恢复、停止排空、逐字稿、滚动/最终纪要、重点隐藏/恢复、原音、导出；再确认模型发送范围运行 Pi 复盘，核对引用与重启后的任务结果。云 ASR 前轮返回 `45000292`，应用映射为额度不足，本轮没有恢复额度或把该路径标为通过。实体采集权限、设备切换、锁屏、真实云识别/长会议与 Windows 安装仍需真机验证。
