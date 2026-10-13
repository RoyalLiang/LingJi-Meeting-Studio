# 原生桌面客户端

首轮实现采用 **Tauri 2 + Rust 原生音频 + 现有 React/Record 协议**。范围是 macOS、Windows、Linux 桌面，移动端继续使用 Web。技术依据见[调研](../research/cross-platform-client-implementation-2026-10-13.md)，架构取舍见 [proposed ADR](../adr/0011-native-desktop-client.md)，验证层级见[验收记录](../evidence/client-brain-research/native-client-validation-2026-10-13.md)。

## 启动与构建

先按[运行手册](runbook.md)安装依赖并启动 Record API 与 worker。默认 API 为 `http://127.0.0.1:3030`；模型配置仍只在服务端。原生客户端不启动或重启已有服务。

```sh
npm install
npm run dev:client
npm run build:client
npm run test:client
```

`dev:client` 先构建 Web，再启动原生窗口；本阶段没有 Vite 热更新。修改 Web 后重新运行。开发需要 Rust 1.90+ 和[各平台 Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。Linux 另外需要 ALSA/PipeWire 开发库，例如 `libasound2-dev libpipewire-0.3-dev libclang-dev`；运行时需要 PipeWire 服务才能采集系统播放声音。

开发可用 `TTS_RECORD_API_URL` 指定服务根地址。安装包在应用配置目录读取 `client.json`：

```json
{"apiUrl":"https://records.example.com"}
```

默认目录由 Tauri `app_config_dir` 确定，标识为 `com.tts.meeting`（macOS 通常为 `~/Library/Application Support/com.tts.meeting`，Windows 为 `%APPDATA%\com.tts.meeting`，Linux 为 `$XDG_CONFIG_HOME/com.tts.meeting`）。`TTS_CLIENT_DATA_DIR` 仅供隔离开发/测试。允许远程 HTTPS 根地址与本机 HTTP；拒绝路径、账户、查询参数、片段及非本机明文 HTTP。本地代理先校验 WebView 的 Origin，再使用已配置上游的 Host/Origin 和原 CSRF token 转发；服务端固定公开 Origin 应等于 `apiUrl`。真实远程 HTTPS 部署仍需单独集成验证。

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

上游登录 cookie 仅在 Rust 内存中，重启须重新登录；本机连接 cookie 与上游认证分开。每个服务使用稳定本地来源与隔离 WebView 存储；同服务重启保留 IndexedDB，不自动搬迁浏览器中的旧队列。端口被占用时启动失败，释放后重试。离线可以打开内置页面，登录和服务端历史仍需 API；已登录后产生的离线录音按既有队列策略补传。

本机 `.app` 属于开发验收包。[安全更新](client-updates.md)与[GitHub 发版工作流](../releases/github-client.md)已实现本地版本；只有编入可信公钥与更新源的新安装包才启用更新。对外发行的 Developer ID/公证、Windows 签名、Linux 安装依赖与真实应用升级尚未验收；自动回滚未实现。不要把源码支持、单元测试或 macOS 包启动描述为三系统实机交付或省电证明。

## 重复验证

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features smoke-test
node scripts/test-native-client.mjs
npm run build:client
node scripts/test-native-package.mjs
```

合成场景脚本只用于显式 `smoke-test` 构建，创建隔离数据目录和 API，不访问现有会议、不打开真实设备或供应商。正式构建不启用该 feature，也不提供测试 IPC；`test-native-package.mjs` 验证正式包忽略模拟环境变量并运行内置 React。平台包可通过 `NATIVE_CLIENT_EXECUTABLE` 指向相应可执行文件。正式 `.app` 单独构建可用 `npm exec --workspace apps/desktop -- tauri build --bundles app`。

Linux 发行构建采用 Ubuntu 24.04 基线，CPAL PipeWire 接口要求 0.3.53+；不保证旧 glibc 或 Ubuntu 22.04 可直接运行发行 AppImage。
