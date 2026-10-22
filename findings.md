2026-10-22：收尾流程错误地等待后台上传/刷新，且通用 busy 误标为接入声音；列表按更新时间排序并存在过期响应覆盖新会议的竞态；启动恢复对每场未变化的已结束会议仍执行数据库写入。均以实际函数或真实 SQLite 先红后绿验证。源码 9db4982，验证见 docs/evidence/meeting-lifecycle-startup-2026-10-22.md。完整 App 冷启动、真实设备与真实 ASR 未验证。

## 2026-10-21 Actions 发布事实

新增 preview workflow 的 source_sha 与标签硬比对；controller 与源码分别记SHA，不移动v0.1.0。发布器防止过期草稿快照改写已发布版本，6项契约和独立复核通过。329 Node、ESLint、docs101、官方actionlint通过。云端构建及发布尚未执行。Chrome文件URL权限未改变。

# 本轮发现

## 2026-10-21 首发与 ASR

- 用户确认 v0.1.0 源码＋macOS Apple Silicon 测试包。canonical 仓库 RoyalLiang/LingJi-MS 与原 lingji 为同一 repo（id 1416481402），当前远端为空，SSH dry-run 可推送。
- 独立审查修复：非中英二遍不附带全局背景；评估音频哈希必须字符串且归一小写，防跨组泄漏。
- 本轮 323 项 Node、21 项 Rust、lint/typecheck/Web 构建、100 份文档检查通过；合成 CLI 新建报告通过，已有报告 EEXIST 拒绝覆盖。没有人工金标准或真实供应商质量证明。
- 首发源码/历史定点凭据模式检查未发现匹配；不是完整安全审计。

- README 存在流式能力、供应商地址补全等过时描述。源码已有来源级持续识别、二遍、术语提示。
- 现有实验学习是文本候选选择，历史文档人工 gold=0；本轮不把旧损失下降作为识别准确率证明。
- 现有 CI 正式发行要求四平台、OS/updater 签名及 signed client-v 标签；本机测试包与该通道不同。
- SSH 已认证 RoyalLiang；匿名 API 限流，HTTPS push dry-run 缺凭据；远端 ls-remote 当前未列出分支/标签。

## 2026-10-21

- 已核实收尾并发 drain 提前返回、会中已生成纪要但未自动命名、媒体失败后不重新 load 三条路径，回归先红后绿。
- 用户已明确选 A；实现与导出验证见 docs/evidence/meeting-exports-2026-10-21.md。
- 2 分钟扩展以确认转录实施；未接直接音频理解。双音源及暂停时段分别导出，不混音。

- 源码已有封存音轨回放、Markdown API、终稿自动命名，但需要验证实际停止与 UI 入口。
- 原音重置通过 top:-48px 悬浮在播放右上方；本轮版式待用户确认。
- 当前 agent 消费确认转录；增量上下文只回看两个片段，超预算窗口以 24 段锚定。
- 不调用真实供应商或改写已有会议；先用隔离数据和本地夹具验证。

- 项目 Git 根目录已核实；起始没有项目 AGENTS.md。
- 当前工作区包含桌面壳、领域包、Go 引擎、网关及 API 的既有未提交改动。不可覆盖。
- 规则引导成功，CodeGraph 首次索引成功：68 个文件、1,034 个节点、3,071 条边。后续文档变更后再验证索引状态。
- 已存在 PRD、架构、90 天路线图、团队模型及桌面运行时迁移文档；需要分析一致性后建立新的阅读入口。
- deeppage.me 的 Web 文本抓取暂不可用；不能据此推断网站下线。
- 中央记忆未检索到本项目的相关条目，不依赖历史记忆事实。
- 当前实时传输由 HTTP 音频分块上传和 SSE 输出构成，不是旧架构中的 WebSocket。
- ai-worker 仅输出占位日志，尚未实现摘要任务消费或生成；Node translation component 有 mock 翻译路径。
- Go 引擎入口固定使用内存仓库和 mock provider，且默认端口 3010 与 Node 网关相同，不是已完成的生产替换。
- ASR 编排当前基于词数估计时间轴；SSE 没有持久事件游标；部分 final 事件先广播再持久化。这些需要纳入设计缺口。
- 用户确认 Web 优先，尽量免安装；任务跟踪使用 GitHub Issues，仓库待提供；单领域词汇表和默认标签已确认。
- DeepPage 的公开资料支持记录到知识/行动的产品理念与价格配额；没有用户规模、收入、转录延迟/准确率或摘要质量实测数据。CLI 文档入口为占位，平台按钮不能证明客户端交付。
- Node 测试在恢复缺失本地 workspace 链接、允许回环监听后 22/22 通过；Go 领域测试通过。Postgres 的 pg 已在 workspace 依赖声明，不能只看根 manifest 下结论。
- 完成屏障必须允许 seal 后补传声明范围内缺块；capture/input/transcription/minutes 状态、内容 revision、事件 cursor 与输入 sequence 分开。
