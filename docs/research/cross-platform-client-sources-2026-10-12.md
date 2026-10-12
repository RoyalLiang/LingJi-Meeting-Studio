# 跨平台客户端与独立更新路线：一手资料核查

核查与访问日期：2026-10-12。状态：研究建议，未批准实施。本文核查官方文档、官方源码和官方变更记录；不包含跨设备实测、供应商模型质量或部署结论。

## 结论与项目前提

**建议保留浏览器为主入口，把“最强大脑”做成可独立演进的端云能力，再按录音和系统集成的实际缺口增加原生客户端。** 当前不宜先重写 Flutter/React Native，也不宜仅因安装包体积选择 Tauri 或仅因 Chromium 一致性选择 Electron。先用同一采集协议、模型任务和设备场景做验证，才有可比较的结论。

项目事实依据是 [当前状态](../engineering/current-state.md) 与 [文档入口](../README.md)：主入口为 React/TypeScript/Vite Web 与 Record API/worker；浏览器优先、尽量免安装；已经有 AudioWorklet、IndexedDB、音频身份及重传、SSE、转录修订和有引用的纪要。真实设备、长会话、手机后台、原生采集和跨平台验证仍有边界。本文没有逐文件审计实现，也不把历史 Tauri 迁移计划作为已经批准的当前方向。

建议把三个问题分开决策：

1. **采集与可靠性**：需要录哪个音源、锁屏多久、断网多久、能否接受安装、哪些系统必须支持。
2. **智能任务**：本地承担哪些轻任务，云端承担哪些复杂任务；任务质量、隐私、成本与时延如何验收。
3. **发布与更新**：程序、原生桥、协议、模型、提示词/规则和用户数据分别如何兼容、激活和回退。

## 一、跨平台候选路线

下表是能力和工程代价的比较，不是性能排名。待测项目不能用框架宣传资料替代。

| 路线 | 官方可确认能力 | 对本项目的判断与限制 | 进入条件 |
| --- | --- | --- | --- |
| Web / 可安装 PWA | 使用浏览器采集、存储和更新生命周期；安装仍使用 Web 能力 | 最大化现有前端复用和免安装入口；系统音频、后台和模型能力依赖浏览器及 OS，安装 PWA 不可作为原生录音能力的证据 | 默认主线；先补能力探测、长会话及更新保护 |
| Tauri 2 桌面增强 | Web UI + Rust Core，通过消息调用原生能力，使用系统 WebView | 可复用 React 阅读/设置界面，原生采集、磁盘队列、本地推理可放 Rust/平台插件；不同 WebView 的录音、CSS、GPU 能力须分别验证 | 浏览器系统采集/后台缺口有数据，且团队能够维护 Rust 与平台插件 |
| Electron 桌面增强 | 桌面 Chromium/Node 环境，提供 `desktopCapturer` 与平台更新 API | 可减少浏览器引擎差异，桌面采集 API 文档较具体；打包运行时、进程隔离与安全升级是持续成本，OS 音频权限仍会变 | 固定 Chromium 行为、现有 Node 模块或桌面采集能力带来的收益大于实测资源成本 |
| Capacitor 手机增强 | 将现有 Web 项目放入原生运行时，以 Swift/Java 等插件访问平台 API | 适合复用现有 UI，原生麦克风/后台服务须独立实现；Background Runner 不是连续录音进程 | 手机锁屏录麦克风、系统分享入口或原生存储成为明确需求 |
| Flutter / React Native 对照 | Flutter 有平台通道；React Native 有 Native Modules/Components | UI 框架变化不消除音频权限与后台限制；对现有 React DOM UI 的重用更少，需另付迁移成本 | 移动原生交互成为产品中心，且重写收益经原型验证 |

