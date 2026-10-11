# 在 GitHub Issues 跟踪工作

用户已于 2026-10-11 选择 GitHub Issues；具体仓库待提供，当前 Git 没有 remote。不要猜测 owner/repo，也不要创建远程标签或工单。

绑定后使用 `gh`，显式核实仓库与请求范围。读取、创建、更新、关闭工单均遵循当前任务授权；多行正文写入临时文件并用 `--body-file`，避免 shell 插值。

每个可实施任务写清：用户结果、范围、依赖、验收、证据和回滚边界。标签使用 [triage 约定](triage-labels.md)。PRs request surface: no；PR 不作为需求入口。

本轮的设计路线图是规划文档，不等于已经发布的 GitHub 工单。
