# P0 / P1 本地实现验证

本文件记录当前本地验证。真实浏览器采集、真实 ASR/LLM、Postgres/S3、生产部署和现场长会话需要分别验证。

## P0：诊断基线

- 已实现：`RECORD_TRACE_ENABLED=true` 开启服务端有界诊断，默认关闭；仅记录标识、耗时、字节、用量和状态。后台配置权限用户可读取 `/api/diagnostics/traces`。
- 浏览器通过 sessionStorage 的 `meeting-trace=1` 开启本地诊断。浏览器与服务端各使用自己的单调时钟，不能直接相减；HTTP trace ID 用于关联。
- 诊断不保存 PCM、转录、模型提示或凭据；sink 抛错不影响业务。分位数来自最近 512 条保留样本，不是全量统计或生产 SLA。
- 已接入 HTTP、聚合存储、音频 ACK、ASR 文本、纪要生成/用量及 UI 提交。队列指标随 P1 有界队列实现补齐。
- 当前本地验证：125 项 Node 回归通过，ESLint 和 Web TypeScript 检查通过。回归包含重复/冲突 ACK、断线、租约与停止排空等既有协议场景，不能替代现场录音。

## P1 / EP-02：增量同步

- 同一事务维护轻量 SSE 元数据、保留事件和列表投影；JSON 聚合保持写入权威。缺失投影启动时可重建。
- SSE 轮询只读取授权/过期元数据和游标后的事件；Record 列表读取投影，正文搜索在数据库完成。初次连接仍读取快照。
- Web 应用 segment upsert/remove 和顶层字段增量；重复游标忽略、不连续或旧服务事件回退快照。权限撤销、历史缺口与退避沿用既有机制。
- 新定向场景验证事务回滚、重建、隔离、增量合并及重复/缺口；原 125 项回归通过。Postgres SQL 已实现，当前证据仅覆盖本地 SQLite。

## P1 / EP-03：音频队列

- IndexedDB v2 增加 record/source 索引和事务字节计数；升级游标保留 v1 待传片段和停止清单。热路径不再调用 chunks.getAll。
- 最多每批 16 个音源头片段、同时 2 个请求；同一音源按 sequence 顺序，失败音源暂停本轮但其他音源继续。发送前重新检查可见 Record 集合。
- 保留 48 MiB 原始 PCM 限额，重复片段不重复计数、冲突保留原片段；404 保留，410 清理并同步字节计数。
- 当前 129 项回归通过，ESLint / TypeScript / Web build 通过。新增队列场景使用 fake-indexeddb，另用隔离 Chrome 和真实 IndexedDB 验证 v1 升级、断网保留、刷新恢复和双音源上传 80 片段，并发峰值 2，最终待传 0。
- 浏览器场景仅使用合成 PCM 元数据；没有验证麦克风权限、真实声音或两小时现场录制。见 [浏览器证据](p1-browser-queue-2026-10-12.json)。

## P1 / EP-04：按预算分层纪要

- 固定 generation、转录/笔记修订和原文 manifest hash，按 24 个片段的稳定分组再按预算切窗。默认每次输入最多 24,000 UTF-8 字节，作为保守 token 上界；额外的系统提示仍需上下文余量。`RECORD_MINUTES_INPUT_BYTES` 可在后端配置，范围 4,096～96,000。每次供应商请求仍保留原来的 180,000 字符防线。
- 每窗引用原始 segmentId/revision；多层综合只使用已经校验的摘要和叶子标识目录，保留说话人标签。最终输出再次对原始快照校验。
- 成功窗口和综合节点持久化，可在租约过期或手动重试后复用。修订只使内容发生变化的窗口失效；模型、endpoint、笔记、generation 或预算变化使对应策略缓存失效。
- 所有窗口完成并通过最终校验才返回完整结果；失败保留进度和可复用缓存，界面显示未完成。会中请求合并排队，终稿撤销旧 live fence 并优先；同一记录只允许一个有效的纪要执行租约。
- 人工编辑、转录修订、删除和 fence 变化均拒绝晚返回结果。删除同事务清空正文事件投影；诊断仅保存白名单元数据。有效窗口的 token 用量立即计入本地统计，缓存复用不重复计费统计；供应商失败调用、缺失 usage 和实际账单费用仍不等于已测成本。
- 超过 180,000 字符的合成转录经本地 HTTP 模型夹具、真实 provider adapter、worker、引用校验和 SQLite 完成落库。早/中/晚事实与撤回用例验证分层管道保留夹具输出的事实；**不证明真实模型的事实保留率或中文会议质量**。

