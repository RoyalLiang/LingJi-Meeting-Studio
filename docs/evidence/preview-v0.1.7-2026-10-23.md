# v0.1.7 后台发布核验

源码：`d7ec7fa55e38e37052c64dc25d199b652e51928c`，版本 0.1.7 / bundle 0.1.29。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39895638203) 的 verify、build、publish 全部成功，来源为本轮 v0.1.7 tag push；[公开 pre-release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.7) 已于 2026-10-23T03:43:46Z 发布。

五附件完整下载，API SHA-256 与实际字节一致；DMG 与 SHA256SUMS/release.json 一致。224 个源码文件及总清单摘要与发布源码相符。见[机器核验](preview-v0.1.7-2026-10-23/verification.json)。

[Apple Silicon 安装包](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.7/Lingji-0.1.7-macos-arm64.dmg)：47465033 字节，SHA-256 `96f1dc9902b6adf628c92b5f24c0b06bdd84e2381e66f3dd21ef009b8696ba21`。

本机只读映像、签名、arm64、版本及包内豆包音频转录模块与源码一致，未安装或启动 App，见[本机核验](preview-v0.1.7-2026-10-23/package-local.json)。包内隔离后端启动与重启持久化 smoke 通过；smoke 未调用真实供应商或打开音频设备。测试包为 ad-hoc 签名，尚未公证。

本版增加仅用同一豆包音频模型完成转录和原音纪要的可选模式，保留既有链路、转录修订与纪要引用；包含快速记录和共同时间轴时长修复。403 项 Node 回归、lint、typecheck、Web 构建及 23 项发布/原生配置检查通过。17.37 秒合成中文音频在无独立 ASR 凭据时完成真实模型转录与纪要，详见[本轮功能证据](doubao-only-2026-10-23.md)。

未使用浏览器调试，未改变现有 App 配置，未上传用户真实会议。实际安装后体验、多说话人和长会议准确率、延迟与费用仍需独立验收。

升级后须按[安装与配置](../releases/v0.1.7-preview.md)选择新模式，并为每场会议授权原音处理；旧失败会议需点击“重新处理”。发布回执沿用 v0.1.7，不移动标签或创建额外版本。
