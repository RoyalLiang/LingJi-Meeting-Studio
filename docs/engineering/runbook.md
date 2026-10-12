# 运行、配置与恢复

## 开发与模型

Node 22.14+、npm，执行 `npm ci`、`npm run dev`。访问 [工作台](http://127.0.0.1:3000)。Web 3000、Record API 3030、后台处理器同时运行。`Ctrl+C` 关闭本次启动的子进程。

`.env.example` 复制为 `.env` 后配置，密钥不进入 `VITE_*`，不提交 `.env`。没有模型时只开放文字导入；显式 `RECORD_PROVIDER=fixture` 提供标注的测试内容，在生产环境禁用。

ASR 二选一：`DEEPGRAM_API_KEY`（模型可调），或完整的 multipart `ASR_API_URL`、`ASR_API_KEY`、`ASR_MODEL`。纪要与翻译使用完整 JSON chat endpoint `LLM_API_URL`、`LLM_API_KEY`、`LLM_MODEL`，需要服务支持 `response_format=json_object`。接口兼容不等于模型质量达标。

浏览器 PCM 按 2 秒一片提交，最后短片在停止时 flush。服务器持久接收不表示识别完成。供应商有显式超时和有限重试；修正配置后在页面点击重新处理。摘要超过当前输入预算会报错，不能静默截断正文。

## 持久部署

默认 `.data/records` 内的 SQLite、音频与本地开发签名密钥都必须保留。SQLite 使用 FULL/WAL，Node 22.14 的内置 SQLite API 仍有实验警告。迁移前备份数据库及音频，不复制正在写入的单独 sqlite 文件作为一致备份。

Postgres 设置 `RECORD_DATABASE_URL`，启动创建独立 `record_aggregates` 表与到期任务索引。API 和 worker 共用行锁、相同领域提交及同一个数据库。生产迁移应由单独步骤先执行建表，避免多个新实例同时做 DDL。本轮未验真实 PG。

音频二选一：共享持久文件卷，或 `RECORD_S3_BUCKET`。S3 使用专用私有桶、版本控制从未启用；启动检查版本状态，拒绝带历史版本的桶。配置 Endpoint/Region/PathStyle 与 SDK 凭据，权限限定 `meeting-audio/` 前缀的 put/get/list/delete 和版本状态读取。对象采用 SHA-256、条件写，读取复核哈希。SDK fixture 不代替桶、IAM、网络和故障验收。

`npm run build:web` 构建后，配置以下值再 `npm start`：

- `RECORD_SESSION_SECRET`：至少 32 个字符的随机密钥，多实例相同。
- `RECORD_PUBLIC_ORIGIN`：用户访问的完整 HTTPS Origin。
- HTTPS 反向代理：转发到 Web 3000，保留 Host 与 Origin，SSE 关闭代理缓冲和短超时。
- 持久数据库/对象卷；注册公开时设置 `RECORD_INVITE_CODE`。当前没有邮箱验证/找回密码/组织权限，正式公开前应接入适当身份服务。

`npm start` 强制生产环境，cookie 为 Secure；不要用外网 HTTP 规避这一要求。程序默认只监听本机回环，不自动配置代理或部署服务器。`GET /api/health` 检查数据库，不证明供应商、对象存储或整体业务可用。

## 留存与删除

记录创建时选择 1/7/30/90 天。默认临时原音在会话排空后清理；逐片段最多 24 小时，识别失败过期后不能继续恢复该片段。选择保留原音才提供会后 WAV Range 回放。

删除立刻设置墓碑和新 generation，分享/读取/旧任务被隔离；后台清理音频，设置中的删除清理计数区分待处理与完成。后台必须持续运行。删除墓碑定期复查迟到孤儿对象。部署备份、日志及浏览器离线设备不属于服务可即时擦除的范围。

本地待传音频上限 48 MB。IndexedDB 配额耗尽时停止采集，并明确告知最后未能保存的片段。隐私模式、浏览器清理或设备丢失可能破坏待传数据，不能承诺本地永不丢失。

在设置中下载待传音频备份，再恢复为分段 WAV：

```bash
node scripts/recover-audio.mjs pending-audio-RECORD.json ./recovered-audio
```

脚本验证哈希，保留缺片边界，不覆盖已有输出；将 WAV 导入新记录。它不会把缺片伪装成完整会议。云端已接收、尚未转录与本机尚待上传是不同状态。

## 证据与依据

实际验证见 [验收表](acceptance.md)。技术约束依据：[Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)、[Vite 环境要求](https://vite.dev/guide/)、[MDN 共享采集](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)、[Deepgram PCM 采样率](https://developers.deepgram.com/docs/sample-rate/)、[S3 校验和](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html)、[S3 条件上传](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/command/PutObjectCommand/)。

## 豆包与本地开发账户

开发模式自动创建 `dev@local.test` / `LocalMeeting2026!`，重复启动保留既有密码和数据。登录页提供开发入口。生产环境不创建开发账户、不公开开发凭据；可用 `RECORD_DEV_ACCOUNT=off` 关闭开发入口。自定义 `RECORD_DEV_PASSWORD` 不通过 API 返回。

设置 → 模型与转录服务可修改转录地址、资源 ID、模型与密钥。默认豆包 v3 ASR，支持新版语音 API Key；选择旧版 AST 时兼容 `DOUBAO_AST_APP_KEY/SECRET` 与 `DOUBAO_AST_ACCESS_KEY/ACCESS_TOKEN`。方舟纪要需要单独的已开通模型 ID 或 `ep-…` 接入点。语音 Key 与方舟 Key 的权限分别验证，不能仅凭模型目录可读判定生成可用。

配置以服务端 `.data/records/providers.json` 为本地覆盖，权限 0600，已忽略；优先级为本地覆盖 → 环境变量 → 默认地址。后台每轮读取配置；空白密钥字段保留原值。设置读取只返回密钥是否已设置。生产写入配置需要 `RECORD_CONFIG_ADMIN` 中的账户；浏览器不保存供应商密钥。变更后使用“测试转录 / 测试纪要”发送静音或虚构文本验证，再开始会议。

自动输入设备跟随系统默认麦克风。指定设备不可用时回退到默认；录音来源保留实际设备名。设备授权由用户点击触发，共享音轨仍由浏览器选择器决定。

讨论脉络默认使用本地规则，旧记录不因保存模型密钥自动上传正文。用户逐条点击“使用模型分析”后，该记录的新转录版本可异步分析。纪要明确区分“本地提取”（规则引用原文）与“AI 整理”（发送转录及笔记至已配置模型），均保留引用版本；本地提取不是 AI 总结。


## 地址、设备与失败恢复

模型服务地址可填完整 `/chat/completions` 接口，也可填基础地址：根路径自动补 `/v1/chat/completions`，以 `/v1` 或 `/api/v3` 结尾则补 `/chat/completions`。模型 ID 与 API Key 是不同配置；语音 Key 与方舟模型 Key 也不能互换。设置中的“已设置”只说明服务端有值，连通性需单独测试。

开发模式允许保存 HTTP/WS 地址；生产保存时要求 HTTPS/WSS。当前本地 HTTP 模型配置按用户要求保留；代理的真实调用验收被自动审批拒绝，原因是密钥会向未验证外部 IP 明文传输。不要将配置存在视为模型调用成功。测试转录仅发送短静音；测试纪要仅发送虚构连通性文本。

录音前可选“自动 · 跟随系统默认麦克风”，或指定已授权设备。设备名未出现时，在设置里点击“授权并刷新设备”；权限只在明确操作时申请。开始录制会重新枚举设备，指定设备消失或约束不满足时回退默认输入；录制中设备结束则停止该来源并排空。系统共享音轨仍由浏览器选择器决定，不能由网页代替选择。

ASR 重试达到五次后会阻塞该来源后续片段。修正配置后可点击“重试转录”，重新处理未完成片段；已完成片段保留，过期原音不能恢复。本轮没有自动重试历史未知会议音频。

本轮合成验收样本以“合成语音…非真实会议”命名，分别保留于默认开发账号和浏览器验收账号。它们验证导入、真实豆包识别、规则提示、本地纪要与回放；不证明真实云端 AI 总结质量。详情见[验收表](acceptance.md)。

## 局域网与实时纪要测试

`npm run dev` 已向前端传入 `--host 0.0.0.0`，同一局域网可访问 `http://<本机局域网 IP>:3000`；也可单独运行 `npm run dev -w apps/web -- --host 0.0.0.0`。API 默认仍是 127.0.0.1:3030，经 Vite `/api` 代理访问；不要随意改为公开 API。远端页面打开不等于可录音：局域网 HTTP 不具备 localhost 安全上下文豁免，麦克风与屏幕共享需配置可信 HTTPS；没有关闭浏览器安全保护。生产开发账户默认开关与原先环境限制保持一致。

设置里选择协议并保存；选择 Responses 时完整接口一般以 `/responses` 结尾。若服务不提供 SSE，仍接收整包 JSON并提示非流式；截断 SSE 显式失败。开启记录的自动纪要后，观察会中草稿、主题与首字耗时；停止后先确认转录排空，再核对终稿版本。人工修改终稿后自动覆盖暂停。真实模型测试应只用获授权的数据和目的地；本轮 HTTP 服务的自动调用审批限制仍存在。

隔离浏览器 fixture 时，使用与主应用不同的主机名（例如 fixture 用 localhost，主应用用 127.0.0.1），不要只换端口：Cookie 不按端口隔离。独立数据目录不能自动隔离同主机浏览器 Cookie。本轮同主机联调替换了浏览器登录 Cookie，主应用需重新登录；账号数据与模型配置未更改。


### 页面持续提示实时连接中断

前端遇到临时 API 或代理故障会按 1、2、4、8、15 秒上限重连，每次先读取记录并补齐最新内容。页头“已连接”表示当前事件流已打开；“网络可用”只用于未选择会议的首页。登录失效或记录不可访问会停止重试并显示错误。

升级前已永久关闭的旧页面可刷新一次加载修复。若仍持续中断，检查 `npm run dev` 的 API 是否运行、浏览器 `/api/records/<id>` 与 `/events` 的状态，以及代理的 ECONNREFUSED 日志。不要以 navigator.onLine 或健康检查成功代替登录后的 SSE 验证。修复不会清理本地待上传音频。
