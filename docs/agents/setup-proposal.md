# 工程技能配置草案

2026-10-11。GitHub Issues、统一领域目录与默认标签已由用户确认；仓库地址待提供。本文件保留已确认草案的记录，正式约定见同目录配置文件与根 AGENTS.md。

建议目前维持一个会议产品领域词汇表。虽然代码采用多包布局，但这些包尚未形成独立业务域；目录数量不等于领域数量。

## 待写入 AGENTS.md 的区块

```markdown
## Agent skills

### Issue tracker

任务使用 GitHub Issues；仓库地址待用户提供，未绑定前不执行远程工单操作。见 docs/agents/issue-tracker.md。

### Triage labels

采用 needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。见 docs/agents/triage-labels.md。

### Domain docs

单一词汇表 CONTEXT.md；架构决策放在 docs/adr/，新决策初始标为 proposed。见 docs/agents/domain.md。
```

## 配置文件草案

- `docs/agents/issue-tracker.md`：GitHub Issues。远程仓库未配置；必须取得明确仓库地址后再绑定。工单操作使用 `gh`，多行正文使用临时文件与 `--body-file`。PR 不作为需求入口。
- `docs/agents/triage-labels.md`：五个角色使用上述同名标签，仅记录约定，不创建远程标签。
- `docs/agents/domain.md`：先读根目录 `CONTEXT.md` 和相关 `docs/adr/`；词汇表只定义业务概念；设计建议与已实现事实分开。未来出现独立业务域时再引入 `CONTEXT-MAP.md`。

已按用户确认写入正式配置；未修改已初始化的通用路由模板。
