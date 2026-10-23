# v0.1.6 后台发布核验

源码：`c2f6ae95cadb40e9e4283cd97de30cde4743ae0b`，版本 0.1.6 / bundle 0.1.28。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39889648021) 的 verify、build、publish 全部成功，来源为本轮 v0.1.6 tag push；[公开 pre-release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.6) 已发布。

五附件完整下载，API SHA-256 与实际字节一致；DMG 与 SHA256SUMS/release.json 一致。223 个源码文件及总清单摘要与发布源码相符。见[机器核验](preview-v0.1.6-2026-10-23/verification.json)。

DMG：`050e05b157964bb5865d2180e4931c1a26f7f1bb9cba08c1f48a93cc3d595fa8`。

本机只读映像、签名、arm64、版本及包内豆包模块与源码一致，未安装或启动 App，见[本机核验](preview-v0.1.6-2026-10-23/package-local.json)。包内隔离后端与重启持久化 smoke 通过；真实设备和供应商不在 CI smoke 范围。

本版修复免填资料快速记录、双音轨时长显示和识别配额提示。独立 ASR 的 audio_duration_lifetime 配额超限仍需控制台恢复。用户后续已授权增加仅豆包模式，将作为下一次功能增量验证和发布；v0.1.6 不包含该模式。测试包仍为 ad-hoc，未公证。
