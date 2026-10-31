# v0.1.11 后台发布核验

聆记 v0.1.11 已于 2026-10-23T09:41:08Z 发布为公开测试版。App 版本为 0.1.11，bundle 为 0.1.33，支持 macOS 14.6 及以上的 Apple Silicon。

[Actions 39932259054](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39932259054) 的 verify、build、publish 全部成功，来自本轮标签推送。源码为 `27938ec4c9cf618cdb2b48fc0d26c34f4829ec6f`；远端 `v0.1.11` 注解标签指向同一提交。Release ID 为 `421670461`，非草稿、pre-release。见[发布关联记录](preview-v0.1.11-2026-10-23/publication.json)。

## 下载和摘要已独立核对

[公开 Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.11) 的五个附件已完整下载，各自 SHA-256 与 GitHub API 摘要相符；DMG 摘要同时与 SHA256SUMS.txt、release.json 相符。227 个源码文件及总清单摘要与标签源码相符，见[机器核验](preview-v0.1.11-2026-10-23/verification.json)。

[Apple Silicon 安装包](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.11/Lingji-0.1.11-macos-arm64.dmg)：47,467,921 字节，SHA-256：

```text
aacbbf9dda6a27d943d1f2f325905ec9e72b0e4ad1e64fefe3dc03c75a62e69f
```

本机只读映像校验、严格签名检查、arm64 架构、版本、最低系统版本均通过。包内豆包音频转录模块和波形服务与发布源码逐字节一致，原生二进制包含新的缓冲错误标识且不含旧八包积压停止标识。将包复制至临时目录后，使用独立空数据目录启动成功；原生页面代理按预期要求私有会话。未安装或修改现有 App，见[本机包检查](preview-v0.1.11-2026-10-23/package-local.json)。

本机第一次启动探针使用了含 `/var` 符号链接的临时路径，触发 Tauri 的 macOS 启动路径保护，报资源目录不可用。规范化为真实路径后，同一下载包启动通过；没有为此放宽产品安全限制。前端资源嵌入原生二进制，未把普通文件扫描或未认证页面访问计作界面验证。

## C 波形与采集回归的验证范围

播放器按用户确认的 C 版实现真实 PCM 波形、五个时间刻度、播放游标、居中圆形播放及前后 15 秒、时间跳转与统一倍速菜单。[原生浅色截图](../assets/playback-c-native-light.png)和[深色截图](../assets/playback-c-native-dark.png)来自独立测试 App 的合成音频窗口，验证了 08:36 跳转与 1.25× 选中。它们使用同一 C 版组件，另计于发行包启动核验，未使用浏览器调试。详见[C 版设计与验证](playback-c-2026-10-23.md)。

411 项 Node 回归、27 项原生测试、23 项发布/原生配置检查、ESLint、类型检查、Web 构建及文档检查通过。正式发布 CI 也通过全部原生测试。原生回归通过有限帧同步驱动，确认前端不读取时积压超过旧八包容量，再实际停止并排空全部 179,200 个样本；公开合成采集入口仍按实时节奏运行。

CI 包内 smoke 已验证独立后端、重启持久化、稳定 WebView 配置、父进程拥有后端、本地账号和禁用开发账号，开发后端请求为零。未调用真实供应商或打开采集设备。

[采集修复](pause-speed-2026-10-23.md)消除了已复现的短暂前端积压导致输出队列停止的路径。历史暂停事件缺少原因字段，不能逐次归因为同一问题；真实设备上的后台长会议、原音听感、供应商与新机器安装仍需独立验证。临时缓冲不提供崩溃恢复，旧录制中已缺失的音频也不会因此恢复。

测试包仍为 ad-hoc 签名、未公证，见[macOS 安全提示](../releases/macos-trust.md)。v0.1.8、v0.1.9、v0.1.10 的构建均未发布安装包，旧标签保留；隔离诊断成功后采用未占用的 v0.1.11 发布。本回执沿用 v0.1.11，不移动标签或另建版本。

早期隔离诊断任务 [39912220680](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39912220680) 使用无效的 `macos-15-arm64` 标签，截至 2026-10-23T10:30Z 仍在排队；后续任务已改用正式流程一致的 `macos-15`，隔离诊断 [39929692391](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/39929692391) 已成功。当前只有公开 API 读取与 Git SSH 权限，没有 Actions 取消接口的凭据，因此未取消旧排队任务；它没有发布步骤。
