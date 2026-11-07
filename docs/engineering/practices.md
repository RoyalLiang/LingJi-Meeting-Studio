# 实现与验收实践

入口见 [运行手册](runbook.md)，事实见 [current-state.md](current-state.md)。

1. 从领域命令开始。Record、Session、Source、转录、纪要任务和分享各有状态与所有权。前端不能自行宣布云端保存或排空完成。
2. `packages/records` 定义纯领域规则；`services/records` 负责鉴权、事务、对象与供应商；React 使用类型化模型和领域组件。
3. 先写不可变对象，再提交元数据/事件。对象存在而事务失败可成为孤儿，反过来不可接受。SDK mock 不能证明 S3 实际持久性。
4. record/session/source/epoch/sequence 定位音频；哈希、偏移、采样数参与冲突校验。seal 后允许范围内补传，HTTP 完成不是 ASR 完成。
5. 转录版本、纪要版本、SSE 游标不同。先取一致快照，再从 cursor 续订；过期明确 reset。
6. 纪要引用固定版本。人工编辑使用预期版本，旧模型结果隔离；行动始终是候选，外发独立授权。
7. 按到期索引、租约与 fence 领取任务，限制并发、重试、输入预算；空闲记录不持续写盘。临时、孤儿与墓碑分别清理。
8. 录音、共享、云识别、原音留存与分享不是同一个同意。密钥仅后端，不静默 fallback 到 mock。
9. 复用 UI 原语和领域组件；长文本提高底色不透明度。检查浅深主题、窄屏、焦点、Tab/Escape、减少动态/透明度和文字状态。
10. 每阶段提交；bug amend 本轮最近未推送提交，核对归属与远程状态，保留 IDE 改动，无远程地址不推送。

```bash
npm test
npm run lint
npm run typecheck
npm run build:web
npm run test:records:postgres
```

`npm test` 覆盖旧原型和新领域/HTTP/worker/存储故障测试。lint 是新增 Node 服务和脚本的 ESLint，typecheck 是新 Web 的 TypeScript；不再是 echo 占位，也不代表历史代码全量静态检查。

PG 检查需要 `RECORD_TEST_DATABASE_URL` 指向名称含 test 的专用数据库，缺失时明确跳过。Go 实验在 `services/engine-go` 运行 `go test ./...`，不代表新主链使用 Go。

查源码先 CodeGraph：`codegraph sync .` 更新，`codegraph explore -p . "commitMinutes"` 查询。索引不证明运行正确。

证据分层：源码、领域测试、HTTP/SQLite、适配器 fixture、真实浏览器输入、真实供应商、专用 PG/S3、试点与部署。只报告实际完成的层次，见 [阶段验收](acceptance.md)。
