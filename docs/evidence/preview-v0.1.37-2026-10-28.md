# v0.1.37 三平台发布核验回执

核验时间：2026-10-28T12:21:26.005Z。五项CI成功，四个公开附件已核验。本轮后续修正见[v0.1.39候选说明](../releases/v0.1.39-preview.md)；最终交付等待修正版验证。

源码 `baf134a6efa6f72531cc86a14fb096ea67e959f8`；注解标签对象 `d74a8dad32ee3c08a2fe189434e0199d4ce1b5de`。

[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.37)。

| CI | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523/job/122791008806) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523/job/122791092350) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523/job/122791092438) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523/job/122791092284) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40680893523/job/122807871895) | success |

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| [Lingji-0.1.37-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.37/Lingji-0.1.37-macos-arm64.dmg) | 218404932 | `c85de20abdef67433fe5017c30b136da8e28f500eea1f660aaa68a26d0fb62d3` |
| [Lingji-0.1.37-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.37/Lingji-0.1.37-windows-x64-setup.exe) | 407107078 | `440c62953728117acbb40c8f061f142aa8403d2e0764bc56b7e5aec46d50cabf` |
| [Lingji-0.1.37-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.37/Lingji-0.1.37-linux-amd64.deb) | 221642428 | `b2abaff6296e17ad692737174338c46179b7a0be2196615d433970b1a73f80c0` |
| preview-update.json | 6078 | `71926e770fed519aec2fc3907d628d826fd8c2b8fdba29b3b56138f5c7007bdb` |

版本、标签、源码、三个安装包名称/地址/摘要与公开四附件一致，三个安装包HEAD=200且长度相符。本机未下载全部安装包重算摘要；完整包验证由CI完成。

公开DEB范围读取HTTP206、16384字节，版本0.1.37/amd64，依赖 `libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。

CI包含macOS包验证与启动、Windows隐藏录音/重启回放和安装流程、Linux安装启动卸载。未验证用户原始长会、真实模型和设备原地升级。
