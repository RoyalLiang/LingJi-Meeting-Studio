# 维护内置 Skill 的输出契约

会议复盘和会中纪要的内置 Skill 各自声明输出结构、合成样例和期望属性。只有当前说明、schema、样例及校验回执的摘要一致，且全部样例通过校验，这一版 Skill 才能用于新请求。缺失、失败或过期的回执会阻止启用。

## 按需要生成风险表或 ADR 草稿

会议复盘仍返回摘要、决策和行动候选。明确要求“风险登记表”或“ADR 草稿”时，还会返回对应的结构化草稿，并排版到整理结果中。

- 风险登记表包含风险、影响、可能性、应对建议、负责人和来源引用。未提供概率用 `unknown`，未知负责人为 `null`。
- ADR 草稿包含背景、备选方案、建议、影响和待确认项。讨论未支持优先推荐时，保留“暂无优先推荐、待评审”。
- 两类文档的状态均为 `draft`。提议不成为已批准决定；明确取消本身可以作为决定，被撤回的原计划不再作为有效决定。

所有结构化条目的引用都要匹配本次冻结会议的片段和修订。输出草稿不会授权外部任务、仓库写入或文档发送。

## 更新后先执行样例，再生成启用回执

内置文件位于 `services/records/src/data/skills/meeting-review` 和 `minutes-runtime`。每包包含 `SKILL.md`、`output-schema.json`、`examples-input.json`、`examples-expect.json` 和 `evaluation.json`。

先让评估器按当前 Skill 和 schema 执行原始样例，保存实际输出。候选文件包含每包的 `{caseId, output}` 数组，以及顶层 `sourceDigests`；摘要记录评估时的说明、schema 和输入版本，UTF-8 内容按 LF 换行计算 SHA-256。旧输出的源摘要不能用于更新后的 Skill。

运行校验：

```sh
node scripts/evaluate-builtin-skills.mjs /path/to/candidate-results.json
```

全部通过后，生成回执：

```sh
node scripts/evaluate-builtin-skills.mjs /path/to/candidate-results.json --write
npm run test:skills
```

候选文件的顶层键是 `meeting-review`、`minutes-runtime` 和 `sourceDigests`。后者按 Skill ID 保存 `instructions`、`schema`、`inputs` 三项源摘要。校验器还会检查当前期望属性和冻结引用，拒绝猜测负责人、把 ADR 标成已批准或丢失必需备选方案。

CI 会重新核对已提交回执；运行时也会检查源摘要。会中纪要在一条分窗流水线开始时冻结已验证的 Skill，窗口缓存键包含该版摘要，各窗口和引用修正共用同一快照。

样例检查覆盖结构、来源和已声明的期望属性。实际配置模型的语义质量、长会议覆盖度、延迟及费用仍需单独评估。
