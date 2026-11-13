# 安装桌面测试版

从[官网立即下载](https://rookiecode.com/#download) 按系统与架构选择安装包；安装包未就绪时可查看 [GitHub Releases](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases) 的发布记录。当前已发布版本为 0.3.29，本轮源码目标为 0.3.30；以实际 Release 和 Actions 结果为准。

官网下载通过独立对象存储提供安装包，不跳转 GitHub。SHA-256、版本和文件大小由完整发布的镜像清单提供；系统识别不等于架构兼容性检测。

| 平台 | 附件 | 条件 |
| --- | --- | --- |
| macOS Apple Silicon | DMG | 测试签名，未公证；见 [macOS 信任说明](macos-trust.md) |
| Windows x64 | NSIS EXE | Windows 10/11 与 WebView2；安装器支持跳过新本地模型、保留升级位置已有模型 |
| Linux x64 | DEB | Ubuntu 22.04/24.04；其他发行版需另外验证 |

系统麦克风、屏幕与系统音频需要分别授权。内置本地转录可以离线使用；云端转录、翻译和纪要依赖相应服务配置，见[本地与云端配置](../engineering/funasr.md)。

安装验证不代表真实声卡、会议内容质量和供应商服务已通过现场验收。已有记录与设置的保留由独立用户数据目录负责，备份与恢复见[运行手册](../engineering/runbook.md)。
