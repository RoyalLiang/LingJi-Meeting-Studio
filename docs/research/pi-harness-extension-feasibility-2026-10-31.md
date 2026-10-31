# Pi harness 用于独立会议助手的可行性

核验日期：2026-10-31（Asia/Shanghai）。状态：**proposed，尚未集成**。

当前边界：暂停 Skill/自定义导出路线；保留 Markdown 与飞书云文档导出，画板只作为飞书文档中的组件。独立的 Skill/插件能力用于选中会议的复盘、问答、风险与知识提炼，不承担纪要外发。本报告只读取官方资料、包元数据和选定源码，没有安装 Pi、运行其代码或调用真实模型。

## 建议先保留现有导出器，再用 agent-core 做小范围验证

Pi 可嵌入聆记，但不建议直接把完整编码助手装进会议产品。若近期只需要固定的纪要分析与问答，先沿用既有模型调用即可；确认需要多轮工具调度、流式状态与取消后，再验证 `pi-agent-core`。完整 harness 的技能加载、会话树、压缩与扩展生态有价值，但同时带来文件、进程、配置发现和持久化等额外所有权。

| 选择 | 得到什么 | 聆记仍需负责什么 | 当前建议 |
| --- | --- | --- | --- |
| 暂不引入 Pi | 复用现有后端、模型配置与会议资料 | 固定分析流程、流式响应与领域授权 | 当前最小落地路线 |
| `pi-agent-core` | 工具循环、事件、状态、上下文转换、取消与调度钩子 | Record 权限、持久化、引用、预算、Skill 注册与 UI | 值得做独立、非生产的小验证 |
| `pi-coding-agent` 完整 SDK/RPC | 再加会话树、压缩、资源发现、技能/扩展和可选 MCP | 隔离默认能力、重做 Web UI 适配、数据与凭据边界 | 暂不作为产品默认运行时 |

这是针对聆记当前范围的设计判断，不是性能、质量或迁移成本实测结论。

## “Pi harness”对应的官方项目已迁移名称

