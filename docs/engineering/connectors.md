# 飞书与 Git 的统一连接器协议

已有飞书和 Git 设置、预览及任务页面继续使用原有入口。后端新增 `lingji.connector.v1` 分派，复用现有任务内核和外部写入日志；协议不会赋予只读 MCP 插件写入权限，也没有新增平台或自动发送行为。

## 先读取连接器能力

已登录用户可请求 `GET /api/connectors`，读取连接器标识、协议版本、支持操作及恢复方式。飞书标识为 `feishu`，Git 为 `git`。描述不包含凭据。

`POST /api/connectors/:id/preview` 接受：

```json
{"protocolVersion":1,"input":{"recordId":"会议 UUID"}}
```

飞书可在 `input.options` 传入原有导出预览选项，随后使用返回的导出 ID。Git 预览当前配置的映射；也可以省略 recordId 查看当前目录映射。

## 提交后保留返回的 taskId

`POST /api/connectors/:id/tasks` 接受：

```json
{"protocolVersion":1,"requestId":"调用方唯一请求 ID","confirmed":true,"input":{"recordId":"会议 UUID"}}
```

上例用于 Git。飞书的 input 使用 `{"exportId":"预览返回的导出 ID"}`。来源由适配器解析，调用方不能伪造 sourceIds，也不能用 automatic 字段代替确认。

同一用户、requestId 和意图绑定同一任务；改变来源或内容会冲突。响应中的 taskId 是任务内核标识，task 保留平台回执。使用 URL 编码后的 taskId 请求：

- `GET /api/connectors/:id/tasks/:taskId` 查看状态。
- `POST .../:taskId/cancel` 取消，正文为 `{"protocolVersion":1}`。
- Git 支持 pause、resume、retry、respond，正文带 protocolVersion、confirmed 和原操作所需的 input。

Git 恢复时如果来源或模型已改变，可能创建替代任务。调用方必须跟随本次响应的新 taskId。取消只停止后续步骤，不能撤销已经发生的远端提交或文档创建。

## 按各平台规则恢复不确定写入

飞书保持冻结预览、目标、连接代际和内容范围。创建响应丢失时保留 unknown，部分发布保留 partial；不提供统一 retry 来重新创建文档。Git 继续核对规则、来源、模型、仓库和分支，并通过内容与 MR 对账恢复。

增加连接器时，在现有任务内核注册来源校验、提交、查询和取消适配器，再向 createConnectorRegistry 注册版本描述、预览、来源解析和明确支持的控制操作。外部写入必须继续使用既有认领与 externalWrite 对账，不新建绕过授权和幂等的执行器。未知连接器、版本、操作及连接器与任务错配在调用远端前拒绝。
