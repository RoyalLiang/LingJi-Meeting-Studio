# v0.2.3 三平台发布核验

状态：2026-10-31（北京时间）已发布公开测试版，完整文件核验时间 2026-10-30 16:19 UTC。[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.3) · [Actions 41082592947](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41082592947) · [安装说明](../releases/v0.2.3-preview.md)。

## 固定来源

- 产品源码及工作流 SHA：`d17d15811564201c403da65bfbd89dd5c7407912`，基于上一版回执 af6d800。
- 注释标签对象：`6aed8f2c8e82ea8f46f3c55df3daa90fcc916895`，`v0.2.3^{}` 指向以上源码。
- main 与新标签原子推送；发布后只补记本回执，不移动标签、不覆盖附件、不另增版本。原共享工作树的 IDE 与播放实验未纳入。

## 构建与交互验证

`verify`、macOS `build`、`build_windows`、`build_linux`、`publish` 五项均成功，总时长33分51秒。匿名 REST 后续限流，最终由 Ego 浏览器公开 Actions 汇总和五项成功图标核对；准确源码由完整 commit 链接确认。[公开状态证据](assets/ui-followups-20261030/actions-public.json)。

本地完整 Node745/745、Rust串行44通过/1忽略、lint、类型、Web构建、文档检查通过。[九项实现、回归与两轴评审](ui-followups-2026-10-30.md)涵盖桌面/390px窄屏、浅色/深色、90秒缺省、浮层零布局位移、滚动保持、键盘焦点、减少动态效果及空队列备份。

- macOS：最终源码重新构建后，两轮实际 WKWebView 合成冒烟通过，覆盖设置重开、340×42顶部悬浮条、重定位/恢复、隐藏9秒采集和重启补传；菜单栏18pt断言通过。CI另完成DMG及包内后台启动/持久化验证。
- Windows：原生回归、两轮各六分钟隐藏采集/重启回放、安装器构建和安装验证成功；此处是隔离CI结果，不代表用户实体麦克风验收。
- Linux：原生回归、DEB构建/安装、包内资源及后台启动/重启验证成功，不把它视为实体PipeWire或混合DPI完整GUI验收。

## 完整附件与摘要

四份公开附件由 Ego 正式下载接口完整保存。三份安装器实际字节数与更新清单一致，四份SHA-256与公开附件摘要一致；清单中的版本、源码SHA、Actions编号及安装器地址全部匹配。

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Lingji-0.2.3-linux-amd64.deb` | 221,816,236 | `b21696ae13223086262a81ec29555e9279c2061fe710f10b8940e020aa5b2e9b` |
| `Lingji-0.2.3-macos-arm64.dmg` | 218,593,841 | `ac0dff1e2e536f6dad90cf64aef48229155a922b408f1e7fea4c01c88988c57c` |
| `Lingji-0.2.3-windows-x64-setup.exe` | 407,419,377 | `84d3cd730c998ef8260f20416bb854ea186a44dc99ec947fcf30bc9780492e31` |
| `preview-update.json` | 4,604 | `5f2feb457882f0e44805642334cb2c247b4c9031c519e10db04e212426f0fdfa` |

[机器可读回执](assets/ui-followups-20261030/release-verification.json) · [公开摘要记录](assets/ui-followups-20261030/public-assets.json) · [公开附件](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/expanded_assets/v0.2.3)。

## 官网与交付边界

同一源码的 [Pages 41082592857](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41082592857)成功；[官网](https://rookiecode.com)和[公开示例](https://rookiecode.com/example)由Ego读取均为200，[状态证据](assets/ui-followups-20261030/site-status.json)。分享功能沿用v0.2.1已验证的D1方案，继续不启用R2；本轮没有重做OAuth或改动分享权限。

本机Applications仍是v0.1.49/build0.1.71，未覆盖用户安装或会议资料，需要升级新包后使用本轮修正。未知身份的占位隐藏不等于新增声纹识别；只有精确修订的可靠来源才显示说话人。原始留证与人工编辑保留。

原始长会议音频已清理，不能用合成测试证明该原会议问题已消除或恢复原音。真实长会议、实体采音、三端完整冷启动耗时和多屏混合DPI仍待现场验证。
