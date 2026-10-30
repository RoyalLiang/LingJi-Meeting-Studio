# Beta 官网与在线纪要

官网由 Cloudflare Pages 的高级模式 Worker 托管。D1 在同一事务中保存发布身份、令牌摘要、范围、到期时间、幂等请求和白名单内容快照。用户指定暂不开通 R2，本版不请求 R2 服务或账单权限。录音、模型密钥和本机工作台不随官网部署。部署入口是后台 [Cloudflare Pages 工作流](../../.github/workflows/cloudflare-pages.yml)，目标为 `rookiecode.com`，实际可用状态以部署回执为准。用户明确授权替换根域旧站；既有 api、mail、MX 与 TXT 记录保持。

## 发布一份纪要

1. 在桌面版打开“分享会议”。原有 HTML 导出和既有 Web 分享仍仅包含纪要正文。
2. 在“发布为在线纪要”中核对范围。默认“仅纪要及引用原文”；只有明确改选“纪要与全部转录”才加入其他转录。原音始终排除。
3. 导出 `.lingji.json`。在浏览器打开发布页，使用受邀的云端身份登录，选择文件并核对完整预览。桌面版可复制发布页地址，网页工作台可直接打开。
4. 勾选发布确认后生成 `/share/<令牌>`。链接 24 小时有效，接收者用浏览器阅读，无需登录或安装。保存自己的链接；服务端仅存令牌摘要，列表不能恢复原始 URL。
5. 在同一发布身份下管理、撤销链接。更新内容需重新发布。后台生成、人工修改不会改变已经发布的快照。

删除本机会议与撤销云端快照是两个操作。首版采用手动撤销，没有桌面 OAuth 回调或离线撤销队列。删除本机会议前，应先在发布页撤销。撤销只能阻止后续读取，不能收回接收者保存的副本。已打开页面在重新可见或每分钟检查状态，已知失效时清除正文；网络失败会显示状态无法确认。

## 维护者配置

仓库 Actions Secrets 保存 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。令牌只用于所选账户，需 Pages 编辑、D1 编辑权限；不要放入客户端、仓库文件或聊天。用户账户令牌若需账户读取，应按 Cloudflare 实际权限提示补齐最小范围。

自动部署使用独立资源：Pages `lingji-meeting-studio-beta`，D1 `lingji-meeting-studio-beta-shares`。脚本校验项目所有权标记，拒绝替换其他项目；先建立私有存储、应用迁移，再部署。仓库中的全零 D1 ID 只供模板与本地运行，CI 生成实际配置。源码部署通过 Actions；正式域名在 Pages 构建验收后绑定。修改根域路由前保留旧记录；不修改邮件、api 及其他子域配置。

发布身份使用 Cloudflare Access。创建 Self-hosted 应用，保护正式 `rookiecode.com` 主机的 `/publish*` 和 `/api/publish*`，后者也覆盖 `/api/published*`。使用同一应用 AUD，并将 Allow 策略限制为明确的受邀邮箱；不要使用 Everyone。`/`、`/example`、`/share/*` 和 `/api/shared/*` 保持公开。Worker 自行验证 RS256 签名、issuer、AUD、subject、到期时间，边缘路径配置遗漏不能跳过后端验证。

将 Team 域名（如 `team.cloudflareaccess.com`）写入仓库变量 `CLOUDFLARE_ACCESS_TEAM_DOMAIN`，应用 AUD 写入 `CLOUDFLARE_ACCESS_AUD`，重新运行工作流。缺少身份配置时官网和示例可以发布，上传接口返回 503；缺少有效 JWT 返回 401。不能把静态官网上线描述为会议发布可用。预览别名没有单独的邀请策略，不作为受支持的发布入口。

工作流每次版本标签触发，也可在 main 手工重跑。每日清理任务删除过期超过一天的 D1 快照行。撤销在同一 SQL 更新中设置不可读状态并清空当前正文，避免跨存储部分成功。清理策略不等于精确物理擦除期限；数据库 Time Travel 等恢复副本受 Cloudflare 保留机制约束。

## 边界与恢复

- 上传请求最多 1 MiB、每个发布身份最多 100 个有效链接。正文按固定 schema 检查引用版本，未知字段不进入快照。HTML 由受信模板生成，禁止直接上传任意 HTML。
- 浏览器生成随机 256 位只读令牌与请求 UUID，重试沿用同一请求、令牌和内容摘要。D1 用单条带配额条件的 INSERT 原子提交正文和元数据；写入结果不确定时读回确认，未确认则返回可重试错误，不删除可能已经提交的快照。
- 公开读取使用令牌摘要索引；到期、撤销在读取正文前检查。私人正文 `no-store`，设置 CSP、`no-referrer` 和 `noindex`，API 错误不落入静态页面回退。无效令牌预算有内存上限，按 isolate 近似限流；它不等于全局 WAF 配额。
- 发布使用 Access 身份，与本机账户分别管理。同一邮箱也不自动合并两端身份。撤销发布者访问权限后，维护者仍需按事件需要处理其已发布链接。
- 紧急关闭写入时先撤销 Access 应用访问；不要绕过 Worker 访问检查。数据库和部署版本分别备份与回退；退回静态前端不会撤销已经发出的链接。

官方依据：[Pages 高级模式](https://developers.cloudflare.com/pages/functions/advanced-mode/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Pages Access 注意事项](https://developers.cloudflare.com/pages/platform/known-issues/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。本地测试与部署回执应分别核对。
