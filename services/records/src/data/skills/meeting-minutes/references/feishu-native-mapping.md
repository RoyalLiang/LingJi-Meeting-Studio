# 飞书应用身份导出

本地 HTML、Markdown 和画板 JSON 无需凭据；仅在用户要求远程导出时使用本参考。

## 必需配置

使用飞书企业自建应用，启用机器人能力，申请所调用 API 的云文档创建 / 编辑、画板节点写权限，并发布应用版本。具体 scope 以开放平台实际接口权限要求为准。

必需凭据为同一应用的 **App ID** 和 **App Secret**。推荐由用户在运行环境注入 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；已有安全配置直接复用。App ID 也可通过 `--app-id` 提供。密钥不应写入聊天或命令历史，脚本不接受明文密钥参数；其它密钥环境变量可用 `--app-secret-env` 指定，也可用 `--app-secret-file` 指向技能目录以外的受保护 UTF-8 文件。

群自定义机器人 webhook、个人 access token 和浏览器登录态不适用。写入已有文档、画板或文件夹时，除了应用 API 权限，还需要资源对该应用身份可编辑。应用创建的文档是否对用户可见取决于文件夹继承和协作者权限；本脚本不自动增加协作者或扩大分享范围。

## 身份与 token

脚本将 `app_id`、`app_secret` POST 到 `/open-apis/auth/v3/tenant_access_token/internal`，读取 `tenant_access_token` 和 `expire`，在内存保留 token 并于到期前刷新。鉴权请求不带 Bearer 头；文档和画板请求使用应用租户 token。

缺少凭据在远程请求前失败。`FEISHU_ACCESS_TOKEN` 不被读取，旧 `--token` 参数明确报错。HTTP 成功仍需业务 `code == 0`；错误不会降级为用户身份。429 有界退避；网络异常和 5xx 写入不会自动重放，避免重复创建。当前只支持飞书自建应用。

## 命令

```bash
# 从技能目录执行；凭据已经安全注入
python3 scripts/feishu_board_drawer.py minutes.json --create-docx
python3 scripts/feishu_board_drawer.py minutes.json --create-docx --folder-token FOLDER_TOKEN
python3 scripts/feishu_board_drawer.py minutes.json --doc-id DOCUMENT_ID
python3 scripts/feishu_board_drawer.py minutes.json --board-id WHITEBOARD_ID
```

三个目标参数互斥。`--folder-token` 仅适用于新建文档；现有目标是追加，重复运行可能重复内容。

云文档使用二级标题、高亮块（`block_type=19`）、摘要文本和嵌入画板（`block_type=43`）；画板 token 从创建块响应的 `board.token` 读取。文档块每次创建不超过 50 个。一个图形的全部节点在同一次创建请求中上传，避免跨批引用临时节点 ID；官方单次最多 3000 节点，超限需先拆分会议或卡片。

## 原生数据契约

| 类型 | 官方写入字段 |
| --- | --- |
| 文字 | `text.text`、`text.font_weight`、`text.vertical_align="mid"` |
| 边框 | `style.border_width` 为 `extra_narrow` 等字符串；无边框用 `border_style="none"` |
| 连线 | `connector.start` / `connector.end` 中的 `attached_object.id`、`snap_to`、相对坐标；`arrow_style` 控制箭头 |
| 图形 | `composite_shape.type` 和位置、宽高；内部 `_wrapped_lines` 不上传 |

`--mode nodes` 保留测量后的原生布局；`--mode mermaid` 调用 `/nodes/plantuml`，由飞书重新排版，不能保证相同样式。

## 失败与结果

打印 `[INFO] Bot export target document: ...` 后失败，目标中可能已有部分内容。先检查该文档和画板，再决定补齐或重试；不要循环新建文档。不打印完整响应、token 或密钥请求体。交付目标 ID，并明确说明本地验证与实际租户导出分别完成到哪里。

## 官方参考

核对日期：2026-11-06。

- [自建应用获取 tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
- [画板概述](https://open.feishu.cn/document/docs/board-v1/overview)
- [创建节点](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/board-v1/whiteboard-node/create)
- [节点数据结构](https://open.feishu.cn/document/docs/board-v1/data-structure)
- [文字颜色与主题色表](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/board-v1/theme-introduction)

无脚本执行环境时交付 Markdown 和生成命令，不声称已经远程发布。
