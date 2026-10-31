# v0.1.50 发布核验回执

核验时间：2026-10-30T05:17:53.034Z。公开测试版已发布；源码、五项后台工作流和四个公开附件已核对。

源码：`47b588b7dfab999ba682886750e1410bd21990ee`；标签：`v0.1.50`。[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860) · [Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.50)。源码包含方案 A，以及用户最终指定的浅黄色、窗口顶部居中、桌面单行独立 Toast。

## 后台结果

| 工作流任务 | 结果 |
| --- | --- |
| [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860/job/123894014525) | 通过 |
| [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860/job/123894092146) | 通过 |
| [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860/job/123894092179) | 通过 |
| [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860/job/123894092169) | 通过 |
| [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41003806860/job/123904820476) | 通过 |

本地 Node 24 全量 697 项及 lint、typecheck、build:web、check:docs 通过；42 项定点组件/通知测试通过。独立评审与实际 React 浏览器验证确认：900/1280/1600px 当前提示单行，窄窗口允许自然换行，卡片关闭不影响 Toast，关闭记忆和重试保持。

## 公开附件

| 附件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.50-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.50/Lingji-0.1.50-macos-arm64.dmg) | 218457082 | `c28b5fc80ef27a4c0940ce055ae650ebcce3c5c98bdd22ed3c1b8c1da7e19067` |
| [Lingji-0.1.50-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.50/Lingji-0.1.50-windows-x64-setup.exe) | 407292419 | `a758f047c6dc233dc55b80b409b34d6e9e71a33ff095cc2b4825a00cd11ec962` |
| [Lingji-0.1.50-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.50/Lingji-0.1.50-linux-amd64.deb) | 221675182 | `da7c97eab673ce88ac33661408910566106ae81d804ceb33492ce860ef8efc66` |
| [preview-update.json](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.50/preview-update.json) | 4897 | `76e85fc01e3151443cfc6c7ff9fd7899bcc9b2bb3e0a65d8f5432c6dcf5e88c8` |

公开更新清单已下载并本地重新计算 SHA-256，与 GitHub 附件摘要一致；清单的源码版本、三平台文件名、大小、下载 URL 与 GitHub 附件摘要逐一匹配，三个安装包下载端点返回 200。安装包的完整文件未在本地再次下载重算哈希；使用 CI 产物校验与 GitHub 已上传附件的摘要核对。

## 边界

本轮修改提示布局与重点阅读，不修改录音起止或模型超时。实体 Windows/macOS WebView、用户真实长会议及真实模型超时未重放。原型方案归档已补推到 `dev_highlights-floating-prototype-20261030`（`54fc9ba`）。发布回执仅补记文档，沿用 v0.1.50，不创建新版本。
