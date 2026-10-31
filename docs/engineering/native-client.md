# 原生桌面客户端

首轮实现采用 **Tauri 2 + Rust 原生音频 + 现有 React/Record 协议**。范围是 macOS、Windows、Linux 桌面，移动端继续使用 Web。技术依据见[调研](../research/cross-platform-client-implementation-2026-10-13.md)，架构取舍见 [proposed ADR](../adr/0011-native-desktop-client.md)，验证层级见[验收记录](../evidence/client-brain-research/native-client-validation-2026-10-13.md)。

## 启动与构建

本轮源码将内置运行时固定为 **Node 26.12.1、SQLite 3.54.0、Record API 和 worker**，仅本地升级，尚未发布或替换已安装客户端。打开应用时由原生进程启动独立后台，退出时关闭其子进程；无需启动 Web 开发服务或在本机安装 Node。版本、官方 SHA-256 和依赖复制由 `scripts/prepare-client-backend.mjs` 管理，已配置 macOS arm64/x64、Linux x64、Windows x64 的运行时校验和；本轮本机只验证 macOS arm64，其他平台仍待各自环境验证。

在项目根目录安装依赖，再启动或构建客户端：

```sh
npm install
npm run dev:client
npm run build:client
npm run test:client
```

`dev:client` 先构建 Web、准备后台资源，再启动原生窗口；本阶段没有 Vite 热更新。修改 Web 后重新运行。首次准备资源会从 Node 官方站点下载固定版本，核对 SHA-256 后复用项目本地缓存。开发需要 Rust 1.90+ 和[各平台 Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。Linux 音频构建另外需要 ALSA/PipeWire 开发库，例如 `libasound2-dev libpipewire-0.3-dev libclang-dev`；运行时需要 PipeWire 服务才能采集系统播放声音。

正式安装包始终使用内置后台。它不读取 Web 项目的 `.env`，不复用开发后台、数据库或供应商密钥，也不使用旧 `client.json` 中的 `apiUrl`。只有 debug 或显式 `smoke-test` 构建可以通过 `TTS_RECORD_API_URL` 连接外部开发/测试 API。该入口仍校验 HTTPS 根地址或本机 HTTP，并拒绝路径、账户、查询参数和片段。原生代理校验 WebView Origin 后转发 API；后台仅监听本机回环地址，由原生进程注入私有账户会话。

配置目录由 Tauri `app_config_dir` 确定，标识为 `com.tts.meeting`；macOS 通常为 `~/Library/Application Support/com.tts.meeting`。独立后台数据位于其 `backend/` 子目录，`TTS_CLIENT_DATA_DIR` 仅供隔离开发/测试。WebView 使用稳定的独立后台 profile，后台监听端口改变不会改变它；旧外部后台 profile 与未补传 IndexedDB 数据保留，不自动迁移到新账户或新后台。

## 保存会议与供应商配置

独立后台自动创建本机账户，无需用开发账户或密码登录。在客户端 **设置** 中单独填写 ASR、LLM 和翻译服务配置。首次安装没有可用的供应商密钥；本地保存与读取历史不依赖 Web 开发后台，云端转录和纪要仍需要网络及有效的供应商配置。该账户属于当前本机数据目录，不提供跨设备同步或团队账户管理。

SQLite 使用 WAL、FULL 同步和同一后台连接保存 Record、会话、转录、纪要与任务状态。较大的 Record JSON 以无损 deflate 压缩保存，调度与列表所需字段保留为可查询元数据；聚合负载与投影在同一事务提交。没有变化的聚合跳过重写。音频仍按原始 PCM 的 SHA-256 存为不可变文件，压缩有收益时使用带长度与哈希校验的无损格式，没有收益时保留原始字节；读取兼容旧原始对象。音频文件先持久化，再提交领域状态与 ACK。压缩没有改变音频标识、重传幂等或停止排空协议。

目录权限为 `0700`，后台配置与日志文件为 `0600`。供应商密钥保存在本机 `backend/providers.json` 的明文配置中；文件权限和压缩均不等于加密。本轮没有接入 Keychain、数据库加密或自动备份。保留 SQLite 的理由与替代方案边界见[本地存储调研](../research/client-local-storage-2026-10-13.md)，结构与生命周期见 [proposed ADR 0013](../adr/0013-standalone-client-storage.md)。

## 音源与生命周期

默认仅接入系统播放音频，麦克风显式开启并可独立关闭。每次原生开始有本机确认；拒绝或设备不可用时直接报错，不切换音源或模拟结果。默认输入被识别为虚拟设备时优先选择已识别实体麦克风，否则要求显式选择。此判断依赖设备名称；未知设备应手动指定。

| 平台 | 系统音频实现 | 麦克风实现 | 当前运行证据 |
| --- | --- | --- | --- |
| macOS 14.6+ | CPAL CoreAudio Tap | CoreAudio 输入 | 本机应用、合成 IPC 与 API 场景；实体音频待验 |
| Windows | CPAL WASAPI output loopback | WASAPI 输入 | 源码接入；目标机器编译与实录待验 |
| Linux | CPAL PipeWire capture-sink；服务不可用时报错 | 优先 PipeWire，无服务时 ALSA | 源码接入；目标机器编译与实录待验 |

系统音频包含整台电脑的播放声音，尚无按会议应用过滤。原生麦克风当前是原始 PCM，没有实现浏览器同等的回声消除、降噪和自动增益；双路录音建议使用耳机，外放回声与重复转录须单独验收。会议软件的静音开关不控制聆记麦克风。暂停停止原生采集并排空尾包；恢复创建新的 Source/epoch，按用户此前开启的音源重新授权。独立关闭麦克风不停止系统音频。设备错误和有界队列溢出会显式停止，已持久化片段仍可补传。空闲输出暂时不产生数据时保持等待，不把它当设备故障。

原生回调、转换线程各有 8 项缓冲；原生输入回调最多 65,536 个样本，超限失败。Rubato 将输入转为 16 kHz 单声道 PCM16，首包约 0.4 秒，随后每秒一包。JS 逐包持久化后才读取下一包，沿用现有 IndexedDB 容量限制与 ACK 重传。窗口关闭时遇录音或未完成补传会确认；强制关闭可能丢失尚未保存尾部，已保存块保留。没有后台录制能力。

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
npm run build:client
node scripts/test-native-package.mjs
```

合成场景脚本只用于显式 `smoke-test` 构建，创建隔离数据目录和 API，不访问现有会议、不打开真实设备或供应商。正式构建不启用该 feature，也不提供测试 IPC；正式包验证须覆盖独立后台启动、隔离账户、持久化重启与内置 React 页面，测试证据以本次 Alpha 发版记录为准。平台包可通过 `NATIVE_CLIENT_EXECUTABLE` 指向相应可执行文件。正式 `.app` 单独构建可用 `npm exec --workspace apps/desktop -- tauri build --bundles app`。

Linux 发行构建采用 Ubuntu 24.04 基线，CPAL PipeWire 接口要求 0.3.53+；不保证旧 glibc 或 Ubuntu 22.04 可直接运行发行 AppImage。

## 音源权限（2026-10-13 修订）

客户端使用原生CPAL/CoreAudio接入麦克风与系统声音；点击录音或接入音源直接进入系统权限检查，移除每次采集前重复的自有确认框。没有把本地提示确认缓存冒充系统授权，也不绕过撤销；拒绝或撤销会返回真实错误，不静默切换浏览器或模拟来源。

新会议默认接入系统声音与麦克风，与浏览器入口一致。暂停继续仅恢复之前成功接入的音源，显式关闭的麦克风保持关闭；并发重复继续不会重新添加此前失败或关闭的音源，空音源集合不会回退为默认选择。

系统首次授权及撤销由macOS管理。当前本地Alpha为ad-hoc签名，跨构建身份变化可能导致系统再次询问；稳定正式签名与跨版本TCC复用尚未验收。既有固定WebView profile/origin继续保留，未重置系统权限或修改TCC数据库。
