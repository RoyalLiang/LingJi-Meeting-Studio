# v0.1.49 三平台发布核验回执

核验时间：2026-10-30T01:35:12+08:00（Asia/Shanghai）。五项 CI 与四个公开附件核验通过。源码与构建工作流 SHA：`3d8384d4909f4e761714e3ca00f1085ed816247d`。注解标签 `v0.1.49`，标签对象 `86c6f04888ae05820acf97d8f4dc28c4baba6970`，远端解引用与源码一致。旧标签和附件未修改。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.49)。本回执只补记同版证据，不产生新版本。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449/job/123594901850) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449/job/123595051208) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449/job/123595051189) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449/job/123595051287) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40915614449/job/123617211130) | success |

macOS 完成原生回归、DMG 构建和隔离应用验证；Windows 完成原生回归、两轮后台录音与重启回放，以及安装器、资源、纯云端与升级路径验证；Linux 完成原生回归、DEB 安装、启动与卸载。CI 使用合成输入，不能替代用户设备真实长会议、供应商时延与 GPU 渲染验收。

## 公开附件

| 附件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.49-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.49/Lingji-0.1.49-linux-amd64.deb) | 221673998 | `a6e212a9451e2994e1113bb792da2da69dc1e667431f68b93f91d539e5e393ba` |
| [Lingji-0.1.49-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.49/Lingji-0.1.49-macos-arm64.dmg) | 218448215 | `9d2dc305d74fec75e0080e9f100b856f0016fa19934d48faa83b3af71a8c7c58` |
| [Lingji-0.1.49-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.49/Lingji-0.1.49-windows-x64-setup.exe) | 407164356 | `d0c224135f5917bf1c81f479e247c83dacf745691f7e2917eadfa1eb2be731c7` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.49/preview-update.json) | 4833 | `c7be9a9567d03cc14e60fa7a4427932741b58e456f3e511d9cf986e072f8c7ed` |

匿名 API 配额用尽后，通过公开 Actions 作业图和 Release 附件页读取结论与官方 SHA256。实际下载三个安装包并流式计算摘要，均与附件页及更新清单一致；更新清单本身也核对了官方摘要、源码 SHA、版本、附件名称、大小和下载地址。未在用户本机执行下载的安装器；安装行为仅有隔离 CI 证据，用户机器原地升级未验证。

## 本轮实现与评审

六项实现与验证边界见[学习评审、翻译与播放记录](learning-translation-v0.1.49-2026-10-30.md)。本地 692 项 Node 24 回归通过；lint、typecheck、build:web、check:docs 通过；版本更新后 16 项发布器与源码冻结回归通过。

Standards 最终范围 `44d5941...3d8384d`：0 项需修复问题，完整 12 项 smell baseline 已核对。Spec 发现的 1 项 P2 已关闭：当前 ASR 预览改用独立通道，不受慢确认句阻塞；新增回归通过，最终未解决问题 0 项。

原工作区 IDE 与播放实验改动保留。真实学习 GPU 耗时、真实 ASR/翻译时延、长会话请求量及实体 WKWebView 闪烁改善仍未实测。
