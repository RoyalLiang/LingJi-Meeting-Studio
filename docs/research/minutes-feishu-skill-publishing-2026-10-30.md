# 纪要飞书导入与 skill 引导发布：可行性研究

研究开始：2026-10-30；最后核验：2026-10-31（Asia/Shanghai）。状态：**proposed，供方案评审**。本轮只有研究与本地交互预览，没有创建飞书文档、安装第三方 skill、连接真实 MCP 或外发纪要。

产品归属已按用户于 2026-10-31 的修正统一：**画板是云文档内的组件，不是独立发布分类**。以下画板 API 指文档组件对应的资源操作。产品入口为“导入飞书云文档”，由用户选择是否插入纪要树画板。

## 两条路线都可行，先做确定性的飞书导入

| 能力 | 可行性 | 建议实现 |
| --- | --- | --- |
| 纪要导入飞书云文档 | 高，官方有创建文档与 Markdown/HTML 转块接口 | 产品内置导入器，保留标题、层级、决策、行动候选与引用 |
| 纪要树作为云文档内的画板组件 | 高，官方支持创建文档中的画板块及原生思维导图节点 | 新建文档内画板，或写入已有文档内的可编辑画板组件；优先原生右树布局 |
| 安装 skill 后引导发布 | 可行，但需要聆记实现 skill 宿主与执行权限 | 安装 → 选范围 → 生成草稿 → 预览目的地与内容 → 用户确认 → 执行并留回执 |
| skill 通过 MCP 发布 | 可行，依赖实际暴露的工具与授权 | 浏览器版由后端连接受支持的远程 MCP；本地 stdio 需要桌面或本地桥接 |

这是接口与产品设计层面的结论，**不是飞书租户联调验收**。下文区分官方事实与建议设计。预览页面展示的是模拟状态，不是飞书真实渲染或实际发布结果。

## 飞书云文档可通过现有公开接口导入

**官方事实。** 飞书支持将 Markdown/HTML 转为文本、标题、列表、引用、待办、代码、图片和表格等文档块。官方推荐先创建 docx、转换内容，再创建嵌套块；表格 `merge_info` 是只读字段，写入前需移除，图片还有单独素材上传步骤。[Markdown/HTML 转换接口](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document/convert)

建议调用顺序：

1. `POST /open-apis/docx/v1/documents` 创建标题和目标文件夹中的文档。
2. `POST /open-apis/docx/v1/documents/blocks/convert` 转换经用户确认的纪要快照。
3. `POST /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}/descendant` 插入转换后的嵌套块。
4. 读取远端结果，保存文档 ID、URL、内容摘要和导入回执。

创建嵌套块的实际路径为单数 `descendant`；不要把普通 `children` 接口用于一次提交任意深度的块树。[创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)、[创建嵌套块](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-descendant/create)

**建议设计。** 默认导入当前人工确认后的纪要，正文含摘要、议题、决策、行动候选、未决问题。引用显示片段与转录版本；只有聆记链接在收件人环境可访问、且权限明确时，才放可点击溯源链接。不能把本机 `localhost` 链接当成可分享证据。原音、完整转录和学习笔记分别选择，不随纪要默认外发。

## 飞书画板可以保留原生思维树结构