官网是 [pi.dev](https://pi.dev/)，其源码链接指向 `earendil-works/pi`；历史地址 `badlogic/pi-mono` 当前重定向到这个仓库，并非选取第三方 fork。核验固定到提交 [`35dfa757378bd7a8570670e99c2687bdd1039a06`](https://github.com/earendil-works/pi/commit/35dfa757378bd7a8570670e99c2687bdd1039a06)，GitHub API 返回该提交时间为 `2026-10-30T23:17:56Z`。[原仓库入口](https://github.com/badlogic/pi-mono)、[当前官方仓库](https://github.com/earendil-works/pi)

以下固定提交中的版本与核验时 npm 官方 registry `latest` 一致；“一致”不等于已经验证 npm 包内全部文件与该源码提交逐字相同。

| 包 | 版本 | 用途与约束 |
| --- | --- | --- |
| [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/agent/package.json) | 1.4.0 | Agent 运行时；MIT；声明 Node ≥22.19 |
| [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/ai/package.json) | 1.4.0 | 模型与供应商适配；MIT；声明 Node ≥22.19 |
| [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/package.json) | 1.4.0 | 完整 harness、SDK 与 CLI；MIT；声明 Node ≥22.19 |
| [`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/mcp/package.json) | 1.4.0 | 独立 MCP 客户端；MIT；声明 Node ≥22.19 |

发布元数据可在 [agent-core registry](https://registry.npmjs.org/@earendil-works/pi-agent-core/latest)、[coding-agent registry](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest)、[pi-ai registry](https://registry.npmjs.org/@earendil-works/pi-ai/latest)、[pi-mcp registry](https://registry.npmjs.org/@earendil-works/pi-mcp/latest) 复查。旧 `@mariozechner/*` 示例不能直接当成本次新接入契约。MIT 要求保留相应版权和许可说明；打包时还需核对依赖及分发清单，不能把顶层许可当成全部依赖的统一许可。[官方 LICENSE](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/LICENSE)

## core 能提供工具循环，但不自带会议产品的数据边界

**已读官方源码。** `Agent` 默认工具列表是空数组；它提供状态与事件、工具执行、`beforeToolCall`/`afterToolCall`、上下文转换、请求准备和取消等接口。默认工具执行模式为并行，也可按工具或运行配置顺序执行。这使聆记可以只注册会议领域工具，而不提供文件或 shell 工具。[Agent 源码](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/agent/src/agent.ts#L83)、[core 使用说明](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/agent/README.md)

`pi-ai` 提供统一供应商接口、模型集合、自定义 provider 和流式调用。core 可注入 `streamFn`，也有面向浏览器后端代理的 `streamProxy` 示例。它不是新的模型服务，不会自动提高纪要质量；模型可用性、上下文长度和成本仍取决于实际供应商与任务。[模型适配文档](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/ai/README.md#browser-usage)、[core 代理示例](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/agent/README.md#proxy-usage)

**建议边界。** 保留聆记现有 Record、转录修订、纪要与人工编辑的所有权；助手读取冻结的选中会议快照，输出独立的分析结果与片段引用。Pi 会话消息不能成为第二份正式纪要，也不接管录音、ASR、实时转录协议或后台纪要生成。模型选择和凭据继续由聆记后端管理，不读取用户机器上的 Pi 全局登录配置。

首个候选工具集可限定为 `read_selected_minutes`、`search_selected_transcript`、`read_cited_segments`。这些是建议的聆记领域接口，不是 Pi 已有工具。服务端从当前用户与绑定的 Record 推导可读范围，每次校验权限；模型传入的 Record ID、文件路径或 URL 不能扩大范围。第一阶段不注册任何发布、写文件、命令执行、任意网络访问或跨会议搜索工具。

## 完整 harness 的默认行为需要显式收紧

**已读官方源码与文档。** `createAgentSession()` 默认使用持久会话、文件 settings、标准资源发现与当前工作目录。默认内置工具是 `read`、`bash`、`edit`、`write`；可用 `tools`、`noTools`、`excludeTools`、自定义 `ResourceLoader` 与内存管理器替换这些选择。`noTools: "builtin"` 仍保留扩展/自定义工具，不能把它误读成完全禁用外部能力。[SDK 文档](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/sdk.md)、[SDK 工具选择源码](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/src/core/sdk.ts#L63)

官方有 `createReadOnlyTools` / `createReadOnlyToolDefinitions`，包括文件读取和检索工具，但它表示对宿主文件系统的只读操作，不等于“只能读取选中会议”。把文件工具换成 Record API 才能表达本产品范围。[内置工具定义](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/src/core/tools/index.ts#L162)

官方安全说明明确：Pi 以启动账户的权限读、写和执行，不逐次要求工具批准；扩展、安装器和子进程也在同一权限下运行，除非有操作系统或虚拟化隔离。项目 trust 控制加载资源，不是文件、进程或网络沙箱。工具调用钩子可以实现审批流，但不能约束同进程恶意插件直接调用 Node API。[安全说明](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/security.md)

因此完整 harness 若后续试验，应使用产品独占的配置、资源加载器与会话存储，明确的领域工具白名单，并将不可信代码放在真正隔离的进程/环境内。仅隐藏 `bash` 按钮、给提示词写“只读”或监听 `tool_call` 都不足以隔离任意 TypeScript 插件。

## MCP 现在已内置，但 SDK 不会自动启用

**官方当前能力。** CLI 已将 MCP、codemode 和 tool_search 作为内置扩展加载；SDK 会话不自动加载这些内置扩展，需要显式创建 factory、交给资源加载器，并绑定扩展生命周期。历史上“Pi 不支持 MCP”的结论已不适用于此版本。[SDK MCP 说明](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/sdk.md#codemode-mcp)

完整 harness 的 MCP 支持 stdio 与 Streamable HTTP，工具可 direct、deferred 或 codemode 暴露。每次 MCP 工具调用经过工具管线；服务器给出的 `readOnlyHint` 等注解仍是服务器声明，不能代替聆记的域内授权。该版本不渲染 MCP Apps 资源。[MCP 接入文档](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/mcp.md)

独立 `pi-mcp` 可与 core 自行组合，提供客户端、传输与 OAuth 子集；其 README 声明支持的协议版本到 `2025-11-25`，不是自动支持所有后续 MCP 修订或 sampling、tasks 等全部能力。接入目标服务要实际协商验证，不因“支持 MCP”就推断兼容任意服务。首个会议助手验证无需启用 MCP/codemode。[pi-mcp 范围与限制](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/mcp/README.md)

## Web 与桌面都能做宿主，界面仍由聆记掌握

完整 SDK 面向 Node/Bun 进程；RPC 是子进程 stdin/stdout JSONL，不是可直接暴露给浏览器的 HTTP API。它支持流式事件、提示、停止、状态和扩展对话框转发；`prompt` 接受成功不代表任务结束，应区分会话事件和最终停止状态。普通子进程隔离也不自动限制文件与网络权限。[SDK](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/sdk.md)、[RPC 契约](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/rpc.md)

扩展可注册工具、命令、上下文钩子和 `ctx.ui` 交互，但其自定义组件主要面向终端 UI，不能直接当 React 面板使用；部分 TUI 能力在 RPC 下不可用或降级。浏览器优先方案应保留 React 界面，由后端运行 core，并用现有服务协议向前端转发受控事件；桌面以后可复用同样边界。不要为了接入 harness 先让用户安装 CLI。[扩展接口](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/extensions.md)、[模式与 UI 限制](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/cli-integration.md)

## 独立扩展中心可以保留，但不恢复 Skill 导出

建议界面用“会议助手/扩展”作为独立入口，允许选择“会议复盘”“质疑与风险”“内容问答”“知识提炼”。结果留在助手会话中，显示依据与范围；是否采纳进正式纪要另由用户操作。Markdown 与飞书导出始终走固定导出对话框，助手不持有外发工具。

Pi 的 package 可包含 skills、prompt templates、themes 和可执行 extensions；npm、git、本地来源均可安装，不能把 package 等同于纯提示模板。第一阶段只接入产品审核的说明型 Skill 与领域工具配置，不自动导入用户机器上的全部 Pi 插件；任意代码插件需要独立的隔离与供应链方案。[官方 package 格式](https://github.com/earendil-works/pi/blob/35dfa757378bd7a8570670e99c2687bdd1039a06/packages/coding-agent/docs/packages.md)

## 若继续，先用一个非生产验证回答是否值得引入

这是建议，尚未执行：在独立实验目录固定 `1.4.0` 与依赖锁，后端实例只注册三个选中会议只读工具；不加载全局 settings、目录技能、MCP、codemode 或第三方代码。用同一批脱敏会议对比“现有固定调用”和“core 工具循环”。

验证通过标准：引用能回到正确片段与修订；拒绝跨 Record、任意文件和 URL 请求；重复与取消不会回写纪要或继续后台运行；长上下文、错误恢复、并发会话隔离和总调用预算可控。比较回答质量、完整任务延迟、token/费用、开发与维护代价，再决定是否保留依赖。无需为第一轮验证同时引入完整 harness、pi-durable 或技能市场。

**证据限制。** 本轮确认了官方身份、固定源码、版本元数据、默认工具/会话与扩展/MCP 契约；没有验证包内制品一致性、浏览器构建、聆记 Node 运行时兼容、供应商链路、实际权限隔离、性能与纪要效果。现有项目文档只用于识别集成边界，没有据历史文档宣称当前运行环境已满足这些条件。[聆记当前状态文档](../engineering/current-state.md)

## 本地运行时核查补充

父代理于 2026-10-31 执行 `node -v`，当前交互终端为 **v22.14.0**，低于本报告核验的 Pi 1.4.0 包声明 Node ≥22.19。因此当前终端不能视为已满足 Pi 的声明运行条件；未来 spike 应使用隔离且满足要求的 Node 环境，不默认修改系统 Node、产品打包运行时或依赖。本轮未安装或启动 Pi。
