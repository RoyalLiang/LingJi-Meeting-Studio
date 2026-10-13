# 原生客户端首轮验证

日期：2026-10-13。范围：Tauri/Rust 桌面基础、现有 React 接入与音频协议场景。本报告区分源码、隔离场景、正式包启动和实体环境。

## 已实现

内置 React 页面、稳定且隔离的本地来源、独立内存认证 jar、精确 Origin/Host 与连接 cookie 校验、固定上游代理、流式 SSE；CPAL 三平台采集路径、带限重采样到 16 kHz 单声道 PCM、有界缓冲、二进制拉取 IPC；共享 Record 队列、默认系统音频、独立麦克风、暂停尾包排空、恢复新音源及关闭保护。

本轮无 updater 插件、检查更新定时器、自动安装或发布流水线。用户已选 GitHub Releases，更新能力仍处于[调研](../../research/git-release-and-client-updates-2026-10-13.md)阶段。

## 本地结果

| 验证 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm test` | 158/158 | 当次工作区标准 Node 回归，包含其他并行未提交的浏览器改造 |
| native JS 测试 | 8/8，包含于标准回归 | 二进制序号/偏移/长度，持久化背压，停止尾包、重复 stop、失败无模拟回退、双路独立关闭与暂停恢复 |
| `cargo test` | 7/7 | 多采样率 DSP、最终样本数、缓冲溢出、默认虚拟输入、URL/来源稳定性、实际本地 HTTP 登录/隔离/上传/SSE/公开 Origin |
| `cargo clippy -- -D warnings`、`cargo fmt --check` | 通过 | 本机 Rust 静态检查 |
| ESLint、Web typecheck、build:web | 通过 | 当前 Web 与服务/脚本静态检查及构建 |
| macOS WKWebView 合成场景 | 通过 | 二进制 IPC 到 SQLite ACK；React 控件到实际 IndexedDB；断网上传、暂停尾包、重启重新登录、原队列补传；CSP 阻止 iframe |
| 正式 `.app` 构建和启动 | 通过 | arm64 包启动，内置 React 实际请求 bootstrap；测试 feature/模拟环境变量不生效 |

合成场景使用显式 `smoke-test` Rust feature，48 kHz 双声道正弦经同一原生转换流程进入 IPC。实际 React 控件开启默认系统音源，临时阻断音频上传，暂停保存 **3 个片段**；客户端进程重启后重新登录，全部 3 个原队列片段获得实际隔离 Record API 的持久化确认。另直接 IPC/协议路径确认 3 个片段及最终 manifest。证据：[合成场景 JSON](native-client-smoke-2026-10-13.json)、[正式包 JSON](native-client-package-2026-10-13.json)。

SSE 的 HTTP 单测检查首事件在后续事件产生前到达，WebView 场景确认实际 EventSource 建连；本轮未跑供应商转录增量到 native UI 的全链路。IndexedDB 补传验证的是同一服务、同一用户与稳定来源，不证明跨设备迁移。

## 产物与复现

本机产物：`apps/desktop/src-tauri/target/release/bundle/macos/聆记.app`。可执行文件约 11.20 MiB，构建器报告包约 11.49 MiB；`LSMinimumSystemVersion=14.6`，Mach-O arm64。`codesign` 显示 linker ad-hoc，无 TeamIdentifier、无 Developer ID/公证，不作为对外发行包。

```sh
npm run test:client
npm test
npm run lint
npm run typecheck
npm run build:web
npm run check:docs
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features smoke-test
node scripts/test-native-client.mjs
npm exec --workspace apps/desktop -- tauri build --bundles app
node scripts/test-native-package.mjs
```

测试脚本创建并清除自己的临时 API、账户、音频与 WebView 目录；不访问原会议、`.env` 配置的真实服务或录音设备。现有服务不重启。本轮源文件仅提交明确列出的客户端文件；IDE 和并行浏览器/纪要改造不纳入。

## 未验证与下一退出门

1. **实体音频与系统授权**：原生麦克风尚无 AEC/降噪/自动增益，系统+麦克风外放回声与重复转录尚未测试。CoreAudio Tap/WASAPI/PipeWire、系统权限拒绝、已连接但静音、设备拔插和路由切换，不能由合成音源替代。
2. **Windows/Linux 构建和运行**：已加入平台源码与 Linux PipeWire 依赖，尚无目标系统工具链/安装包/实录证据。macOS x86_64 也未构建。
3. **长会话与资源**：两小时双来源、休眠恢复、无输出期间的时间轴、实际 CPU/RSS/功耗与音质未测。包体积不证明这些指标。
4. **正式分发与升级**：OS 签名、公证、安装目录权限、更新签名、升级中断、旧队列迁移与版本兼容未验收。客户端自动更新尚未实现。
5. **真实集成**：远程 HTTPS/反向代理、真实 ASR/LLM、PG/S3 与生产发布未运行；本地 SQLite ACK 不代表线上质量或容量。

以上是首轮原生基础的证据，不能标为三系统生产交付或整个 P4/P5 完成。
