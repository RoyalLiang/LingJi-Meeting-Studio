# 聆记 · Meeting Studio

浏览器优先的会议记录工具：采集音轨、可恢复转录、带来源引用的 AI 纪要。React/TypeScript 工作台使用浅青灰与松绿色、磨砂玻璃材质，提供深色主题。纪要按需展开。

## 本地运行

需要 Node.js 22.14+、npm。当前本地存储使用 Node 内置 SQLite，Node 22.14 会提示实验性 API 警告。

```bash
npm ci
npm run dev
```

打开 [本机工作台](http://127.0.0.1:3000)，创建本地账户。统一命令同时启动 Web、记录 API（3030）与后台处理器。未配置模型时可以导入已有转录；语音录制和 AI 纪要会明确显示配置要求。

复制 [.env.example](.env.example) 为 `.env`，填写 ASR 与纪要服务配置后重启。供应商密钥只在服务器使用。显式测试模式：

```bash
RECORD_PROVIDER=fixture npm run dev
```

此模式显示测试横幅，不能用于识别质量验收。开发数据放在被 Git 忽略的 `.data/`，不随源码分发。

```bash
npm test
npm run lint
npm run typecheck
npm run build:web
```

生产运行先配置会话密钥、公开 Origin、HTTPS 代理与持久卷，再执行 `npm run build:web` 和 `npm start`。详见 [运行手册](docs/engineering/runbook.md)。

## 能力与边界

- Record / Session / Source 领域内核；音频哈希、持久确认、幂等补传、seal 与排空屏障。
- 麦克风、共享音轨、文件和文字导入；IndexedDB 有界缓冲、断线补传、持久事件游标。
- 异步纪要、固定快照、引用校验、任务租约与 fencing、人工修订和历史版本。
- 搜索、说话人编辑、可选翻译、模板、原音回放、可撤销分享，以及 Markdown/JSON/ICS/工单候选导出。
- 账户隔离、CSRF、配额、临时音频 TTL、删除禁访与清理状态；SQLite/Postgres、文件/S3 适配器。

当前是可运行的工程首版。自动化与本机 UI 已验证；跨系统真实采音、60 分钟长会话、真实 ASR/LLM、Postgres/S3 和用户试点仍需对应环境验收。新识别链路采用 2 秒 PCM 批次，尚未实现供应商流式 partial，不宣称生产延迟或识别质量目标已达标。

从 [文档入口](docs/README.md) 阅读研究、设计与 [阶段验收表](docs/engineering/acceptance.md)。旧 Node 网关、桌面 shell 和 Go 实验保留；`npm run dev:legacy-web` 使用旧页面。
