# Pi 双平台 Actions 测试包

2026-10-31，当前为部分完成：Mac 验证及附件上传成功，Windows 安装器仍在构建/验证。不是 Release 发布回执。

用户确认使用终端推送后，已上传测试分支 `dev_pi-chain-regression-20261031`；未改 main、创建版本标签或 Release。仓库 canonical 名称为 `RoyalLiang/LingJi-Meeting-Studio`，原 `lingji` URL 重定向至此。

[当前构建](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41205937873)冻结源码为 `6e353a88872ea70555f61cae641bc98a48eef193`，应用仍显示 0.2.6。附件按平台与完整源码 SHA 命名，保留 14 天。实际摘要、大小、有效期及当前 Windows 状态见[机器可读回执](../evidence/pi-actions-packages-20261031/receipt.json)。

## 当前验证

Mac 的完整 Node 回归、lint、类型检查、Web 构建、Rust 原生测试、冻结源码打包、DMG/Finder 布局、签名与包级生命周期、Pi 初始化、包内本地 ASR 和附件上传步骤通过。Pi 包级探针要求 agent API 200 且任务数组有效；它不等于真实云模型复盘通过。更早的[本地包内 Pi fixture 及整链证据](pi-local-packages-2026-10-31.md)另行保留。

Windows 的定点打包/来源测试、Web 构建、后端与 ASR 准备、Rust 原生测试通过，当前仍在既有安装器生成及安装/卸载/UI/资源验证脚本内，尚无本轮 Windows 附件，不计为完成。

首次 run `41202556753` 的 Mac 打包失败。固定类别诊断确认 `.DS_Store` 缺失的 ENOENT；专用工作流漏掉原发布工作流的 `TAURI_BUNDLER_DMG_IGNORE_CI=true`。补齐配置后当前 Mac CI 成功。临时诊断已移除，最终工作流仅 `contents:read` 和 Actions 附件上传，不发布 Release。修复只改工作流，供打包的应用/后端/脚本源码与首轮 `5898c90` 无差异。

摘要取自 GitHub API 的 Actions ZIP 附件元数据，不能视为独立下载/安装或内层 exe/DMG 的字节验证；内层校验文件随附件提供。没有下载附件补验。

## 真机测试启动

先将测试程序放到独立测试目录。候选沿用 Preview 标识和 0.2.6 版本，真实既有数据升级未验，建议先以独立数据目录验证。以下路径替换为实际测试程序路径：

Mac（Apple Silicon，macOS 14.6+）：

```sh
TTS_CLIENT_DATA_DIR="$HOME/Library/Application Support/Lingji-Pi-Test-6e353a8" "/你的测试目录/聆记 Preview.app/Contents/MacOS/tts-client"
```

Windows x64（安装包完成后使用）：

```powershell
$env:TTS_CLIENT_DATA_DIR = Join-Path $env:LOCALAPPDATA 'Lingji-Pi-Test-6e353a8'
& 'C:\你的测试目录\tts-client.exe'
```

独立目录不会沿用原模型设置，需要重新配置纪要/Pi 模型；包内 SenseVoice 可测试本地转录。按录制→暂停/恢复→停止排空→逐字稿→滚动/最终纪要→重点隐藏/恢复→原音→导出顺序检查，再授权所选会议文字运行 Pi 复盘，核对引用和重启结果。实体音源、权限、驱动、云 ASR/模型与长会议仍待真机验证。

Mac 为 ad-hoc 签名且未公证，Windows 为未签名测试包；系统信任行为与 CI 隔离安装不同，需要测试者按系统提示确认。
