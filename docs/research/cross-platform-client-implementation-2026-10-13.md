# 跨系统客户端实现方式调研

调研日期：2026-10-13。范围：macOS、Windows、Linux 桌面客户端；移动端只记录边界。本报告基于仓库现状与官方文档、固定版本源码；“官方事实”“实现建议”“待实机验证”分别表述。文档不代表三系统客户端已经交付。

## 当前推荐：Tauri 2、Rust 原生采集与现有 React 工作台

用户已明确选择“长期轻量、低功耗与采集可控优先，接受更多原生开发”。据此，正式演进方向推荐 **Tauri 2 + Rust 原生音频模块 + React/现有 Record 协议**。Electron 保留为最短交付路线和行为对照，不能因为套壳容易就将它定为长期最优方案。低功耗与资源占用是这一路线的优化目标；本轮没有同负载实测，不承诺具体收益。

关键区别在于采集所有权。Tauri 提供窗口、WebView、IPC、权限与分发工具；Rust 音频模块负责设备、采样、缓冲与释放；现有 Web 工作台继续负责 Record 会话、上传队列和业务交互。把采集放进 Rust，才能逐步减少录制对 WebView 活跃状态和浏览器媒体 API 的依赖。壳本身不是音频引擎。[Tauri 架构](https://v2.tauri.app/concept/architecture/)、[Tauri WebView 版本](https://v2.tauri.app/reference/webview-versions/)

本轮建议完成一个可验证阶段：内置 React 构建资源，通过明确的本地 API proxy 连接服务端；macOS 原生麦克风与系统音频采集经受限 IPC 接入现有上传队列，形成可运行的本地 `.app`，同时完成可重复的协议和生命周期测试。Windows/Linux 保留明确的适配入口，分别实机验收后再声明支持。签名、公证、自动更新和移动端均是后续阶段。

## 仓库约束与复用边界

当前主入口为 React/Vite Web、Record API 与 worker。Web 的 fetch、SSE、AudioWorklet 和 IndexedDB 围绕同源 `/api` 工作；调研启动时的 `apps/desktop` 是 HTML 预览，不是已经完成的原生客户端。既有 Tauri 迁移文档属于历史设计，不能作为已实现证据。当前状态以 [文档索引](../README.md) 和 [现状说明](../engineering/current-state.md) 为准。

复用 React 页面不等于无条件复用浏览器采集。建议保留现有浏览器 controller，新增 native controller，在入口按 Tauri 环境选择；原生端输出的 PCM 仍使用既有 record/session/source/epoch/sequence、幂等上传、持久化确认和停止排空语义。服务端 ASR/LLM 配置继续留在后端。

当前正式方案是 **bundled React + 显式本地 HTTP server/proxy**，不是远程页面直接获得原生命令。Rust 只绑定 `127.0.0.1`，从内置资源提供同一份 React 构建，并将 `/api` 流式代理到配置的可信上游；Web 的相对 API 与队列实现可复用，但连接、鉴权与存储 origin 已改变，需要新增验证。

| 接入方式 | 可复用内容 | 必须处理的边界 |
| --- | --- | --- |
| 内置 React，经固定 loopback origin 访问 API proxy（当前选择） | React 构建、相对 `/api`、SSE、Record 与队列逻辑 | 本地服务身份、Host/Origin 校验、隔离的内存 cookie jar、流式代理、稳定端口和版本匹配 |
| 内置 React，直接访问远端 API | 页面源码与 Record 语义 | cookie/CSRF/CORS、SSE、凭证与 API base URL 需专门适配 |
| 加载 hosted Web，并授权有限 native commands（保留对照） | 原服务同源登录与队列逻辑 | 远程更新与页面漏洞扩大本机信任边界，iframe 限制必须额外验证 |

同一上游 origin 应使用稳定的本地端口/存储映射；端口占用或映射冲突明确失败，不能临时换端口后表现为“数据丢失”。不同上游不得误共用同一个 cookie/IndexedDB origin。macOS 应按上游使用稳定的 `data_store_identifier`（macOS 14+），而不是假定 `data_directory` 能配置 WKWebView；Windows/Linux 使用各自 data directory。[Tauri 数据存储隔离 API](https://docs.rs/tauri/2.12.3/tauri/webview/struct.WebviewBuilder.html#method.data_store_identifier)

独立应用 profile 不接管浏览器中的未传音频，原浏览器队列保留自己的恢复路径。内置资源解决页面资源的离线冷启动，不能因此承诺离线登录、服务端数据可用或录制数据已原生落盘。[Tauri Vite 集成](https://v2.tauri.app/start/frontend/vite/)、[Tauri WebView 数据目录](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html#method.data_directory)

本地 proxy 的设计建议与验收面：

- 仅代理配置的可信上游 API，禁止客户端传任意目标 URL；远端生产连接要求 HTTPS，保持证书校验。开发环境的 HTTP 例外须显式配置。禁止自动跟随重定向，避免绕过目标边界；跨域 SSO 不属于首轮已保证能力。Reqwest 默认会跟随有限数量的重定向，必须显式设置 `Policy::none()`。[Reqwest redirect policy](https://docs.rs/reqwest/latest/reqwest/redirect/struct.Policy.html)
- 本地先校验准确的 HTTP `Origin` 与连接 cookie；转发时使用配置上游的 Host/Origin，保留 CSRF token 校验，禁止未受信来源借代理登录或写入。不能把本地 Host 发给远程 HTTPS 虚拟主机，也不能靠删除 Origin 绕过服务端 CSRF。该转换与服务端固定公开 Origin 必须集成测试。
- 每个上游由独立 Reqwest client 的内存 cookie jar 保存会话；不转发浏览器 `Cookie`，不向本地页面下发上游 `Set-Cookie`，不改写 Secure/Domain。浏览器继续通过现有 CSRF JSON/header 参与校验，proxy 按上游 origin 映射请求头并由 jar 带上会话。登录在同一 app 进程内跨页面 reload 保留，重启需重新登录；退出应清除远端/本地 jar 状态。本轮不把凭据写到磁盘，持久化与 OS keychain 另做阶段。[Reqwest Cookie Jar](https://docs.rs/reqwest/latest/reqwest/cookie/struct.Jar.html)
- 采用 jar 隔离的原因之一是 cookie 标准不按端口隔离；不同 loopback 端口只隔离 IndexedDB origin，不能代替会话隔离。稳定 origin、按上游划分的 profile 和 jar 都应有测试，并覆盖两个上游同名 cookie、登录/退出、重载与重启。[HTTP Cookie 标准](https://httpwg.org/specs/rfc6265.html)
- 请求与响应均按流转发，SSE 不先收集完整响应；处理取消、错误状态、Content-Type、多个响应头、压缩与传输相关 header。Axum 提供流式 Body 构造，但是否正确保留本项目上传与 SSE 语义仍需集成测试。[Axum Body](https://docs.rs/axum/latest/axum/body/struct.Body.html)
- 内置资源响应设置 CSP，禁止 frame/child 嵌入，并限制脚本与连接来源；capability 只授权实际 local origin 的主 WebView 与窄采集命令，不授权 fs/shell。

## 首轮候选比较

| 方案 | React 与协议复用 | 系统音频实现位置 | 主要成本 | 适用权重 |
| --- | --- | --- | --- | --- |
| PWA/浏览器 | 最高；同源协议直接复用 | 浏览器与系统共享能力 | 系统音频、后台生命周期和平台权限差异仍受浏览器约束 | 免安装、普通麦克风场景 |
| Tauri 2 + Rust audio | 高；增加受限 native controller | CPAL/原生平台 API | Rust、系统 SDK、音频与 IPC 的长期维护 | 当前选择：轻量、采集可控 |
| Electron | 最高；hosted 薄壳可直接复用浏览器采集接口 | Chromium/Electron 媒体栈，必要时仍需原生模块 | 分发 Chromium、持续安全升级与平台采集差异 | 最短交付、统一浏览器行为 |

Tauri 使用系统 WebView：Windows WebView2、macOS WKWebView、Linux WebKitGTK。它减少自行分发浏览器引擎的需求，也把一部分兼容性带到系统 WebView 版本上。Electron 随应用分发 Chromium，更便于统一浏览器行为；这不等于系统音频在三个系统上具有相同能力。上述取舍是架构事实与工程判断，不是功耗测试结果。[Tauri WebView 版本](https://v2.tauri.app/reference/webview-versions/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)

## 最小 Rust 音频模块：先固定 CPAL，再验证平台能力

建议首轮固定 `cpal = "=0.18.2"` 并提交 lockfile，而不是跟随 `master`。官方 0.18.2 发布于 2026-08-16，已包括 CoreAudio、WASAPI、PipeWire 的采集错误与 xrun 报告；其未发布分支还包含 API 变化，不能照抄成当前稳定 API。尤其不能使用未发布的 `StreamTrait::stop` 排空能力来解释 0.18.2 的行为。[CPAL 版本文档](https://docs.rs/cpal/0.18.2/cpal/)、[CPAL 变更记录](https://github.com/RustAudio/cpal/blob/master/CHANGELOG.md)

| 平台 | 官方实现事实 | 首轮建议与未验证项 |
| --- | --- | --- |
| macOS 麦克风 | CPAL CoreAudio 输入；0.18.2 声明 macOS 14.2+ | 枚举输入设备，协商实际格式，再转换为项目 PCM 格式；实测拒绝权限、拔插和默认设备变化 |
| macOS 系统音频 | CPAL 已实现 CoreAudio Tap；其 loopback 最低要求是 macOS 14.6+ | 对选定 output device 用 output config 构建 input stream；需要实际有声验证，不能以建流成功替代 |
| Windows 麦克风/系统音频 | CPAL 默认 WASAPI；output device 构建 input stream 自动进入 loopback | 针对 Windows 10/11 实机验证；先抓输出端点混音，不承诺逐应用过滤 |
| Linux 麦克风 | 默认 ALSA；可选原生 PipeWire/PulseAudio host | 显式选择可用 host；不要把 ALSA 默认设备成功等同于桌面音频路由完整 |
| Linux 系统音频 | CPAL PipeWire 对 sink 的 input stream 设置 capture-sink；PulseAudio input 接受 source | PipeWire 与 monitor source 是可验证路径，需分别验证发行版、音频服务与打包依赖；首轮未验证则显示不支持 |

依据是固定 tag 的 [CPAL 平台与依赖声明](https://github.com/RustAudio/cpal/blob/v0.18.2/README.md)、[macOS loopback 实现](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/coreaudio/macos/loopback.rs)、[WASAPI 实现说明](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/wasapi/mod.rs)、[PipeWire sink capture 实现](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/pipewire/device.rs)、[PulseAudio source 实现](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/pulseaudio/mod.rs)。源码说明存在实现路径，不证明本项目在目标设备上已经可用。

### macOS：CoreAudio Tap 可先复用，避免先手写完整桥接层

Apple 的 CoreAudio Tap API 和官方示例要求 macOS 14.2+，可采集进程或进程组的输出，并经 aggregate device 作为输入流读取。系统音频需要 `NSAudioCaptureUsageDescription`；麦克风另需 `NSMicrophoneUsageDescription`，Hardened Runtime 分发时还要核对 audio-input entitlement。两种权限与本轮采集确认分别处理。[Apple 麦克风说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription)、[Apple audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)

CPAL 0.18.2 的实现使用 `CATapDescription`、process tap 与私有 aggregate device，并在销毁时释放二者；其 README 将可用 loopback 门槛提高到 **14.6+**。Apple API 下限与 CPAL 支持下限必须分开记录。[Apple CoreAudio Tap](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)、[CPAL loopback 生命周期](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/coreaudio/macos/loopback.rs)

CPAL 自带的 `test_record_output` 使用默认输出设备、输出配置，再构建输入流，说明无需先写 Swift sidecar 才能开始验证。该实现按输出设备采集，公共 API 不能据此承诺逐应用选择。若需要 macOS 14.2–14.5、旧系统或逐应用过滤，再评估直接 CoreAudio Tap/ScreenCaptureKit adapter，并给出独立版本矩阵。[CPAL CoreAudio 测试](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/coreaudio/macos/mod.rs)、[Apple ScreenCaptureKit 示例](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)

### Windows 与 Linux：按原生音频模型验证

Windows WASAPI loopback 读取 render endpoint 的系统混音，要求 shared mode，并不保证受保护内容可录。选定窗口不等于只录该窗口声音；逐进程捕获应作为另一个明确能力研究。[Microsoft WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)、[Microsoft application loopback 示例](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)

Linux 应优先验证 CPAL 的原生 PipeWire host，显式启用 feature 并选择 host；固定版本源码已有 sink capture 设置。PulseAudio 则应选择实际 monitor source，不能将 Windows/macOS 的 output-device 用法直接推广。Linux 包还需要相应系统开发库与运行时服务，不能通过跨平台编译成功证明录制可用。[CPAL PipeWire 设备实现](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/pipewire/device.rs)、[CPAL Linux 依赖](https://github.com/RustAudio/cpal/blob/v0.18.2/README.md)、[PipeWire streams](https://docs.pipewire.org/devel/page_streams.html)

## IPC、权限与停止排空

建议 Rust 对外只暴露 `capture_inputs`、`capture_start`、`capture_read`、`capture_stop` 这一类窄接口；具体命名由实现决定。音频回调只把样本放入预分配、有界缓冲，不在回调中写文件、访问网络、等待 JS、序列化 JSON 或执行阻塞锁。转换采样格式、声道与分块放在工作线程；重采样可用固定版本 Rubato，必须处理其算法延迟与尾部 flush，不能只看输入输出块长相等。[Rubato 流式重采样](https://docs.rs/rubato/latest/rubato/)

溢出、设备失效和 xrun 必须返回明确状态，不能默默丢样后仍标记完整录制。这是本项目的实现建议，不是 CPAL 自动提供的可靠性保证。

首轮可用 `capture_read` 返回 raw IPC `Response` 的二进制块，由 native controller 拉取后交给现有持久化与上传队列。Tauri 默认返回值经 JSON；官方提供 `ipc::Response` 返回 ArrayBuffer，并建议 Channel 用于有序流。普通 Event 的 payload 是 JSON，官方说明不面向高吞吐、低延迟；不要用每个 PCM 样本一个事件的方式传输。官方没有保证这些路径跨平台零拷贝，实际复制与调度成本需测量。[Tauri Rust 调用与二进制返回](https://v2.tauri.app/develop/calling-rust/)、[Tauri Channel 与 Event](https://v2.tauri.app/develop/calling-frontend/)

`capture_stop` 应停止生产新样本，然后让转换线程、native 缓冲、JS 队列按顺序排空，再完成既有服务端停止协议；CPAL 0.18.2 的 stream drop 不代表这些队列或网络已排空。需要固定 session/source/epoch 与最终块边界，禁止把旧采集块混入新会话。窗口关闭、导航、重复 stop、读取中断和开始失败都要释放 stream/tap；在尚无 native 持久化的阶段，不能声称关闭 WebView 后能继续可靠录制上传。

### 内置页面、本地来源与 iframe 边界

原生 API 不暴露任意 shell、文件路径、网络代理或凭证；每次开始采集用原生确认框说明来源与范围，拒绝即无音频启动。核心命令也要检查会话归属、参数与采集状态，不能仅依赖前端按钮。

Tauri 对远程页面默认不开放命令。但自定义 `invoke_handler` 命令默认可被应用窗口/WebView 使用，必须通过 `AppManifest::commands` 生成受控权限并设置最小 capability；动态 capability 只给实际 local origin 和主 WebView。不能因为插件有 ACL 就假定所有自定义命令已经受同样约束。[Tauri capabilities](https://v2.tauri.app/security/capabilities/)

**主窗口权限不等于主 frame 身份校验。** Tauri 2.12.3 源码将核心 IPC 初始化标记为 main-frame-only；但同源 iframe 可访问父页面对象。官方已修复历史 iframe 越权问题，修复说明仍指出 Windows 同源 iframe 例外；当前 capabilities 文档继续警告 Linux/Android 无法区分 iframe 与窗口请求。不能用 window label 或顶层 URL 宣称已经解决跨系统 iframe 边界。[Tauri 2.12.3 初始化源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.3/crates/tauri/src/manager/webview.rs)、[官方 iframe 安全公告](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)

本地资源响应应实际携带 CSP `frame-src 'none'`/`child-src 'none'`，用禁止嵌入减少子 frame 面；导航与新窗口再限制来源。修改同源脚本、XSS 或恶意本机进程仍是剩余风险，不把 CSP 描述为顶层页面身份认证。Linux 原生桥若尚无对应验证，保持关闭。Hosted 方案保留为对照时，必须单独处理服务热更新、可信 origin 与 iframe 的信任扩大，不能直接沿用本地资源的安全结论。

## 可执行的首轮路线与验收

1. **建立 Rust 采集基线。** 固定 CPAL 0.18.2，独立 capture core 与格式转换；用 CLI 或 Tauri 诊断面板枚举设备、采集麦克风和 macOS loopback，报告实际格式、样本数、时长、峰值、错误与缓冲上限。输出样本数大于零不等于有声音，需有声源与静音对照。拒绝权限或不支持系统必须明确失败。
2. **接现有工作台和队列。** Tauri 内置 React 构建资源，通过本地流式 API proxy 连接可信服务，加最小采集命令；新增 native controller 与环境选择入口，复用 Record 协议及持久化 ACK。实现逐次授权、拉取二进制块、溢出失败、stop 排空和重复操作幂等。浏览器 controller 继续走现有路径。对登录/退出、CSRF、SSE 增量、音频上传、代理断流、非法 Host/Origin、端口占用和 profile 隔离分别测试；此阶段完成才可称 macOS 原生采集链路接入。
3. **形成可回归的本地包。** macOS 本地免签 `.app` 运行；验证权限文本、无麦克风、拒绝系统音频、并行 mic/system、设备切换/拔插、导航/关闭释放、网络中断后重传、停止尾块与最终确认；运行 Node 回归、lint、Web 类型与构建检查以及 Rust 测试。跨系统编译和纯单元测试分别报告，不替代 Windows/Linux 实机采集。
4. **扩展平台与发行。** Windows WASAPI、Linux PipeWire/PulseAudio 分别完成相同场景矩阵；再做签名、公证、安装包、升级回滚、稳定通道与隐私说明。移动端单列需求与权限，不并入“桌面完成”的验收。

关键验收证据应包括“原生样本 → PCM 分块 → source/epoch/sequence → 服务端持久化 ACK → 停止排空”，而不是仅截取窗口启动图。测试音频、fixture 和 mock 能证明协议行为，不能证明用户机器上系统音频采集成功。目标设备、系统版本、权限状态与测试方式必须随结果记录。

## 安装、签名、更新与移动端

本地包可用于本机验证；对外分发仍需各系统的签名与安装策略。macOS 正式分发需要 Developer ID 签名与公证；Windows 的签名和信誉、Linux 的包格式与运行时依赖分别处理。Tauri 的 updater 支持桌面分发，更新包签名不可关闭；签名密钥、发布服务、HTTPS、版本通道和回滚不是窗口框架自动解决的问题。[Tauri 分发](https://v2.tauri.app/distribute/)、[macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Tauri updater](https://v2.tauri.app/plugin/updater/)

Android/iOS 即便复用 Rust 与 React，也有不同的录音、后台执行与其他应用音频边界。Android playback capture 要求系统版本、MediaProjection 授权及被采集应用的 capture policy 满足条件，不能承诺录制所有应用；iOS 需另行评估 ReplayKit 与产品场景。桌面 loopback 设计不能直接作为移动端能力承诺。[Android playback capture](https://developer.android.com/media/platform/av-capture)、[Apple ReplayKit](https://developer.apple.com/documentation/replaykit)

## Electron 作为短交付路线的保留结论

Electron hosted 薄壳可直接适配现有 `getDisplayMedia`，保持同源登录、SSE、IndexedDB 与上传逻辑，较少触碰 Web 采集接口。安全基线应为 sandbox、contextIsolation、关闭 nodeIntegration、不暴露通用 preload/IPC、限制导航与权限请求，并检查可信来源。若没有原生桥，远程页面不能因此获得 Node 权限。[Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)

当前 Electron 官方文档记载 macOS 14.2+ 可经 CoreAudio Tap 捕获桌面音频，并要求 `NSAudioCaptureUsageDescription`；较旧 macOS 有独立限制。Windows 可使用 session display-media handler 的 loopback；Linux/PipeWire 文档不构成系统音频可录的保证。官方 session 的 loopback 参数说明与新 macOS desktopCapturer 说明仍有范围差异，因此 Mac 也必须实测轨道、非静音样本与权限拒绝路径。[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[Electron session](https://www.electronjs.org/docs/latest/api/session)

Electron 打包也不免除签名、公证和升级维护。它适合交付时限优先的分支；在当前用户选择下，不应继续投资两套产品壳。可保留最小对照实验，后续在相同页面、采集负载与系统版本下比较启动、闲置、录制资源和功耗，再评价 Tauri 的收益。[Electron Forge 生命周期](https://www.electronforge.io/core-concepts/build-lifecycle)、[Electron 自动更新](https://www.electronjs.org/docs/latest/tutorial/updates)

## 长期优化补充

### 四种框架按目标权重决策

| 方案 | React 复用 | 原生采集控制 | 新增维护边界 | 本项目判断 |
| --- | --- | --- | --- | --- |
| Tauri 2 + Rust audio | 直接复用页面；增加 controller | Rust 持有 CPAL/平台 adapter | WebView 差异、Rust/系统 SDK、IPC | 当前权重下首选；先完成一条实机链路 |
| Electron + 原生 audio | 直接复用页面，Chromium 行为一致 | 可采用同一 Rust/C++ 音频核心 | Chromium/Node 升级、native addon ABI 或 sidecar、IPC | 最短交付优先时更强；系统采集可控仍需原生核心 |
| Flutter + 原生 audio | Record 协议可复用；React UI 通常重写为 Dart | 可通过平台插件/FFI 接 OS API | Dart UI、Flutter engine、平台插件与 native ABI | 原生 UI/移动端重构权重很高时再评估 |
| Wails + native audio | React 可复用，Go 与 JS 绑定 | Go/Cgo 或独立采集核心 | Go、Cgo/sidecar、WebView；Rust core 再增加一层边界 | Go 团队可作候选；当前没有明显胜过 Tauri 的复用优势 |

Flutter 官方支持平台通道与 `dart:ffi`，所以能接原生音频；它不会自动把现有 React 组件转换为 Flutter。官方 `webview_flutter` 当前列出 Android/iOS/macOS，不能凭这一插件承诺 Windows/Linux React 容器。Wails 是 Go 与系统 WebView 的绑定，也不会自带跨系统 loopback 引擎；其仓库说明 v2 为稳定线、v3 为 beta，应按固定版本核查能力。[Flutter native binding](https://docs.flutter.dev/platform-integration/bind-native-code)、[Flutter platform channels](https://docs.flutter.dev/platform-integration/platform-channels)、[官方 webview_flutter](https://pub.dev/packages/webview_flutter)、[Wails 工作方式](https://wails.io/docs/howdoesitwork/)、[Wails 版本分支](https://github.com/wailsapp/wails/blob/master/CONTRIBUTING.md)

这一比较不支持“某壳天然音质更好/更省电”的结论。音频格式转换、回调阻塞、双路混音、IPC 复制、上传批次和 ASR 工作量都可能比壳本身更影响功耗；这是需要测量的假设。先分离 capture core，可在未来更换 UI 框架时保留采集与协议测试。

### 后续优化顺序

先确保数据正确、有界缓冲与可观测错误，再测采集回调、重采样、IPC 和上传队列各段成本。仅当二进制拉取成为实测瓶颈时，再比较 Channel、批量拉取或 native 上传；仅当 WebView 生命周期成为可靠性瓶颈时，再引入 native 持久化 spool 与恢复上传。它们涉及 ACK 所有权、重复重传与退出排空，不能只加后台线程就宣称完成。

Mac 逐应用过滤可下沉直接 CoreAudio Tap/ScreenCaptureKit；Windows 逐进程 loopback、Linux 指定 graph node 同样作为独立 capability。平台策略须描述“捕获谁、排除谁、设备变化后怎样恢复”，不能只返回一个 `supported: true`。既有 CPAL 抽象不满足时再增加平台 adapter，避免提前分叉三套采集引擎。

### 许可与维护风险

框架的宽松许可证不代表整包所有依赖都具有相同许可证。Tauri 为 MIT/Apache-2.0 双许可，CPAL 为 Apache-2.0，Electron/Wails 为 MIT，Flutter 框架为 BSD-3-Clause；发行时仍应对锁定依赖和原生库生成许可清单、保留 notice，并单独核查可选 SDK。首轮使用系统 CoreAudio/WASAPI 与必要 Linux backend，不为普通录音默认引入 ASIO 等额外 SDK。[Tauri 许可](https://github.com/tauri-apps/tauri/blob/dev/LICENSE-MIT)、[CPAL 许可](https://github.com/RustAudio/cpal/blob/v0.18.2/LICENSE)、[Electron 许可](https://github.com/electron/electron/blob/main/LICENSE)、[Wails 许可](https://github.com/wailsapp/wails/blob/master/LICENSE)、[Flutter 许可](https://github.com/flutter/flutter/blob/master/LICENSE)

维护成本主要在系统版本与设备组合、权限/签名身份变化、原生依赖升级、音频回调和跨边界生命周期。固定版本、保留最小诊断程序与平台回归矩阵，比依赖社区“支持三系统”的标签更能降低风险。

## 结论与证据缺口

按已确认的长期目标，优先实现 **Tauri 2 + Rust/CPAL 原生采集 + React/Record 协议**。当前可执行切口是 bundled React、本地流式 API proxy 与 macOS 14.6+ 的麦克风/CoreAudio Tap，受限 IPC 接现有队列；Windows/Linux 作为后续有独立验收证据的适配阶段。Electron 是短交付备选，Flutter/Wails 不因新增壳而解决采集问题。

最弱证据是目标设备上的系统音频、权限和长时间生命周期：本报告核实了官方 API 与固定版本实现，没有把它们提升为本项目实测成功。最大的易漏边界是本地 proxy 的内存会话/CSRF/稳定 origin 与多上游隔离，以及停止时 native/JS/服务端三段排空。两者必须进入首轮场景测试；签名更新、跨平台实机与资源收益仍应单独报告。

## 本轮实现核实（2026-10-13）

用户确认首轮为三系统桌面、移动端继续 Web，并选择长期轻量、低功耗与采集可控优先。当前已接入 Tauri 2 / Rust / CPAL 0.18.2：macOS CoreAudio、Windows WASAPI 与 Linux PipeWire capture-sink 路径；Linux 系统播放采集要求 PipeWire 服务，不自动切到麦克风，普通输入可回到 ALSA。版本和能力依据仍以固定 CPAL 源码为准。[PipeWire capture-sink 实现](https://github.com/RustAudio/cpal/blob/v0.18.2/src/host/pipewire/device.rs)

本机合成场景经过实际 WKWebView、二进制 IPC、React 控件、IndexedDB 队列和隔离 Record API，覆盖断网上传、暂停尾包、重启重新登录、原队列补传和固定公开 Origin；不是物理声卡或真实 ASR/LLM 测试。macOS 应用包与 Node/Rust 回归的最终结果见[验证记录](../evidence/client-brain-research/native-client-validation-2026-10-13.md)。Windows/Linux 目标机器编译、实体采集、长会话和功耗仍待验证。