**官方事实。** docx 支持矩阵明确列出画板块可创建、可读取。画板概述说明文档 `block_type=43` 的 `block.token` 是 `whiteboard_id`。因此可以先在新文档内创建画板，再写节点；也可向已有云文档内的画板组件写节点。[文档支持矩阵](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/docx-overview)、[画板概述](https://open.feishu.cn/document/docs/board-v1/overview)

官方画板数据结构已支持可写的 `mind_map_root` 和 `mind_map_node`，其中旧 `mind_map` 属性已标为只读。根布局包含 `tree_right`、`tree_left`、`tree_balance`、`left_right` 和 `up_down`，子节点有父节点、顺序、方向和折叠属性。原生树是首选；普通形状和连线仅作为明确标注的兼容回退。[画板数据结构](https://open.feishu.cn/document/docs/board-v1/data-structure)、[官方 Go SDK 类型](https://pkg.go.dev/github.com/larksuite/oapi-sdk-go/v3/service/board/v1)

建议调用顺序：

1. 新建 docx，或选定已存在且有编辑权限的画板。
2. 新建场景下，调用文档 `children` 接口写入画板块，读取返回的画板 token。
3. `POST /open-apis/board/v1/whiteboards/{whiteboard_id}/nodes` 写入根和子节点，用原生 `parent_id` 表达纪要层级。
4. `GET /open-apis/board/v1/whiteboards/{whiteboard_id}/nodes` 回读确认节点与结构，再显示完成回执。

创建节点接口支持批量和父子关系，支持应用或用户身份、自建或商店应用；当前文档限制为每批 1–3000 个节点、每秒 50 次请求。批次大小和重试策略应以实际返回为准，不把上限当作稳定吞吐保证。[创建画板节点](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/board-v1/whiteboard-node/create)

**建议预览。** 会议主题为根，议题为一级节点，结论与行动候选为二级节点。负责人、期限和引用放在适当叶节点或同一云文档正文内，避免一条长纪要挤进一个图形。产品只设“飞书云文档”发布分类，以组件选项决定是否在正文中插入纪要树画板，实际渲染、文本换行、折叠和大树性能仍需真实租户验证。

“画板思维树”和飞书“思维笔记”是不同产品对象。本方案承诺的是画板中的原生树，不据此承诺可以创建独立思维笔记文件。[画板思维导图说明](https://www.feishu.cn/hc/zh-CN/articles/728977871585-%E5%9C%A8%E7%94%BB%E6%9D%BF%E4%B8%AD%E6%8F%92%E5%85%A5%E6%80%9D%E7%BB%B4%E5%AF%BC%E5%9B%BE)

## 一键导入需要先完成应用授权

**官方事实。** 飞书用户授权入口为 `GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`，当前 v3 换码接口为 `POST https://accounts.feishu.cn/oauth/v3/token`。用户授权的 scope 需要先在应用后台申请；用户还必须在应用使用范围内。refresh token 需要离线访问授权。拥有 API scope 与拥有目标文件夹或文档的资源权限是两回事。[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[获取 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)、[云文档权限问题](https://open.feishu.cn/document/server-docs/docs/permission/faq)

**建议设计。** 首次使用完成连接，此后才是一键导入。以个人名义创建时优先用户 OAuth；团队后台任务才考虑应用身份，并明确所有者与可见范围。内部自建应用先做企业试点，面向多个企业分发另需核对商店应用的安装、审核与租户隔离要求。没有租户配置时不能把“授权后一定可用”写成事实。

首版按功能申请“创建及编辑新版文档”“创建画板节点”等必要权限；读目录、读回结果和后续更新另列用途，不申请整个企业通讯录或消息发送。实际 scope key 应从应用后台与对应 API 文档生成清单并联调，不复制未核实的第三方权限列表。

浏览器版由后端换码、刷新和加密存储凭据，前端只保留连接状态。App Secret、访问令牌和刷新令牌不得进入 `VITE_*`、页面、skill 正文、模型上下文、截图或发布回执。OAuth 回调校验 `state`，限定回调地址和租户。

**待核实的文档不一致。** 授权码页仍写 PKCE 仅配合 v2，v3 token 页已出现 `code_verifier` 与公共客户端条件。不能据此断言 v3 不支持或已完整支持所有 PKCE 场景。若后续选择无需后端机密的桌面/公共客户端路线，应单独实测。当前后端托管方案不依赖这个未决点。

## skill 负责流程，MCP 或直连 API 负责实际动作

**官方事实。** Agent Skills 的核心是带有 YAML 元信息的 `SKILL.md` 目录，允许可选脚本、参考材料和模板；它不等于已安装的可执行插件，也不自带 OAuth 或发布权限。宿主需要发现、解析、选择并加载技能；没有直接文件访问的运行环境可提供专门的激活工具。[Agent Skills 规范](https://agentskills.io/specification)、[宿主集成指南](https://agentskills.io/client-implementation/adding-skills-support)

MCP 把能力暴露成工具，技能可以说明如何使用这些工具。MCP 允许产品自行设计交互，但建议显示工具、调用状态和人的否决机会。[MCP 工具规范，2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

**建议的首版安装范围。** 支持上传包含 `SKILL.md` 的 ZIP 或目录；仓库地址导入固定到提交版本。安装界面展示来源、版本/摘要、可读内容、所需连接和工具。说明与模板可以运行；涉及任意 shell、浏览器自动化或外部脚本时显示“不兼容当前浏览器运行环境”，保留停用/卸载入口。安装不是对未来所有发布动作的同意。

以下是聆记自己的产品约束，**不是 Agent Skills 标准新增字段**：按用户或工作区隔离安装记录；记录包摘要；拒绝 ZIP 路径穿越、越界软链接、超量解压和名称冲突；首版只执行产品白名单中的工具，不因技能正文写了“已授权”而提升权限。引导面板应同时显示技能兼容性与连接状态，避免“安装成功”掩盖“无法发布”。

## 飞书官方 MCP 可复用，但不能把它当作完整写入器

官方 `@larksuiteoapi/lark-mcp` 是 Beta，可通过 `-t` 选择工具或预设。其 README 当前仍提示直接编辑云文档不支持、支持导入和读取，非预设 API 未充分做兼容性测试。因此接入前必须实际调用 `tools/list` 并对照输入 schema，不根据工具名字或 OpenAPI 存在就宣称该 MCP 已支持完整导入和更新。[飞书官方 MCP](https://github.com/larksuite/lark-openapi-mcp/blob/main/README.md)

建议把内置“导入飞书”继续做成确定性 API 适配器。通用“按技能发布”可调用受支持 MCP，也可复用同一适配器，复用草稿、授权和回执逻辑，不让模型自行拼接不受控 HTTP 请求。MCP 协议版本和 SDK 版本应分别固定并做兼容性验证；不把旧版传输示例当作当前所有服务的契约。[官方 MCP SDK 协议与版本说明](https://github.com/modelcontextprotocol/go-sdk/blob/main/docs/protocol.md)

浏览器不能直接启动任意本地 stdio 进程。远程 MCP 通过后端或适配的 HTTP 客户端连接；本地 stdio 需要桌面宿主/本地桥接。MCP 自身的访问令牌与飞书下游访问令牌分别管理，不把一个服务的 token 直接当成另一个服务的 bearer token。远程 OAuth 发现、URL 和请求均需校验，避免任意内网地址访问。[MCP 传输概念](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[MCP token 边界](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

## 发布前固定内容与目的地，发布后保存可核对回执

建议最小流程：

1. 选择技能，例如“会议纪要发布到飞书”；显示安装来源、连接、可用工具及运行兼容性。
2. 选择纪要范围与版本，生成发布草稿；保留原文证据，不回写覆盖人工纪要。
3. 同屏预览正文/树、目标租户与目录、文档标题、可见范围和是否附带引用。目标目录权限不明时显示“待核对”，不能假装私有。
4. 用户确认本次内容和目的地后，执行该计划；临时更换目的地、增加附件、扩大分享或发送群消息都使确认失效。
5. 只在远端回读成功后显示完成，提供目标链接和部分成功/失败情况。创建文档、创建画板、发送消息分别记动作，不把文档已创建等同于已通知所有人。

这些是建议的服务端执行约束，不能只写进 skill 提示词：

- 发布计划绑定 `recordId + minutesRevision + transcriptRevision + selectedScope + destination + contentHash`；引用保留片段 ID 与版本。快照改变后重新预览。
- 执行记录保存幂等键、远端 ID、阶段和校验结果。文档 `children` API 有 `client_token` 与 `document_revision_id`；仅在接口明确支持的地方使用，不假设创建文档或所有画板 API 都有同等幂等保证。[创建块](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-children/create)
- 创建请求超时后，先核对是否已产生远端资源；无法确认时显示“结果待核对”，不盲目重建。限流退避，权限不足停止并引导连接修复。
- 首版默认新建导出快照。后续“更新上次发布”必须比对远端版本/内容，保留人工编辑；不自动覆盖全文或清空已有画板。
- 纪要与转录是输入资料，其中的命令不能替代宿主授权。技能和 MCP 的工具描述也是不可信输入；执行白名单、目标范围和确认绑定由宿主决定。

## 首次联调需要验证这些结果

建议用一个试点租户和脱敏样例验证，不需要先建设技能市场：

1. OAuth 首次连接、失效刷新、撤销、拒绝与错误租户处理；核对应用范围和文档资源权限。
2. 新建云文档并保留中文标题、列表、待办、引用与长内容分批；确认最终目录和实际可见范围。
3. 新建文档内画板及向已有画板追加原生树；验证层级、换行、折叠、排序与大树性能。
4. 双击发布、超时、部分成功和限流恢复，不产生静默重复；更新时不覆盖远端人工编辑。
5. 导入普通说明型 skill，以及包含不支持脚本的 skill；连接缺工具的 MCP 时明确说明缺口。
6. 未确认、确认后改内容或改目标、恶意 skill 请求扩大权限时，服务端阻止实际外发。

本轮没有验证真实租户权限、飞书原生渲染、第三方技能质量、实际模型调用成本或发布成功率。预览中的会议、账号、目录、连接与回执均为演示数据。

## 2026-10-31 产品交互确认

用户要求统一导出入口，只有导出时选择 Markdown、飞书、自定义；自定义依赖程序内置 Skill 能力与技能管理，并以流式聊天完成内容整理、草稿检查和确认导出。此前“分步表单作为主流程”的示意已由[完整流式流程预览](../design/minutes-publishing-preview-2026-10-30.md)替代。画板仍属于飞书云文档内的组件。以上为用户明确约束；真实模型、宿主、流式恢复及工具执行尚未实现。
