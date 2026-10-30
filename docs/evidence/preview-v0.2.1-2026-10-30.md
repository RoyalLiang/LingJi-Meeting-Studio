# v0.2.1 发布核验回执

核验日期：2026-10-30。桌面版及官网已发布，真实 GitHub 登录通过。生产分享服务的公开读取、过期和撤销已通过自动检查；浏览器完整上传、预览、确认与撤销流程仍待 Chrome 扩展文件访问权限，不能视为完整 GUI 验收。

## 固定源码与后台工作流

- 产品标签：`v0.2.1`，提交 `9254089c132d62d762829fd14946908c13cffa2b`。
- [桌面发布 Actions 41010543665](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41010543665)：verify、macOS、Windows、Linux、publish 五项成功。
- [公开 Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.2.1) 包含三平台安装包及公开版本清单。
- 官网生产源码：`0613e9487f136969c44ddf64d1b507453c2f4197`。该提交只修正 Pages 的生产回执读取字段及对应测试，`apps/`、`packages/`、`services/` 与 `v0.2.1` 完全一致，未修改既有标签。
- [官网 Actions 41023708675](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41023708675)：成功。用户批准浏览器触发现有 Actions 的例外；源码构建、迁移、上传、部署均由 Actions 执行，没有手工上传产物。

## 三平台附件核验

实际完整下载每个文件，核对字节数及 SHA-256，并与公开版本清单一致。[逐文件校验记录](assets/beta-live-20261030/release-artifact-checks.json)。下载校验通过不等于本机安装或实体设备验收。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [macOS Apple Silicon DMG](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.1/Lingji-0.2.1-macos-arm64.dmg) | 218595625 | `dcb3a690716f42847bee257ae4881ca22fe4dcccae10efba79d4bd199af8e83c` |
| [Windows x64 安装器](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.1/Lingji-0.2.1-windows-x64-setup.exe) | 407397007 | `705ad2864b5e9c95fa95992302d84b7bed6e749471d3d227a7112ddd48532b4f` |
| [Linux amd64 DEB](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.2.1/Lingji-0.2.1-linux-amd64.deb) | 221815468 | `ddbc20e6c1007767cf879a59a83543e2df976e07995ea6c3772714f7f582a17c` |

## 正式官网、身份与分享

- [官网](https://rookiecode.com)、[发布入口](https://rookiecode.com/publish)、[虚构示例纪要](https://rookiecode.com/example) 可访问。示例页用于展示阅读效果，不是真实会议公开。
- Cloudflare 自定义域显示活动、SSL 已启用。根域从原 A 记录替换为 `lingji-meeting-studio-beta.pages.dev` 的代理 CNAME；变更前后各 10 条记录，其余 9 条逐字段一致，包含 api、mail、MX、TXT。DNS 原始备份留在本地受忽略运行目录，不将账户验证记录复制进公共仓库。
- 生产部署 ID：`dfb1cabe-aee7-44e0-b674-b6679bca6212`。后台回执确认源 SHA、发布身份配置和真实 D1 的读取、过期及撤销测试均通过；合成检查仅操作其专属测试记录。
- Chrome 已完成真实 GitHub OAuth：授权页只显示 Public data，回调返回已登录发布入口。仅允许 RoyalLiang 和不可变 ID `26199801`，未请求仓库或邮箱权限。
- 无 Cookie 的独立 HTTPS 请求验证：官网 200、服务配置 200/`publishing: true`，发布和管理 API 401，无效分享 404 且 `no-store`。携带伪造 `Cf-Access-Jwt-Assertion` 仍被拒绝。
- 快照存放在 D1，单个文件最多 1 MiB；默认 24 小时有效，可提前撤销。未开通 R2、Cloudflare Access 或付费计划。

证据：[Cloudflare 原始公开回执](assets/beta-live-20261030/cloudflare-production-verification.json)、[域名与匿名 HTTP 检查](assets/beta-live-20261030/live-verification.json)、[正式官网截图](assets/beta-live-20261030/site-desktop.png)、[真实登录后发布入口](assets/beta-live-20261030/publisher-authenticated.png)。

## 本地验证与剩余验收

735 项完整 Node 回归、24 项分享/官网专项、lint、类型检查、Web/Pages 构建通过；回执字段修正后专项及 lint 重跑通过，固定提交的两轴复审无剩余阻塞。本回执加入后 255 份 Markdown 的链接与代码围栏检查通过，git diff --check 通过。

- Chrome 扩展目前未允许访问文件网址，工具无法将虚构会议文件填入选择框。真实登录已验，但 GUI 文件选择、完整预览、确认发布、打开动态链接及在门户撤销的整条路径尚未现场执行。不能用后台 D1 合成检查替代这一缺口。
- 尚无真实会议金标集、长会话或真实供应商准确率/时延实测。词表提供场景提示与需人工确认的同音候选；SenseVoice 首次识别不注入热词，不能宣称已证明 ASR 准确率提升。
- 本轮未在用户实体设备安装这三个公开附件；也未验证原生浏览器音频采集、Postgres/S3 或全部历史代码。CI、摘要一致和本地测试各自只证明其覆盖范围。
- 首次 Pages 创建 API 多次返回 500；本次由控制台建立空项目和所有权标记后，Actions 成功部署。全新账户的全自动首次创建仍未验证，首次错误的 Cloudflare 内部原因未确认。
- 分享撤销阻止后续访问并移除当前库中的正文，无法收回读者已保存的副本；删除本机会议不会自动撤销线上链接。

历史失败的 `v0.2.0` 标签与工作流保留。`v0.2.1` 首次 Pages 重跑曾在已部署之后因读取错误的回执字段失败；修复后的成功工作流与上述生产部署为最终官网证据，不将旧失败覆盖为成功。
