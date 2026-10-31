# Pi 作为会议执行底座的可行性

核验日期：2026-10-31（Asia/Shanghai）。状态：**proposed，仅本地研究，尚未集成**。

## 以会议任务为中心评估 durable，而非引入编码助手

引入 Pi 的目的，是复用 agent 的工具循环、任务管理、排队、取消和故障恢复，减少聆记自行维护后台链路的工作。会议助手的核心任务是会后复盘、跨**用户所选会议**问答、决策/风险/行动候选提炼，以及受控查询会议资料。是否减少实际延迟或提高稳定性，需要同一任务、同一模型和相同故障条件的验证；本报告不声称已经获得这些收益。

**建议以 `pi-durable` 作为后续 fixture spike 的主要候选，同时保留现有后端的数据、权限与模型配置所有权。** 它比 `agent-core` 更贴近持久任务调度需求；但 1.4.0 明确为 Experimental，API 可在版本间无预告变化。`coding-agent` SDK 更适合复用现成 Skill/extension 资源加载和单会话管理，不能因此推断其扩展与 durable registry 直接兼容。[D: README L3–7、L104、L127、L226–243]

这不是批准集成、迁移或新增产品界面的决定。本轮不调用真实模型，不使用真实会议资料，不改变现有录音、ASR、实时转录、纪要生成或导出流程。Markdown 与飞书云文档导出保持既有边界，画板仍仅作为飞书文档组件；独立会议助手不持有外发能力。

## 版本证据以官方 1.4.0 发布包为准

