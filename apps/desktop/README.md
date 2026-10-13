# Desktop App

桌面端负责实时采集、会话控制、悬浮字幕预演和未来的桌面壳演进。

## 当前入口

- `npm run dev`
  - 启动 desktop shell preview，本地默认地址是 `http://127.0.0.1:3040`
- `npm run dev:preview`
  - 与 `npm run dev` 相同，显式强调这是 preview 入口
- `npm run dev:mock`
  - 启动 CLI mock client，继续支持文本模式和文件 chunk 上传

## 当前预演能力

- 主 shell 页面支持 `en` / `zh-CN` 页面语言切换
- 主 shell 页面可打开独立的 overlay 悬浮字幕窗口
- overlay 和主 shell 共用同一套 session 数据模型
- source transcript、translation transcript、summary 和 audio clip 状态会同步到 overlay
- 主 shell 和 overlay 之间通过 `BroadcastChannel` 同步实时状态和页面语言

## Preview 说明

当前 desktop shell preview 不是 Electron，也不是最终桌面应用。

它主要用于预演：

- 服务地址配置
- session 创建和连接
- 设备权限与设备列表
- 麦克风采集状态
- 文本发送、文件发送和日志展示
- 悬浮字幕窗口的打开方式与紧凑字幕视图

## 后续演进

下一步真正进入 Electron 时，优先迁移这些能力：

1. 独立 BrowserWindow / always-on-top overlay
2. preload 与主进程通信
3. 系统托盘、快捷键与悬浮窗开关
4. 原生音频采集与系统音频能力

## 原生桌面客户端

正式新增入口为 Tauri 2 + Rust + 内置 React，旧预览命令保留。项目根目录运行 `npm run dev:client` 或 `npm run build:client`，API/worker 按现有方式独立启动。配置、平台依赖及验证边界见[原生客户端说明](../../docs/engineering/native-client.md)。
