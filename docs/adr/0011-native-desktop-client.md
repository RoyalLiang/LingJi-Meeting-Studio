# ADR 0011：轻量桌面客户端与原生采集

状态：**proposed**。日期：2026-10-13。用户已授权首轮三系统桌面实现，并选择长期轻量、低功耗和采集可控优先；本文仍保留 proposed，不能据此推定签名分发、自动更新或后续阶段已获批准。

## 决策范围

桌面采用 Tauri 2、Rust 与 CPAL，内置现有 React 页面；macOS 使用 WKWebView/CoreAudio，Windows 使用 WebView2/WASAPI，Linux 使用 WebKitGTK/PipeWire。浏览器和移动 Web 入口保留。选型与版本依据见[实现方式调研](../research/cross-platform-client-implementation-2026-10-13.md)。

`CaptureController` 是 Web 与 native 采集的共同接口；原生适配不改动 Record 服务端写入权威、音频标识、哈希、ACK、幂等补传、SSE 游标、转录修订和停止 manifest。Rust 负责设备权限、采集、带限重采样和有界缓冲；React 继续负责 IndexedDB 持久化与服务端协议。第一阶段没有后台录音或关闭窗口后继续上传的承诺。

页面随安装包交付，由仅监听 127.0.0.1 的 Rust 服务提供。它只转发配置好的 Record API，独立的内存 cookie jar 持有服务端会话；上游 cookie 不写入本机 WebView。每个上游有稳定端口与隔离的数据存储，重启后重新登录并保留同一来源的 IndexedDB。连接端口被占用时明确失败，避免静默换来源而遗失队列。

本地连接使用随机 HttpOnly cookie，校验 Host/Origin；原生能力只授予精确本地来源。页面 CSP 禁止 iframe、对象、新窗口及外部导航，不向 JS 暴露任意文件、shell 或目标 URL。窗口标签和来源校验不等于 iframe 身份校验，不能据此声称主框架独占 IPC。

## 取舍

系统 WebView 减少随包分发浏览器引擎的需求，但增加版本兼容、三系统权限与原生音频维护成本。更低功耗与内存是待测目标，不能由框架名称或包体积证明。首轮不引入端侧模型、不重写 UI、不合并音源、不启用自动更新。采集授权、录音告知、云端识别、原音留存和分享继续分开。

## 验证与重新评估

本机验证与平台缺口见[验收记录](../evidence/client-brain-research/native-client-validation-2026-10-13.md)。真实声卡、权限拒绝、设备拔插、休眠恢复、长会话、签名分发与跨系统包必须各自验收。若系统 WebView 的性能或兼容性不能满足测量目标，再评估其他壳；若需旧 macOS 或按应用采集，再增加独立平台适配。