官方结构依据：[Tauri architecture](https://v2.tauri.app/concept/architecture/)、[Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/)、[Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Capacitor](https://capacitorjs.com/docs)、[Flutter architecture](https://docs.flutter.dev/resources/architectural-overview)、[React Native native platform](https://reactnative.dev/docs/native-platform)。以上只说明运行与扩展机制，不证明本项目在任一框架上的 RSS、能耗或时延更优。

### 系统音频与后台录制的真实边界

**Web 事实。** `getDisplayMedia()` 需要用户选择与授权；屏幕捕获授权不能永久复用，音频选项是提示，返回的流仍可能没有音频轨。`systemAudio: "include"` 不代表整机音频必然可用。应检查实际轨道、电平和停止事件，而非只判断 Promise 成功。[MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

**重要时效修正。** 不能继续笼统写“macOS 浏览器不支持系统音频”。Google Meet 的官方支持已覆盖 macOS 14.2+/Windows 11+ 与 Chrome 142+ 的窗口/桌面音频分享。该结论属于 Meet 的支持范围，并不自动证明 TTS 或全部 Chromium、Safari、WebView 的支持情况。[Google Workspace 官方更新](https://workspaceupdates.googleblog.com/2025/12/share-devices-audio-when-presenting.html)、[Meet 系统要求与排障](https://support.google.com/meet/answer/16581830?hl=en)

**桌面 Electron 事实。** 官方 `desktopCapturer` 文档描述 loopback 采集及 OS 限制；macOS 12.7.6 及以前没有其需要的免内核扩展音频能力，Linux PipeWire 来源枚举也有差异。[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/)

**版本核查提醒。** 访问时 `desktopCapturer` 页面仍保留旧 feature flag 的说明，但官方 2026-09 已合并 PR：Electron 45/Chromium M155 起移除 `MacCatapLoopbackAudioForScreenShare`，旧 flag 不再绕过 CoreAudio Tap 路径，拒绝/缺失权限可能表现为已结束音轨而无错误。选型验证必须记录实际 Electron/Chromium、macOS 版本和权限状态，不能照抄旧 workaround。[Electron 官方变更 #53646](https://releases.electronjs.org/pr/53646)

**iOS 原生事实。** `AVAudioSession` 的录音 category 可以配合 `UIBackgroundModes=audio` 在进入后台/锁屏后继续录制，但用户必须授予录音权限，电话、闹钟等仍可中断会话。ReplayKit 官方描述的是屏幕、App 音频与麦克风；不能据此承诺任意其他会议 App 的所有声音均可捕获。[Apple record category](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record)、[ReplayKit](https://developer.apple.com/documentation/replaykit)

**Android 原生事实。** AudioPlaybackCapture 受源应用授权策略与 usage 限制：可捕获 usage 为 MEDIA/GAME/UNKNOWN，且源播放器必须允许捕获。VOICE_COMMUNICATION 不在该列表，所以“手机端录任何在线会议的双向音频”不能作为框架能力承诺。麦克风持续后台录制另需对应 foreground service 类型和运行时权限，且受启动规则限制。[Android 播放音频捕获](https://developer.android.com/media/platform/av-capture)、[foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)

**Web/混合后台事实。** 浏览器可能冻结或丢弃页面，移动端终止不一定触发卸载事件；Chrome 的音频/WebRTC 保护是启发式而非绝对保证。Capacitor Background Runner 是独立、受 OS 调度的短任务环境，官方 iOS 说明约 30 秒的任务时间，不能承担持续麦克风采集。[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)、[Capacitor Background Runner](https://capacitorjs.com/docs/apis/background-runner)

**建议。** 手机第一阶段定位为随身麦克风记录、文件/系统分享导入与会议复盘；在线会议双向音频按具体 App、系统与耳机组合验收。桌面在线会议先测浏览器 tab/window/screen 各来源，再决定是否上原生采集。产品应明确展示“麦克风有声 / 共享音频有声 / 来源已结束”，避免将授权成功误报为采集成功。

### 最小设备验收矩阵（建议）

至少覆盖 Windows 11 当前 Chrome/Edge、macOS 最低支持版与当前版的 Chrome/Safari、Linux 目标发行版的 X11/Wayland、Android 当前和最低支持版、iPhone/iPad 当前和最低支持版。框架原型另加 WebView2、WKWebView、WebKitGTK 或指定 Electron 版本。

每组记录：真实轨道与电平、麦克风+远端是否同时有声、蓝牙切换/拔插、授予后撤销权限、切后台/锁屏、电话中断、30/60/120 分钟、断网补传、低磁盘、休眠唤醒、停止排空与更新触发。退出条件是未解释的音频缺口为零、可恢复数据与丢失区间可定位；时延、丢包及能耗阈值应先由产品场景定标。

## 二、“最强大脑”的端云分工

### 官方可用技术与尚不能推出的结论

| 技术 | 一手资料确认 | 不能直接推出的结论 |
| --- | --- | --- |
| ONNX Runtime Web | 有 WASM 和 WebGPU 等执行路径，可选择部署产物 | 不代表全部 ONNX 算子、模型和浏览器组合均支持或更快 |
| Transformers.js | 可运行浏览器模型，支持 `device`/量化 dtype；编码器模型对量化策略可能敏感 | 不能用“4 bit 更小”推出中文 ASR、实体或纪要质量合格 |
| WebLLM | 浏览器 WebGPU 推理、Worker 与模型缓存；需 WebGPU 可用浏览器 | 缓存不等于持久保存；Worker 不等于手机后台永生 |
| 原生 llama.cpp / ONNX Runtime | 有 Metal/CUDA/Vulkan 等原生执行路径或跨硬件 EP | 不代表某台设备能装下给定上下文、满足耗电/温度与实时性 |

来源：[ORT Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)、[ORT Web 部署](https://onnxruntime.ai/docs/tutorials/web/deploy.html)、[Transformers.js WebGPU](https://huggingface.co/docs/transformers.js/guides/webgpu)、[dtype 与量化](https://huggingface.co/docs/transformers.js/guides/dtypes)、[WebLLM 入门](https://webllm.mlc.ai/docs/user/get_started.html)、[WebLLM Worker/缓存](https://webllm.mlc.ai/docs/user/advanced_usage.html)、[llama.cpp 官方仓库](https://github.com/ggml-org/llama.cpp)、[ORT 原生 WebGPU EP](https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html)。

**支持矩阵必须分两层。** WebKit 官方确认 Safari 26 发布 WebGPU；访问时一些推理库文档仍保留较早的 Safari 支持表。因此应分别探测浏览器 API、adapter/features/limits，再执行目标 runtime + 模型的加载和数值校验；不能把“Safari 有 WebGPU”和“本项目目标模型在 Safari 合格”混为一谈。[Safari 26 官方发布](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)

### 建议的能力演进

**近端轻任务先落地。** 优先评估 VAD/音量与音源异常检测、端侧词表/术语、轻量意图候选、嵌入与本地检索。复杂纪要、跨会议综合推理、复杂工具规划保留云端强模型路径；离线/隐私模式单独显式开启。已有音源检测不能仅为“AI 化”无证据重写。

**统一任务边界。** 建议把智能任务定义为带输入转录修订、引用范围、输出 schema、超时/取消预算和执行环境的 job。路由依据能力、隐私选择、任务复杂度、网络与预算；任何本地失败转云端都必须遵循既有数据外发选择。UI 展示执行位置和失败状态，避免悄悄用 mock 或较弱模型假装成功。

**减少大模型上下文重复。** 长会话先做可重建的分层摘要/主题索引与检索，再按来源片段取证；保留原始转录修订，摘要不能成为不可追溯的唯一事实。纪要重新生成必须继续保护人工编辑；行动候选需要独立确认与外发授权，升级模型不得改变这个边界。

**统一评测而非按参数量排名。** 选定经授权、分会话隔离的中文会议集与合成故障集；对比意图 precision/recall、引用正确率、决策/负责人/时间遗漏、幻觉与错误行动率，以及冷启动、首结果/P95、吞吐、峰值内存、GPU 内存、60 分钟能耗/温升。在线任务与离线批处理各有预算，不以单次 tokens/s 代替整体体验。

模型大小应含权重、tokenizer、runtime、KV cache、中间张量和新旧双版本临时空间；浏览器模型缓存还会与音频 outbox 争抢配额。Storage API 可以估算与申请持久性，但配额不是必然可用空间，仍须处理 `QuotaExceededError`。[Web 离线数据](https://web.dev/learn/pwa/offline-data)、[WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

## 三、客户端更新与模型更新的独立路线

### 官方更新能力与限制

**PWA。** 新 Service Worker 通常等待旧客户端离开后激活；立即 `skipWaiting()` 可能让旧页面由新 worker 接管，形成版本混用。录制应用不能在收到新版本时直接自动刷新。[PWA update](https://web.dev/learn/pwa/update)、[Service Worker lifecycle](https://web.dev/articles/service-worker-lifecycle)

**Tauri 2。** 桌面 updater 要求签名校验，不能关闭；其更新签名与 OS 代码签名是不同机制。可分开下载和安装；Windows 执行安装时会退出应用，因此停止/排空守卫须放在 install 之前。v1 迁移兼容制品与 v2 制品格式不同，不能直接撤下旧客户端仍需要的制品。[Tauri updater](https://v2.tauri.app/plugin/updater/)、[updater 官方文档源码（桌面 cfg）](https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx)

**Tauri 签名与格式。** macOS 分发通常还涉及代码签名/公证；Windows 代码签名与 SmartScreen 信任是另一条链。访问时 updater changelog 已列出 Linux Deb/Rpm/AppImage 等新支持，普通插件页示例却仍集中在 AppImage；实际实现应固定插件版本与安装格式验证，不把网页示例当完整支持列表。[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Windows 签名](https://v2.tauri.app/distribute/sign/windows/)、[updater changelog](https://tauri.app/release/updater/all-versions/)

**Electron。** 内建 autoUpdater 支持 macOS/Windows，Linux 推荐使用发行版包管理器；macOS 自动更新要求签名，Windows 取决于 MSIX/Squirrel 安装路径。下载完成不代表可以立即调用 `quitAndInstall()`；调用方须先完成录制退出条件。[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater/)

**移动商店。** Capacitor 可分开发布 Web 层和原生二进制，但不意味着任何功能都能 OTA。Apple 2.5.2 限制下载会改变功能的可执行代码，Mac App Store 更新有自身要求；Google Play 不允许自行更新应用及从外部下载 dex/JAR/.so 等可执行代码，解释型代码例外也受其政策约束。模型权重、编译模型库、插件和任意脚本必须分别判断，不能统一标为“资源”规避二进制发布。[Capacitor 部署更新](https://capacitorjs.com/docs/guides/deploying-updates)、[Apple guidelines 2.4.5/2.5.2](https://developer.apple.com/app-store/review/guidelines/)、[Google Play Device and Network Abuse](https://support.google.com/googleplay/android-developer/answer/16559646?hl=en)

### 建议的四条发布通道

| 通道 | 内容 | 激活时机与回退边界 |
| --- | --- | --- |
| 客户端程序 | Web bundle、Service Worker、桌面/手机二进制与原生桥 | 录制结束且音频排空/持久确认后激活；数据迁移须兼容上一版本才能回退程序 |
| 服务与协议 | Record API/worker、协议和 SSE schema | 支持升级窗口内的旧客户端；协议不兼容通过能力协商显式拒绝，不能中途丢弃录音 |
| AI 策略 | 任务路由、规则、提示词、工具允许列表、输出 schema | 新任务绑定新版本；在跑任务锁定版本；能力开关不能扩大用户外发授权 |
| 模型制品 | 权重、tokenizer、量化参数、runtime/编译库兼容信息 | 下载/校验/试加载通过后，于安全边界切换；保留已验证版本，禁止仅覆盖同名文件 |

以上是建议架构，不是当前实现。策略和模型版本须写入每次 AI 结果与审计信息，并关联 `transcriptRevision`/片段引用；客户端版本与协议/存储 schema 单独记录。这样才能把“模型质量回退”“接口兼容失败”和“客户端录音失败”定位到不同发布。

### 录制保护与激活状态机（建议）

`发现 → 低优先级下载 → 校验 → 待激活 → 停止采集 → 排空并取得持久化确认 → 保存恢复点 → 激活/重启 → 健康检查`

- 录制、暂停待继续、停止排空或尚有未确认音频时，禁止强制刷新/安装；下载影响采集时降低优先级或暂停。暂停不等于会话结束。
- 多标签页协调同源录制租约；只有全部活跃采集者到达安全状态才激活 SW。旧页面仍活跃时保留对应版本静态资源，不能在 activate 中清掉仍需的缓存。
- 恢复点至少包括 record/session/source/epoch、已确认 sequence/sampleOffset、未确认 outbox、SSE cursor、转录修订与人工编辑状态；更新不得用新 epoch 重传旧音频造成重复。
- seal/停止失败或持久化确认超时则继续停留旧版本并报告具体状态；不能以“更新必须立即安装”为由标记音频已保存。后台纪要结果可在重启后通过历史游标恢复。
- 新版本启动检测录音权限、磁盘/配额、数据库、协议与模型加载；健康失败只在数据兼容前提下退回。结构性数据迁移采用扩展后收敛方式，避免一键回退承诺超过实际能力。

### 独立制品清单与供应链（建议）

模型/策略清单至少包含不可变版本、制品 hash/字节数、签名与 key id、最低客户端/runtime、模型/tokenizer/config hash、输入输出 schema、量化信息、来源与许可证、评测报告、失效/撤回状态。下载到临时位置、验签与 hash、加载自测后再原子切换指针；只删除无引用的旧版本，音频队列空间优先。

灰度按内部/试点/稳定通道进行，每次只变一条影响质量的轴。观察崩溃/录音缺口、协议失败、更新失败和模型质量回归后再扩展；紧急停止分发与已安装回滚是两项不同能力。对更高保障的制品分发，可评估 TUF 的角色、版本与元数据过期检查，覆盖仅签名无法独自处理的冻结/回滚风险；是否引入应与分发规模和威胁模型相称。[TUF 官方规范](https://theupdateframework.github.io/specification/v1.0.33/)

## 四、按退出条件推进的建议路线

| 阶段 | 研究/实现范围建议 | 退出条件 | 暂不扩展的范围 |
| --- | --- | --- | --- |
| A：Web 事实基线 | 记录设备能力、音源与权限状态；采集/上传/ASR/纪要分段延迟，长会话内存和配额；验证更新中断保护 | 支持矩阵、真实采集缺口与性能分位数可复现；损坏/重复音频为零且失败可定位 | 不因猜测重写框架或添加大型本地模型 |
| B：可恢复 Web/PWA | 复核已有 outbox 恢复，补齐能力提示、版本协商与安全激活；轻任务 Worker 原型 | 录制期间发版、旧资源缓存、多标签、断网/重启、配额不足均有明确结果 | 不承诺手机锁屏持续采集 |
| C：桌面增强决策 | 同一任务包各做 Tauri/Electron 最小原型：系统采集、后台、磁盘队列、推理、安装更新 | 真实 OS/硬件下有质量相同的 RSS/CPU/功耗/P95/包体/维护代价对照，选择满足场景者 | 不把 mock 或单机 benchmark 当全平台结论 |
| D：手机增强决策 | 优先验证原生麦克风锁屏与恢复、系统分享导入；按需比较 Capacitor 与 Tauri mobile | 电话/蓝牙/锁屏/杀进程/系统升级场景通过；商店渠道更新路径具体可行 | 不承诺任意第三方会议 App 双向音频 |
| E：智能独立演进 | 模型/策略 registry、任务版本锁定、离线评测、灰度与回退；经授权的端云路由 | 新版本在中文任务质量、引用/行动边界和资源预算上均达标，可重现回退 | 不以参数量或“支持 WebGPU”直接宣布最强 |

这些阶段可以交错，但每项交付仍须分别报告：官方能力、当前代码、浏览器/设备实验、真实模型质量、部署/商店结果。本文完成的是一手资料研究；没有新增客户端、升级依赖、运行实际模型或访问真实会议。

## 五、当前最大的待测项

1. **跨平台录音优先级尚未定标**：在线桌面会议、手机随身记录、移动会议 App 双向音频与纯阅读客户端是不同产品，不应给出一个无条件框架冠军。
2. **本机性能尚不等于端侧瓶颈**：应先拆分采集、上传、worker 排队、ASR、LLM、SSE 与 UI，才知道是否值得增加原生进程或本地模型。
3. **AI 版本与数据迁移回退缺口**：签名更新插件不能自动提供旧协议、旧数据库或旧模型格式兼容，需项目明确设计。
4. **官方资料也存在版本错位**：上述 Electron 音频 flag、Tauri Linux updater 格式和 Safari WebGPU 支持均出现不同页面代际差异。实施时须固定具体版本、核查变更记录并完成设备验收。
