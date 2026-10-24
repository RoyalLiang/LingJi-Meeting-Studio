# v0.1.16 双平台公开测试版发布回执

2026-10-24，后台 [Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40101029050) 的 verify、macOS build、Windows build_windows、publish 全部成功。已核对 [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.16)，十个附件全部下载并验证 API 大小/摘要、版本、固定源码、CI 来源、两个安装包 SHA-256 及两平台一致的 291 个源码文件摘要。

发布源码：`f9f36175d58b63a1cddcdf0835855a14e8be3896`。标签为 `v0.1.16`；发布回执是同版本后续文档提交，不替换已发布附件。

## 安装包

| 平台 | 下载 | SHA-256 |
| --- | --- | --- |
| Windows 10/11 x64 | [EXE 安装器](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.16/Lingji-0.1.16-windows-x64-setup.exe) | `032ec19cead8497c74483fcfd2c465b45b739324eea3f6dfb8d7816c6b7b3b89` |
| macOS Apple Silicon | [DMG](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.16/Lingji-0.1.16-macos-arm64.dmg) | `61bd082fff7e0aac79091ecf1b1b98d4460ce21d2abe7c648bac051560ce0da8` |

其余八附件为各平台安装说明、SHA256SUMS、发布元数据和生产包 smoke 证据。完整 [机器核验结果](windows-resident-2026-10-24/verified.json)包含固定源码及清单摘要。

## 验收范围

- 本机 457 项 Node、29 项 Rust smoke、ESLint、类型、文档与 Web 构建通过。原生合成源覆盖隐藏录音、恢复、正常退出、重启和未发送音频补传；未打开真实音频设备或调用真实模型。
- 正式 Windows 构建再次通过安装、全部运行资源校验、x64 应用 PE、已安装生产应用独立后台启动/重启/退出、四屏界面、取消安装后启动、完成退出及卸载。后台发布受这些检查约束。
- 下载的 macOS DMG 以只读方式挂载，核对版本 `0.1.16`、bundle `0.1.38`、arm64 和严格 ad-hoc 签名。另行启动下载包的生产应用，以隔离目录验证本地账号、独立后台、重启持久化和父进程退出清理；开发服务请求为 0。[下载包验证结果](windows-resident-2026-10-24/mac-download-verified.json)。未替换本机既有应用。
- [本轮实现、根因与实际安装截图](windows-resident-2026-10-24.md)；[安装与功能说明](../releases/v0.1.16-preview.md)。两轴复核发现的版本链接、定时器与控件层级问题均已修复，最终补审无新增确认问题。

关闭窗口后录音、补传和整理继续。需要结束录音时使用会议中的暂停/结束；需要彻底退出时使用系统托盘或菜单栏的退出操作。后台常驻不包含登录自启，Python、FunASR/SenseVoice 服务与模型仍需单独部署。

Windows 测试包未代码签名，macOS 为 ad-hoc 签名且未公证。实体 Windows 音频设备、长会议、休眠恢复、全新电脑的安全提示与模型部署未完成验证；CI 和合成源不能代替这些验收。