官方身份为 [earendil-works/pi](https://github.com/earendil-works/pi)，历史 `badlogic/pi-mono` 地址重定向到该仓库。本轮从官方 npm registry 读取元数据，检查并下载 1.4.0 包。此前固定的 `35dfa757…` 是历史源码观察点，**不用于给本次发布包的新功能挂行号**：其 durable README 与 1.4.0 发布包实测存在差异。

以下引用标识指向版本明确的官方发布制品。行号指制品解包后的对应文档，不指 GitHub 当前 main。

| 标识 | 官方版本制品 | 本地可复查文件 |
| --- | --- | --- |
| A | [pi-agent-core 1.4.0 tgz](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-1.4.0.tgz) | `/private/tmp/pi-size-study/core/node_modules/@earendil-works/pi-agent-core/README.md` |
| C | [pi-coding-agent 1.4.0 tgz](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.4.0.tgz) | `/private/tmp/pi-size-study/full/node_modules/@earendil-works/pi-coding-agent/` 下 `docs/sdk.md`、`docs/skills.md`、`docs/security.md`、`docs/mcp.md` |
| D | [pi-durable 1.4.0 tgz](https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz) | `/private/tmp/pi-size-study/durable/node_modules/@earendil-works/pi-durable/README.md` |
| H | [chord 1.4.0 tgz](https://registry.npmjs.org/@earendil-works/chord/-/chord-1.4.0.tgz) | `/private/tmp/pi-size-study/durable/node_modules/@earendil-works/chord/README.md` |
| M | [pi-mcp 1.4.0 tgz](https://registry.npmjs.org/@earendil-works/pi-mcp/-/pi-mcp-1.4.0.tgz) | `/private/tmp/pi-size-study/full/node_modules/@earendil-works/pi-mcp/README.md` |

[registry 元数据](https://registry.npmjs.org/@earendil-works/pi-durable/1.4.0)和本地 `/private/tmp/pi-size-study/metadata.json` 记录版本、制品 URL、压缩/展开尺寸与依赖；三个目录各保留 `package-lock.json`。后续验证应固定直接包版本、依赖锁和制品 integrity，而不是启动时取 latest。MIT 顶层许可不代表依赖许可全部相同，分发前仍需生成实际依赖清单。

## 三条路线复用的层级不同

| 路线 | 已有官方能力 | 仍需聆记负责 | 对会议产品的意义 |
| --- | --- | --- | --- |
| `agent-core` + `pi-ai` | 单 agent 模型/工具循环、状态事件、steer/follow-up、并发工具、取消、上下文转换钩子 | 持久会话、压缩策略、任务状态、崩溃恢复、资源/Skill 管理、授权 | 较轻，但容易重新自建本次希望减少的 harness 层 |
| `coding-agent` SDK | 上述循环及 AgentSession、持久 SessionManager、会话树、压缩、自动重试、Skill/extension 资源加载、显式启用的 MCP | 领域工具、受控资源来源、跨会话调度/恢复、产品权限与隔离 | 若既有 Skill 生态兼容优先，可作为比较对象；不直接启用编码工具 |
| `pi-durable` | 持久 conversation/task、inbox、scheduler、child tasks/子 agent、task graph、恢复、registry extension/task/hook 生命周期、压缩 | 产品 admission/并发预算、会议授权与快照、Skill 适配、可信代码边界、宿主重开及存储运维 | 本次后台管理目标最接近；Experimental 是主要采用风险 |

core 默认可并行执行工具，结果仍按模型源顺序进入上下文；steering/follow-up 是单会话的输入调度，不是持久多 agent supervisor。[A: README L111–114、L169–182、L392–427]

SDK 的 AgentSession 明确拥有一个 conversation、模型/工具、队列、压缩与 extension runtime；SessionManager 管理持久或内存 entry tree。`prompt()` 等待包括自动重试的运行结束；流中再次输入必须选择 steer/follow-up；`abort()` 等待空闲。`dispose()` 取消工作并移除监听。[C: docs/sdk.md L28–70] 发布 JS 的 `dist/core/agent-session.js` L3037–3141 还明确实现重试分类、预算、指数退避和取消；这是发布 JS 行号，不是源 TS 行号。

不能笼统说“Pi 没有持久任务/多 agent 调度”：durable 1.4.0 已有真实 task scheduler 与子任务/子会话所有权。也不能反过来把 durable 的恢复保证归给 core 或 SDK。[D: README L127、L638–712]

## Skill、插件资源与运行任务要分别管理

**Skill 是工作指令与辅助资料，不是一个执行进程。** coding-agent 在启动时提供 Skill 名称/说明，任务需要时再加载完整指令；Skill 可携带脚本、引用和资产，支持 Agent Skills 规范。模型可能漏加载相关 Skill；强制选择需显式调用。`allowed-tools` 在该文档中仍标 Experimental，不能据此认为已构成强制安全隔离。[C: docs/skills.md L3–7、L41–65、L69–85]

coding-agent 的 `ResourceLoader` 供应 extensions、skills、templates、themes 和 context。CLI 默认加载 codemode、tool_search 与 MCP；SDK 不会自动加载，需要显式 factory 和绑定扩展生命周期。[C: docs/sdk.md L98–116] 因此“支持 Skill/MCP”不等于产品已经有插件安装政策、任务配额、权限收敛和崩溃恢复。

durable registry 中的 extension 可以提供 tools、sections、hooks、wraps、tasks；conversation 保存 extension 名称，定义由进程安装。按名称替换或卸载时，已启动工作继续使用拿到的旧实现，下一 phase 才用新代码；重开进程后必须重新安装定义。[D: README L226–243、L467–472] 这适合冻结版本后运行会议任务，但不能用热替换默认实现来保证任务全程版本一致。

**设计建议：** 首期仅接受产品审核的说明型会议 Skill，显式选择固定版本，将其指令转为 durable 的受控 instructions/section，并绑定允许的领域 tools。这个适配由聆记实现；不声称可以直接导入 coding-agent 任意 Skill/package/TypeScript extension。Skill 内脚本不默认执行。可执行插件单独审核、固定版本；不可信代码需要进程/操作系统隔离，同进程 hook 不能阻止其直接使用 Node API。[C: docs/security.md；D: README L226–243]

插件目录建议记录 `pluginId/version/integrity/capabilities/compatibleHarnessVersion`；每个任务固定 `skillId/version`、extension 集合及模型配置版本。升级只作用于新任务；老任务恢复时加载原版本定义，缺失时显示 blocked，不悄悄换版本。这里的目录、版本策略与兼容校验是**产品设计**，不是 Pi 自动提供的产品能力。

## durable 可承担哪些运行管理

| 关注点 | 发布包已说明的能力 | 产品需补的最小策略 |
| --- | --- | --- |
| 排队 | busy conversation inbox；follow-up、steer、reject；可撤回 queued submission；失败后队列仍保留 | UI 说明排队/加入当前工作区别；任务去重、队列上限、优先级 |
| 并发 | 多 conversation、child tasks、嵌套工具；task graph 显示所有权/状态 | 用户/模型/资料源总并发和 token/费用预算；不要默认每场会都开子 agent |
| 取消 | conversation abort、submission withdrawal；所有权自底向上取消；后台任务有独立边界 | 默认为前台所属任务，用户取消应覆盖该任务子树；避免随意设置 background |
| 超时 | model stream timeout 配置；codemode timeout 与 replay 语义 | 总任务 deadline、单工具 timeout、MCP timeout；下游必须遵守 abort，超时不代表外部副作用撤销 |
| 失败恢复 | 中断工作保留 pending；resume 调度；crash-loop limit 默认 5 后 parked；可 retryTask | 宿主启动重新安装版本/打开存储；呈现 parked/blocked；限次恢复，不无限静默重试 |
| 副作用 | nested call 按 key 重附着；工具标记 replay safe/unsafe | 每个外部写操作自己提供幂等键，不能把 safe replay 当 exactly-once |
| 故障隔离 | task/tool/hook 故障分域；beforeTool 失败阻止调用；存储错误关闭 Harness | 数据库瞬态重试策略、重开、错误呈现；插件执行不等于安全沙箱 |
| 观察 | taskGraph/watchTaskGraph、持久 inbox/live 状态；watch 慢消费者合并帧 | 任务状态映射给既有服务事件；重连读取当前状态，不能假设 watch 重放所有事件 |

对应精确证据：[D: README L127、L164、L216–222、L325–353、L368、L413、L490–521、L638–712、L823–835]。SQLite 的 WAL `synchronous=NORMAL` 承诺进程崩溃恢复，但最新提交可能在断电/宿主失败时丢失；不是无条件 RPO=0。[D: README L765] 关闭仍需等待正在执行的代码响应 abort，插件无响应会拖延关闭。[D: README L835]

## 最小会议工具集只暴露领域能力

以下都是**建议新增的产品适配接口**，不是 Pi 内置工具。无需注册 `read/bash/edit/write`，也不让模型直接使用数据库、任意文件路径或 URL。

| 工具 | 返回/副作用 | 服务端硬约束 |
| --- | --- | --- |
| `list_selected_meetings` | 本任务冻结的会议 ID、标题、转录/纪要版本、可用材料元信息 | 不发现未选择会议，不返回无权会议 |
| `query_meeting_evidence` | 在所选快照内检索片段与受控资料引用 | 所有 meetingId 属于任务授权范围；分页、字符/token 限额；资料只读 |
| `read_meeting_segments` | 按引用读取指定版本片段、时间范围和必要相邻上下文 | 校验 meetingId、transcriptRevision、segmentId；无效引用显式失败 |
| `save_analysis_draft` | 保存独立的复盘/问答/决策/风险/行动候选，带证据引用 | taskId+artifactKey 幂等；验证结构与引用；不改正式纪要或人工字段 |

会后复盘和跨所选会议问答使用同一组读取工具，差异放在审核过的 Skill 指令与结果 schema。跨会决策合并必须保留每条来源，冲突意见不能用模型摘要抹平。行动输出是候选，不创建工单、不发邮件、不推送飞书。用户选择“采纳”走产品的显式事务/API，未来“外发”另需独立授权和幂等审计；本轮不设计或启用外发工具。

会议资料 MCP 是 `query_meeting_evidence` 的一种后端来源适配：预先配置服务、方法白名单、凭据域、资料范围、分页、超时与结果大小限制。先将服务响应规范化为带来源的 evidence，再交模型，不把服务器声明的只读注解当产品授权。coding-agent SDK 的 MCP 工厂不能直接假定能用于 durable；可以评估独立 `pi-mcp` 客户端接入领域适配层，但需实际协议/取消验证。[C: docs/sdk.md L116；C: docs/mcp.md；M: README]

## 冻结引用与权限，保护人工编辑

**建议任务输入契约：** 服务端生成 `taskId`、调用者/租户、所选会议集合、每场 `transcriptRevision` 与 `minutesRevision`、资料源版本/快照摘要、Skill/插件版本、模型配置版本、期限和预算。会议范围是服务端绑定的 capability，不是模型参数。每次工具调用重新校验当前访问权；任务期间撤销权限立即阻断后续读取并取消任务，缓存结果也遵循数据访问政策。

**建议引用契约：** 每个主张包含 `meetingId/transcriptRevision/segmentId/startMs/endMs` 与可验证摘录或内容摘要；资料引用另含 sourceId/version/location。保存前服务端核实引用属于冻结版本与授权集合。压缩只能减少发给模型的上下文，不得丢失持久 artifact 的证据映射；durable 压缩保留旧 entry 只能证明其会话历史还在，不能替代会议转录版本存档。[D: README L550–565]

**建议结果契约：** 助手产物存为独立 draft 与版本，记录生成配置和 evidence；人工编辑保存单独 revision。后台重跑创建新版本，不能覆盖人工修订。采纳进正式纪要时用 expectedRevision/compare-and-set；若原纪要或转录已变化，标记 stale 并要求重新核对，不静默重基。Pi 的 conversation 文档不是第二套正式纪要数据库。

建议展示状态为 `queued → running → completed`，并允许 `cancel_requested → cancelled`、`failed`、`blocked`、`stale`。这是产品状态映射，不应直接冒充 durable 原生枚举。taskGraph 的 pending/running/waiting/completing 与 blocked/parked 原因需保留作诊断；“模型运行结束”也不等于产物已校验/持久化成功。[D: README L216–222、L704–712]

## 接入既有后端，保留薄而明确的产品层

后续设计可在当前后端加入会议任务适配器：接收已鉴权的任务输入，建立冻结快照，提交 durable conversation/task，再将状态映射到既有前端服务事件。领域 tools 调用现有 Record/转录/纪要/资料接口，模型凭据只由后端配置传入，不扫描用户 Pi 全局配置。浏览器和桌面复用此边界，不要求安装 Pi CLI，不新增终端界面。

Pi 负责循环、inbox、任务所有权与可恢复执行；聆记负责身份/会议授权、快照、证据、draft 事务、人工版本、任务 admission/预算，以及启动时恢复和观测。为进程崩溃可靠恢复，不应先在 Pi 外再造同职能的自有持久队列；是否需要多个 worker 或远程协调应等真实部署需求出现后决定。durable 是否适合当前数据库/单进程生命周期，仍需 spike 验证，不能由包说明代替集成证据。

## 安装包预算以未裁剪生产闭包为起点

实测官方 1.4.0，隔离目录 `npm install --ignore-scripts --omit=dev --save-exact`；未省略 optional，但锁中无 optional 包。统计只包括 `node_modules` 普通文件；gzip 为本地 tar.gz level9，不是 DMG 压缩率，不包括 Node、用户数据和正式应用代码。top-level tgz 直接下载测量，闭包 gzip 重新打包测量。

| 路线 | 顶层 tgz / 展开字节 | 生产包数 | 完整文件 MiB | 完整 gzip MiB | 理论裁剪文件 / gzip MiB |
| --- | --- | ---:| ---:| ---:| ---:|
| core+ai | 899,037 / 4,575,298 | 88 | 66.65 | 11.56 | 27.20 / 4.54 |
| coding-agent SDK | 7,612,554 / 23,419,059 | 121 | 107.11 | 23.40 | 50.30 / 10.75 |
| durable | 801,973 / 3,516,915 | 93 | 76.01 | 14.08 | 32.08 / 6.09 |

理论裁剪仅移除 `.map/.ts/.md/.markdown` 与 docs/tests/examples 等路径，没有运行验证，**不是可发布的裁剪方案**。动态加载、provider SDK、WASM、extension 资源与 package exports 不能凭 tree shaking 假设全部可移除。full 内含六个平台 TUI `.node` 共177,976 B，以及 QuickJS/Photon生产 WASM约2.52MB；durable也含两份生产 WASM约2.52MB。core无 `.node/.wasm`。安装时未执行 scripts，只能确认包里已带这些文件，不能证明运行资产完整。

和当前桌面准备脚本使用的依赖闭包相比，同版本可去重七包（long、undici-types、五个 @protobufjs 子包）合计319,503文件字节，约0.305MiB；ws/protobufjs/@types/node版本不同，不能直接按同版本去重。此差额不改变预算量级。锁与精确数值留在 `/private/tmp/pi-size-study/{metadata.json,sizes.jsonl,measure.py}` 及各 route 的 lockfile。最终签名安装包增量须走实际打包验证。

## 后续 fixture spike 只回答采用前的关键问题

这是**下一步提案，尚未执行**。建立隔离实验目录、锁定 durable1.4.0和依赖，使用合成三场会议与一个本地假 MCP 资料源；模型采用明确的 fixture provider，不能把结果当真实模型质量或性能。对照可保留一个 coding-agent SDK +同领域工具的样例，检验 Skill 适配收益；无需先造插件市场或 UI。

1. 两种审核 Skill 完成会后复盘和跨选中会议问答；输出可验证决策/风险/行动候选，引用不越会议与版本范围。
2. busy 排队、并发限额、撤回、子任务取消及总 deadline；下游故意忽略 abort 时记录不能强制完成的边界。
3. 在模型流、工具结果提交前后终止宿主，再重开；验证重附着、幂等保存、unsafe side effect不重放、parked/blocked可观察。SQLite进程崩溃结果不外推断电保证。
4. 任务运行时升级插件，确认旧任务仍用冻结版本；缺失旧版本显式 blocked；Skill或资料包含越权指令仍被服务端权限拒绝。
5. 人工改纪要后任务完成，旧任务只形成 stale独立draft；后台重跑不覆盖人工内容；访问权撤销后工具和结果读取受阻。
6. 比较维护代码量、可诊断状态、恢复行为、调用/费用预算及真实环境下后续完整任务延迟。只有fixture不会证明ASR/LLM质量、真实MCP兼容或供应商稳定性。

采用门槛：领域适配足够薄、恢复和取消符合预期、没有第二套正式纪要、引用与人工保护有效，且团队能承担 Experimental API 的升级验证。未达门槛时继续沿用现有后端，不为引入依赖而引入依赖。

## 运行时事实分层保留

- **历史测量环境：** 本轮隔离安装使用交互终端 Node v22.14.0 / npm11.8.0；Pi声明 Node≥22.19.0，安装有engine警告。成功下载与解析不能视为运行兼容验证；未执行 Pi。
- **产品原有打包环境：** 原有桌面准备脚本与生成资源已核实内置 Node v24.21.0，所以Pi预算无需附带第二份Node或Electron。该事实与交互终端版本不同。
- **本轮产品更新：** 源码与本机生成的后端资源已升级到 Node v26.12.1 / SQLite3.54.0；本地工作树386项Node回归、21项Rust回归、静态检查、Web构建及隔离后台启动/重启通过。合成性能与跨版本数据检查见[运行时升级证据](../evidence/node26-runtime-2026-10-31.json)。未替换已安装客户端或发布远端版本，也未据此验证Pi兼容性。

本轮只做官方资料与制品研究及静态尺寸测量，没有集成Pi、运行真实模型/会议/MCP、执行恢复实验或新增UI。尺寸与官方契约不能代替产品验收证据。
