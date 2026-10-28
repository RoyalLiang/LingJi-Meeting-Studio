# v0.1.35 三平台发布核验回执

核验时间：2026-10-28T03:06:03.497Z。结论：五项 CI 全部成功，三平台安装包与更新清单已公开发布并核验。

- 产品源码与工作流 SHA：`7b8e6c4dc7552a78678726f76bc91fe6be3dd6aa`。
- 注解标签：`v0.1.35`，标签对象 `223b75183e875e2fcf80a25fe2fa9a67bc47d244`；未移动旧标签。
- [Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118)；[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.35)。
- 本回执为同版本补记，未重新构建、创建新版本或覆盖附件。

## CI 结果

| 检查 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118/job/122593291553) | success |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118/job/122593415215) | success |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118/job/122593415213) | success |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118/job/122593415221) | success |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40620563118/job/122605669958) | success |

macOS 完成独立 DMG 构建、包校验与启动；Windows 完成原生回归、6 分钟后台录音/重启恢复、EXE 构建与安装验证；Linux 完成 DEB 构建、安装、启动与卸载验证。以上为 GitHub-hosted CI，不能替代用户实际设备与真实会议质量验收。

## 公开附件

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.35-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.35/Lingji-0.1.35-macos-arm64.dmg) | 218388507 | `4b08e30a1b4ca7c6727a36f3ecca74a8f8b92d127b173f9217ad40a0419a27de` |
| [Lingji-0.1.35-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.35/Lingji-0.1.35-windows-x64-setup.exe) | 407149998 | `a72d518a153d72cf56af66b76262d47ba29ade8ec565206f2d08d856b39adb10` |
| [Lingji-0.1.35-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.35/Lingji-0.1.35-linux-amd64.deb) | 221623632 | `574a8c15665032a43fc00b95bf2e5bd3a2256029c38f612365030360a5d91520` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.35/preview-update.json) | 5196 | `c6489a7eb9ce1ac8f700a312c83f978ac65c33ad11134e5c48e2812ca23e3059` |

更新清单中的版本、源码 SHA、三个安装包名称、下载地址、大小和 SHA-256，与公开 Release 的四个附件摘要一致；三个安装包 HEAD 请求均为 200，Content-Length 与清单一致。本机未全量下载三个安装包再计算摘要，完整包构建校验由 CI 完成。

## Linux 托盘运行库核验

对公开 DEB 发起范围读取，HTTP 206，读取 5512 字节取得 `control.tar.gz`，直接解析 control；版本为 0.1.35、架构 amd64。运行依赖：

`libasound2t64, libpipewire-0.3-0, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`

`libayatana-appindicator3-1` 已写入最终安装包，不依赖构建机恰好预装开发库的假设。实际托盘显示仍取决于桌面环境的 AppIndicator/状态区域支持；未在用户 Linux 桌面验收。

## 本地与研究边界

[本地实现证据](settings-update-v0.1.35-2026-10-28.md)：Node573/573、Rust37通过1忽略、lint/typecheck/build/docs通过；1280/390样例、顶部提示、图标键盘展开、3000段 DOM/渲染对照、草稿保留与新增片段可见。真实 WebView2 显存/长期 CPU 与跨 DPI 托盘观感未实测。

[网络/离线词库研究](../research/network-offline-vocabulary-2026-10-28.md)已完成来源与方案核查；未实现词库下载器或新增网络查询，也未将私人名称发送给新服务。
