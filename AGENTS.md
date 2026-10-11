# Project Codex instructions

## Project working agreements

- 本项目使用 Git 管理。每个可验证的改造阶段完成后提交一次，提交说明包含目的与验证结果。保留未完成阶段的工作进度，不将它描述为已交付。
- 本轮引入的 bug 修复使用 `git commit --amend --no-edit` 合并到本轮最近的本地未推送提交；需要改变提交意图时更新说明。先核对提交归属和远程状态；不改写用户原有提交、已共享或已推送历史，不自动 force push。若没有可安全 amend 的本轮提交，先形成独立的本轮改造提交作为基线。
- 提交显式列出的本轮文件；IDE 配置及无关用户改动不纳入。未配置远程时仅提交本地，不推送。

- 产品方向以浏览器优先、尽量免安装为首版约束。先读 `docs/README.md`，核实 `docs/engineering/current-state.md`，再读与任务对应的设计。
- 当前事实、设计建议、验收目标与线上证据必须分别标注。历史文档不能直接作为已实现事实。
- 保留既有未提交代码、IDE 配置和实验目录。不要顺手提交、回滚或重新格式化无关文件。
- 查找源码先使用项目 CodeGraph；索引无结果时才回到 `rg` 和定点读取。索引只提供导航，不证明运行正确。
- 会话协议修改必须核对音频标识、重传幂等、持久化确认、转录修订、补历史游标和停止排空语义。
- AI 纪要与行动候选需要引用转录版本和片段；人工编辑不能被后台重生成覆盖。外发行动需要单独授权。
- 不把浏览器屏幕共享授权、录音告知、原音留存、云端识别和分享权限视为同一个同意。
- Provider 的 mock 仅用于明确的开发和测试配置；真实录制失败不能静默变成模拟结果。
- 现有 Node 检查运行 `npm test`；Go 实验检查在 `services/engine-go` 运行 `go test ./...`。`lint` 与 `typecheck` 在接入真实工具前不能作为质量证据。
- 浏览器原生采集、Postgres、真实 ASR/LLM、长会话与部署验证必须单独报告，不能由 mock 测试代替。
- 可维护的实现实践见 `docs/engineering/practices.md`；新架构建议先落 proposed ADR，不默认视为用户已批准实现。

## Agent skills

### Issue tracker

任务使用 GitHub Issues；仓库地址待用户提供，未绑定前不执行远程工单操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

采用 needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。见 `docs/agents/triage-labels.md`。

### Domain docs

单一词汇表 `CONTEXT.md`；架构决策放在 `docs/adr/`，新决策初始标为 proposed。见 `docs/agents/domain.md`。

Cold start:

1. Read `./.agents/boot.yaml`.
2. Read `./.agent-runtime/state-lite.json` when present.
3. Read `./.agents/route-presets.jsonl`.
4. Classify the task and load only the smallest matching preset.
5. Upgrade context only when a trigger in `boot.yaml` requires it.

Project rules override global defaults for project-specific behavior. Keep global rules project-neutral.

The lifecycle hook writes one compact `inferred` checkpoint per completed turn. When the hook is unavailable, write the checkpoint before final delivery. Do not duplicate the automatic record; use a manual checkpoint only to structure or promote durable project facts:

`python3 ~/.agents/rules/codex-agent-rules/scripts/memory_checkpoint.py --project <project-root> --summary <summary>`

Promote decision-affecting facts to `confirmed` only after explicit confirmation or current verification.

Keep active context to goal, phase, constraints, findings, touched files, validation, and next action.

## Pre-delivery reflection gate

For every user task, at the first point when you would otherwise send the final completion response:

1. Pause before final delivery; do not call the task finally complete yet.
2. Perform an agent self-review and answer these two questions yourself:
   - `眼下你最没有把握的事情是什么？`
   - `关于当前情况，最大的遗漏是什么，我没有意识到什么？`
3. Do not redirect either question to the user or ask the user to answer it. For the first answer, identify the agent's weakest-confidence point and why. For the second, identify the largest likely omission or blind spot that the user may not have noticed, including its impact. Ground both answers in current evidence, label hypotheses explicitly, and say so plainly if no material item is found.
4. Present both questions with the agent's answers, then wait for the user's response before final delivery.
5. Treat the user's response as part of the current task. Investigate, revise, or validate any material uncertainty or omission that remains within scope, then deliver the final result.
6. Trigger this gate once per user task. Do not trigger it for intermediate progress, approval requests, blockers, or clarification-only turns, and do not repeat it after incorporating the user's response. If the user explicitly skips the gate, proceed to final delivery.
