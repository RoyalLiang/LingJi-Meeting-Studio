# 安装桌面测试版

从 [GitHub Releases](https://github.com/RoyalLiang/lingji/releases) 选择 0.3.20 测试版；阅读该版附件说明和已验证平台。版本从 0.3.0 重新开始，旧 Release 与标签按维护要求清理。

| 平台 | 附件 | 条件 |
| --- | --- | --- |
| macOS Apple Silicon | DMG | 测试签名，未公证；见 [macOS 信任说明](macos-trust.md) |
| Windows x64 | NSIS EXE | Windows 10/11 与 WebView2；安装器支持跳过新本地模型、保留升级位置已有模型 |
| Linux x64 | DEB | Ubuntu 22.04/24.04；其他发行版需另外验证 |

系统麦克风、屏幕与系统音频需要分别授权。内置本地转录可以离线使用；云端转录、翻译和纪要依赖相应服务配置，见[本地与云端配置](../engineering/funasr.md)。

安装验证不代表真实声卡、会议内容质量和供应商服务已通过现场验收。已有记录与设置的保留由独立用户数据目录负责，备份与恢复见[运行手册](../engineering/runbook.md)。
