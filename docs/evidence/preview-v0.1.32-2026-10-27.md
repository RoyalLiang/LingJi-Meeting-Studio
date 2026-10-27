# v0.1.32 发布回执（2026-10-27）

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.32)；[GitHub Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40519874257)。源码与 tag 解引用均为 `1852672bef12b95836a127522957087df9396d19`，macOS build `0.1.54`。本轮先集成已共享的 v0.1.31 播放/计时提交 `234495e1677f912c9eef1232dbd7fcd10f7d4140`，未移动或覆盖已发布标签。

## 已公开附件

公开库存为三个成品安装包加 `preview-update.json`，并保留 GitHub 自动生成的 Source code 入口。四个公开资产摘要均与更新清单及清单本身摘要对照一致；发布器在公开前已对全部平台原始文件、来源与 GitHub 资产摘要进行严格读回验证。

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| Lingji-0.1.32-macos-arm64.dmg | 218370149 | `4aa859ea80989987514b928cac429f42d256b5a3ec9347ea0bb65492518292bf` |
| Lingji-0.1.32-windows-x64-setup.exe | 407087383 | `b2918754238a6a3bdaf5af6b67e152d6c24d03ae5b774ea221090929ecae1402` |
| Lingji-0.1.32-linux-amd64.deb | 221472086 | `d6cd1170d4e31baf13201f3cf01868944ebb3028f3fb72f3a55ccf56b06cb07b` |
| preview-update.json | 6079 | `8a021b6b071a327da7d7db77fcf93a2aa92a01e20ce2184fa1bc267bd6ecb375` |

## 验证结果

- verify、macOS build、Windows build、Linux build、publish 五项后台任务全部成功；包由现有 `preview-release.yml` 构建发布，无本地手工上传。
- 集成后 Node 24.21.0 完整回归 548/548；Rust 37 项通过。lint、typecheck、Web build、185 份 Markdown 引用/围栏检查通过。
- 本地隔离原生冒烟通过设置重开、双音源合成采集、隐藏录制、重启补传、私有会话及CSRF/iframe检查；macOS 原生 NSImage 22pt 尺寸断言实际执行通过。
- 发布后显式执行真实 Rust 更新测试：读取公开 Atom、读取固定版本清单、完整下载 macOS 218370149 字节，并校验 SHA-256/长度，1/1 通过，耗时 495.50 秒。测试未打开安装包或替换用户应用。
- 设置页使用隔离虚构账户验证保存、关闭重开、目标语言保存及滚动；音频/自动翻译同行、图标/居中、底栏按钮同排。AST 删除与旧配置兼容通过定向回归及独立复核。
- 原生下载和CI已经覆盖各自验证层。额外本机三平台续传辅助下载未作为验收依据，临时 Range/并发流程已停止；不宣称在本机完成 Windows/Linux 实体覆盖安装。

## 升级与研究边界

旧 Preview 的禁用更新器无法自我修复，需要手动安装一次本版。下载完成后主动打开系统安装包；先结束录音、完成补传并从托盘退出。旧 AST 密钥不会转换为新版 API Key；使用过 AST 时需重新选择服务或配置新版语音 Key。

多语种与词语/名称集是[研究方向](../research/multilingual-auto-translation-2026-10-27.md)，未在本轮实现语言元数据或大词库纠正。自动翻译仍按当前会议保存。未验收真实会议混语质量、付费 ASR/LLM、长会议、全新电脑及实体三平台跨版本覆盖安装。Preview 仍为 macOS ad-hoc/未公证、Windows 未代码签名；完整性摘要不等于独立签名认证。
