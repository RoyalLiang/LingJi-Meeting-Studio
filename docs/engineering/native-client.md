# 原生桌面客户端

首轮实现采用 **Tauri 2 + Rust 原生音频 + 现有 React/Record 协议**。范围是 macOS、Windows、Linux 桌面，移动端继续使用 Web。技术依据见调研，架构取舍见 proposed ADR，验证层级见验收记录。

## 启动与构建

内置运行时固定为 **Node 26.12.1、SQLite 3.54.0、Record API 和 worker**。打开应用时由原生进程启动独立后台，退出时关闭其子进程；无需启动 Web 开发服务或在本机安装 Node。版本、官方 SHA-256 和依赖复制由 `scripts/prepare-client-backend.mjs` 管理，已配置 macOS arm64/x64、Linux x64、Windows x64 的运行时校验和。各发布平台的构建与验证状态以对应 Actions 为准。

在项目根目录安装依赖，再启动或构建客户端：

```sh
npm install
npm run dev:client
npm run build:client
npm run test:client
```

`dev:client` 先构建 Web、准备后台资源，再启动原生窗口；本阶段没有 Vite 热更新。修改 Web 后重新运行。首次准备资源会从 Node 官方站点下载固定版本，核对 SHA-256 后复用项目本地缓存。开发需要 Rust 1.90+ 和[各平台 Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。Linux 音频构建需要 ALSA 开发库 `libasound2-dev`；系统播放声音通过 PulseAudio 协议访问默认输出的真实 monitor source，运行时需要 PulseAudio 或 PipeWire Pulse 服务。

正式安装包始终使用内置后台。它不读取 Web 项目的 `.env`，不复用开发后台、数据库或供应商密钥，也不使用旧 `client.json` 中的 `apiUrl`。只有 debug 或显式 `smoke-test` 构建可以通过 `TTS_RECORD_API_URL` 连接外部开发/测试 API。该入口仍校验 HTTPS 根地址或本机 HTTP，并拒绝路径、账户、查询参数和片段。原生代理校验 WebView Origin 后转发 API；后台仅监听本机回环地址，由原生进程注入私有账户会话。

配置目录由 Tauri `app_config_dir` 确定，标识为 `com.tts.meeting`；macOS 通常为 `~/Library/Application Support/com.tts.meeting`。独立后台数据位于其 `backend/` 子目录，`TTS_CLIENT_DATA_DIR` 仅供隔离开发/测试。WebView 使用稳定的独立后台 profile，后台监听端口改变不会改变它；旧外部后台 profile 与未补传 IndexedDB 数据保留，不自动迁移到新账户或新后台。

## 保存会议与供应商配置

独立后台自动创建本机账户，无需用开发账户或密码登录。在客户端 **设置** 中单独填写 ASR、LLM 和翻译服务配置。首次安装没有可用的供应商密钥；本地保存与读取历史不依赖 Web 开发后台，云端转录和纪要仍需要网络及有效的供应商配置。该账户属于当前本机数据目录，不提供跨设备同步或团队账户管理。

SQLite 使用 WAL 与 FULL 同步，按独立集合和文档保存高频内容；音频确认仍在文件及数据库持久化之后。迁移备份、回退和完整记录操作的边界见[存储与性能](storage-and-performance.md)。

目录权限为 `0700`，后台配置与日志文件为 `0600`。供应商密钥保存在本机 `backend/providers.json` 的明文配置中；文件权限和压缩均不等于加密。本轮没有接入 Keychain、数据库加密或自动备份。保留 SQLite 的理由与替代方案边界见本地存储调研，结构与生命周期见 proposed ADR 0013。

## 音源与生命周期

**会议声音来源**可以明确选择系统所有应用，或 macOS／支持版本 Windows 上正在运行的应用。应用范围包含该应用的子进程；Windows 按应用录音需要 build 20348 或更高版本。Linux 继续使用 PulseAudio／PipeWire Pulse 系统音源，并明确报告按应用选择暂不可用。

应用选择绑定进程和启动身份。应用退出、重启或列表刷新后失效时，保留失效选择并要求重新选择，不改采系统全部声音。录制中不能更换范围，暂停后可以调整。麦克风可以独立关闭，关闭状态在本场会议恢复时保留；会议软件自身的静音开关不控制聆记麦克风。

本机麦克风在重采样和高通后使用 SpeexDSP 降噪及回声消除。回声参考只来自同场会议已选择的播放音源，自动增益关闭。处理器保留短尾并补偿自身缓冲延迟。合成回声、降噪和公开语音样例不能替代扬声器、USB 设备、不同采样时钟与真实会议的声学校准。

本机录音使用私有共享落盘通道直接交给 Node 后台，WebView 不承载 PCM 或待传队列。后台确认后才清理对应帧。停止冻结生产端并写入精确栅栏；尾包未排空或暂时写入失败时保留重试，不能用旧确认水位伪装停止成功。

关闭主窗口后，采集、落盘和后台确认继续运行；可由原生悬浮控件暂停或结束，重新打开时重建工作台。恢复新采集由用户动作触发，创建新 Source/epoch；后台重启只恢复已落盘帧和关闭状态，不自行重新打开设备。删除或过期会使音源失效并清理对应待处理数据。

OS 权限仍由系统管理。应用中的音源操作不代替录音告知、原音留存、云端识别或分享授权。设备错误、应用退出和队列溢出会明确停止受影响音源，不替换成模拟结果。

## 登录、离线与分发边界

Apple Silicon Alpha 5 可在 Web 开发后台没有运行时打开页面、使用本机账户并读取本地历史。客户端采集仍先落入最多 48 MiB 的 WebView IndexedDB 队列，收到本地后台持久 ACK 后删除；本机回环传输不依赖操作系统的联网标记。云端供应商不可用时，后台保留待处理音频和任务，恢复网络及有效配置后继续处理。队列上限、失败提示与停止排空行为继续生效。

后台重启会恢复中断的任务租约。不同后台或浏览器中的会议与待补传数据不会自动合并；升级前先结束旧会议并确认旧队列排空。旧数据保留在原服务或原 profile，可通过原环境访问。

当前 `.app` 属于本机 Alpha 验收包，采用 ad-hoc 签名，尚未完成 Developer ID 签名与公证。[安全更新](client-updates.md)与[GitHub 发版工作流](../releases/github-client.md)已实现本地版本；只有编入可信公钥与更新源的新安装包才启用更新。Windows/Linux 发行包、全新 Mac 首次安装和真实实体音频仍须各自验收。

## 重复验证

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features smoke-test
node scripts/test-native-client.mjs
node scripts/test-native-evolution.mjs
npm run build:client
node scripts/test-native-package.mjs
```

合成场景脚本只用于显式 `smoke-test` 构建，创建隔离数据目录和 API，不访问现有会议、不打开真实设备或供应商。正式构建不启用该 feature，也不提供测试 IPC；正式包验证须覆盖独立后台启动、隔离账户、持久化重启与内置 React 页面，测试证据以本次 Alpha 发版记录为准。平台包可通过 `NATIVE_CLIENT_EXECUTABLE` 指向相应可执行文件。正式 `.app` 单独构建可用 `npm exec --workspace apps/desktop -- tauri build --bundles app`。

当前，Linux DEB 候选采用 Ubuntu 22.04 基线（glibc ≤ 2.35），同时验证 Ubuntu 24.04 安装；结果以本版本发布回执为准。旧版本仍可能要求 Ubuntu 24.04，不能通过强制改包依赖降级运行。系统音频改用 PulseAudio 协议，不再要求 PipeWire 0.3.53 开发库。

## 音源权限（2026-10-13 修订）

客户端使用原生CPAL/CoreAudio接入麦克风与系统声音；点击录音或接入音源直接进入系统权限检查，移除每次采集前重复的自有确认框。没有把本地提示确认缓存冒充系统授权，也不绕过撤销；拒绝或撤销会返回真实错误，不静默切换浏览器或模拟来源。

新会议默认接入系统声音与麦克风，与浏览器入口一致。暂停继续仅恢复之前成功接入的音源，显式关闭的麦克风保持关闭；并发重复继续不会重新添加此前失败或关闭的音源，空音源集合不会回退为默认选择。

系统首次授权及撤销由macOS管理。当前本地Alpha为ad-hoc签名，跨构建身份变化可能导致系统再次询问；稳定正式签名与跨版本TCC复用尚未验收。既有固定WebView profile/origin继续保留，未重置系统权限或修改TCC数据库。