## 最终场景与回归（2026-10-13）

| 验证 | 结果与边界 |
| --- | --- |
| 标准 `npm test` | 140/140 通过，包含新增 P0/P1 场景 |
| 全部 `tests/records*.test.mjs` | 119 项：118 通过、1 跳过；Postgres 行锁/重启测试未配置环境。与标准回归有重叠，不能相加 |
| ESLint、Web TypeScript、Web build、文档检查 | 通过；构建成功不证明已安装或已部署 |
| HTTP SSE | 增量不读取聚合、游标 reset、注销撤销，以及关闭增量后的快照回退 |
| IndexedDB | v1 迁移、重复/冲突、48 MiB 限额、失败音源隔离、顺序/并发、404 保留/410 清理、账号边界、串行回退 |
| 真实 Chrome | 实际 IndexedDB、刷新恢复、双音源 80 片段、最大并发 2、最终待传 0；合成元数据，没有麦克风或现场声音 |
| 长纪要 | 分窗/多层汇总、叶子引用、失败窗口恢复、局部修订失效、notes/model/endpoint/generation 隔离、人工编辑/删除/fence、并发 worker 和旧路径回退 |
| 合成矩阵 | 5/30/60/120 分钟 × 1/2 来源的元数据读写；不是真实采集。120 分钟双来源标为超出现有容量；20 条库存读取不算 20 场并发录音 |
| 阅读者负载 | 单记录 × 1/5/20 个合成阅读者，比较完整聚合读取和轻量事件读取；不含网络、页面渲染或现场 ASR |

60 分钟双来源合成记录（7,200 个 receipt、1,440 个片段）中，20 个阅读者读取突发的 p95 为完整读取约 112 ms、事件读取约 0.25 ms。一次片段编辑后的完整视图约 463 KB、增量事件约 948 B。当前写入仍约 40 ms，投影维护带来额外写入成本；这些数据是本机热 SQLite 微基准，不能外推生产 SLA。见 [事件读取基准](p1-feed-benchmark-2026-10-12.json) 和 [完整元数据矩阵](p1-aggregate-matrix-2026-10-13.json)。

可复跑命令：

```sh
npm test
node --test --test-concurrency=1 tests/records*.test.mjs
npm run lint
npm run typecheck
npm run build:web
npm run check:docs
node scripts/benchmark-record-aggregate.mjs --matrix
node scripts/benchmark-record-feed.mjs /tmp/record-feed-benchmark.json
node scripts/test-record-queue-browser.mjs /tmp/record-queue-browser.json
```

浏览器脚本需要 Playwright 和可用 Chromium。可用 `PLAYWRIGHT_MODULE_PATH` 指定已安装模块、`BROWSER_EXECUTABLE_PATH` 指定隔离测试用的 Chrome；不会访问用户日常浏览器配置。

回退与诊断：

- API 设置 `RECORD_DELTA_ENABLED=false` 并重启，恢复旧 SSE 事件和客户端快照刷新；投影继续维护。
- worker 设置 `RECORD_MINUTES_PIPELINE_ENABLED=false` 并重启，恢复原生成路径。长输入会再次触发原字符上限，已有结果保留。
- 浏览器 sessionStorage 设置 `meeting-queue-serial=1`，恢复串行上传；IndexedDB v2 的音频条目与原导出格式一致，不清库。不要直接发布只会以 v1 打开数据库的历史 bundle 来回退；使用当前兼容实现或先导出待传备份。
- 服务端 `RECORD_TRACE_ENABLED=true` 开启诊断；可选 `RECORD_BUILD_ID` 标注构建版本。浏览器 `meeting-trace=1` 开启本地 trace，开发模块 `traceSummary()` 汇总保留样本。队列 age 使用持久化墙钟；同页面的耗时使用单调时钟。没有跨设备端到端实测。

P2 的热聚合迁移、公平调度和两小时双来源录制仍未实现。真实 Postgres/S3、真实 ASR/LLM、设备权限/休眠、现场长会话、费用账单和生产部署尚未验证。
