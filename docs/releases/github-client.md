# 安装桌面测试版

从[官网下载](https://rookiecode.com/#download)选择系统：Windows 优先进入[Microsoft Store](https://apps.microsoft.com/detail/9NCW0WT5W9D1)，macOS 与 Linux 使用 GitHub Release。当前 GitHub 测试版为 [v0.3.35.0](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.3.35.0)，商店公开包为产品 `0.3.33` / MSIX `1.3.33.0`，两条渠道分别更新。截至 2026-11-18，新的商店产品 `0.3.35.0` / 包 `1.3.3500.0` 已提交认证，尚未核实公开上架。Windows 也可选择注明版本的独立 EXE。

独立安装包链接固定到已发布的 GitHub 版本和附件；版本、文件大小及 SHA-256 仍由完整发布清单提供。既有官网同源下载地址继续兼容旧入口；系统识别不等于架构兼容性检测。

| 平台 | 附件 | 条件 |
| --- | --- | --- |
| macOS Apple Silicon | DMG | 测试签名，未公证；见 [macOS 信任说明](macos-trust.md) |
| Windows x64 | Microsoft Store（MSIX）；可选独立 NSIS EXE | 商店版要求 Windows 10 2004 或更新版本；独立安装器可跳过新本地模型并保留升级位置已有模型 |
| Linux x64 | DEB | Ubuntu 22.04/24.04；其他发行版需另外验证 |

系统麦克风、屏幕与系统音频需要分别授权。内置本地转录可以离线使用；云端转录、翻译和纪要依赖相应服务配置，见[本地与云端配置](../engineering/funasr.md)。

安装验证不代表真实声卡、会议内容质量和供应商服务已通过现场验收。已有记录与设置的保留由独立用户数据目录负责，备份与恢复见[运行手册](../engineering/runbook.md)。
