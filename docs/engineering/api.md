# 当前 Record API

同源 `/api`，JSON 错误 `{error: code}`；写请求带 `X-CSRF-Token`。cookie HttpOnly，登录有效期七天。当前退出会撤销该账户已有登录。身份接口与分享只读接口不要求既有登录；分享 URL 是 bearer secret，不记录到公开日志。

| 路由 | 用途 |
| --- | --- |
| POST /auth/register、/auth/login；POST /auth/logout | 本地账户与登录 |
| GET /bootstrap | csrf、账户、模型配置可用性、配额 |
| GET/POST /records | 自有记录列表/搜索（q）与创建 |
| GET/PATCH/DELETE /records/:id | 一致快照、标题/笔记/翻译目标、墓碑删除 |
| POST /records/:id/sources | 启动来源；返回 sessionId、source id、epoch |
| POST /records/:id/audio | PCM16、16kHz、单声道，持久元数据回执 |
| POST /records/:id/seal | 全部来源的 epoch 与 lastSequence；范围内仍可补缺片 |
| POST /records/:id/retry | 配置修正后重试未完成识别；已过期原音不能恢复 |
| GET /records/:id/events?after=cursor | 持久事件 SSE；过期 reset，失权 revoked |
| POST /records/:id/import-text | 导入自然段，没有虚构音频时间 |
| PATCH /records/:id/segments/:segmentId | revision + text + speaker，并发编辑校验 |
| POST/PATCH /records/:id/minutes | mode 为 extractive（本地）或 model（AI）的任务；或预期 revision 人工修订 |
| POST /records/:id/insights | 显式授权该记录使用已配置模型分析；保留转录版本及引用 |
| GET/PUT /settings/providers | 读取脱敏配置 / 更新服务配置；生产需 RECORD_CONFIG_ADMIN |
| POST /settings/providers/test | kind 为 asr 或 minutes；仅使用静音或虚构连通性文本 |
| GET /development-account | 仅开发模式提供默认本地账户信息；自定义密码不返回 |
| GET /records/:id/minutes/versions/:revision | 有限历史纪要快照 |
| GET /records/:id/audio/:sourceId | 保留原音的 WAV 与单范围 Range 回放 |
| GET /records/:id/export?format=markdown/json/ics/issues | 记录与人工可审阅候选文件 |
| GET/POST /records/:id/shares；DELETE /records/:id/shares/:shareId | 默认纪要范围、24 小时有效、可撤销 |
| GET /shared/:token | 选定分享范围，纪要只含实际引用的快照 |
| GET /deletions | 自有删除墓碑的物理清理状态 |

音频请求：`sessionId, sourceId, epoch, sequence, sampleOffset, sampleCount, sampleRate=16000, digest=sha256hex, pcm=base64`。序号每来源从零递增，采样偏移连续，数据必须匹配采样数和摘要。稳定身份重试返回已有回执，身份相同内容不同返回 409。

回执 `durable, sourceId, epoch, watermark, missing, cursor` 表示对象与元数据曾在接收时持久提交；原音之后仍受用户选择的 TTL 约束，回执不代表永久留存、识别完成或模型正确。乱序片段不推进连续 watermark。

Record capture 与 transcription 分离。seal 后只有音频连续且所有处理成功才转 completed；模型缺配置/失败会 blocked/failed，不能假装结束。纪要必须使用已完成转录；输入快照、笔记修订、模型配置与模板组成任务身份，租约/fence 和预期人工版本隔离旧结果。

事件 cursor 是十进制字符串，仅在同一记录内单调。事件日志最多 1000 条。收到消息后客户端取一致快照；reset 也重新取快照。每条纪要内容的 evidence 必须匹配生成时的 segmentId/revision。

## 自动与流式纪要

- 创建记录可传 `autoMinutes:boolean`，启用前要求服务端已配置模型。
- `PATCH /api/records/:id/automation`：`{enabled:boolean,intervalSeconds:15|30|60|120}`；鉴权、Origin 和 CSRF 与其他写接口一致。关闭取消自动任务。
- `POST /api/records/:id/minutes` 新增 `scope:live|final`；默认 final，live 不要求会话结束。mode、scope、模型和版本参与幂等键。
- GET 记录新增 `autoMinutes`、`liveMinutes`；jobs 可有 `preview:[{kind,text}]` 和 `runtime`。预览不是可导出的正式纪要。
- SSE 新增 `minutes.delta`、`minutes.live`、`minutes.automation`、`transcript.translated`，仍用持久 cursor 补历史。
- 模型设置新增 `LLM_PROTOCOL:chat-completions|responses`，基础地址按协议补全；密钥仍只返回是否配置。
