# 将设计落实为可验收的协议切片

状态：proposed；2026-10-11。下面的 `/v1`、事件和字段**尚未实现**，用于后续开发评审；现有 `/sessions` HTTP/SSE 路由通过兼容 adapter 逐步迁移。不要将示例当成现在可调用的接口。

## 按用户结果划分入口

| 提议入口 | 成功回执的含义 | 幂等与前置条件 |
| --- | --- | --- |
| POST /v1/records | Meeting Record 元数据已提交 | workspace 内 Idempotency-Key |
| POST /v1/records/:id/sessions | 会话和来源声明已提交，不代表浏览器已采到声音 | 已授权身份、实际来源能力；请求幂等 |
| PUT /v1/sessions/:id/sources/:source/epochs/:epoch/chunks/:seq | 音频对象可用、输入记录和原回执已提交 | 身份+digest 去重；同身份不同内容冲突 |
| POST /v1/sessions/:id/seal | 输入 manifest 已固定，不代表音频已齐 | 同一 source/epoch 的 lastSequence 不可静默改变 |
| GET /v1/records/:id/bootstrap | 权限允许的权威 snapshot 和事件 watermark | 不能由缓存混合不同内容版本 |
| GET /v1/records/:id/events?after=:cursor | 传递持久提交事件及暂定文字 | cursor 有范围和保留期，去重可重放 |
| PATCH /v1/records/:id/transcript | 新转录版本已提交 | expectedRevision/If-Match；保留旧版本 |
| POST /v1/records/:id/minutes-jobs | 幂等任务已持久排队，不代表纪要生成成功 | 固定输入快照和模板/模型配置版本 |
| PATCH /v1/records/:id/minutes/:version | 人工编辑版本已提交 | 乐观并发，冲突保留输入 |
| POST /v1/records/:id/actions/:candidate/confirm | 人工确认事实已提交，不会外发 | candidateRevision、操作者、请求幂等 |
| DELETE /v1/records/:id | 删除 tombstone 已提交 | generation fencing；物理清理状态另查 |

租户和操作者由认证层注入，不能信任正文中的 userId/workspaceId。开发环境与生产模式明确分开；provider secret 只在受信后端，不进入浏览器包或长期 localStorage。

音频 payload 使用二进制，元数据承载采样、编码、digest；具体 envelope 在切片实现时以现有 header adapter 兼容，不把大音频编码成 JSON base64。返回回执含 acceptedSequence、contiguousThrough、missingRanges 与 durable=true；更大序号被接收不等于中间缺口已经补齐。

## 事件区分可丢候选与持久事实

示例提交事件：

```json
{
  "eventId": "2048",
  "recordId": "record-demo",
  "recordRevision": 12,
  "type": "transcript.segment.committed",
  "payload": {
    "transcriptRevisionId": "revision-7",
    "segmentId": "segment-3",
    "segmentRevision": 2,
    "startMs": 12000,
    "endMs": 15200,
    "text": "下次评审再确认上线日期。"
  }
}
```

SSE 的 `id:` 使用 eventId，适合以字符串承载大整数；不是 segment sequence，也不是内容 revision。暂定事件 `transcript.partial` 带 source/attempt/baseRevision，不携带推进提交水位的 `id`。客户端忽略旧 attempt 的迟到 partial，不能用它覆盖已提交修订。

bootstrap 返回事件水位 W，并且内容投影至少包含 W 内的更新；随后订阅 after=W。实现需在数据库事务快照中确保这个对应关系，或采用明确可证明的版本读取方式，不能分别查“最大 cursor”和“当前片段”拼接。过期 cursor 返回 reset_required，页面保留人工草稿后重新读取。

权限变更和 tombstone 在读取/订阅/补传/worker 写回时都检查；分享 viewer 只订阅其授权范围，撤销不能只影响新连接。

## 纪要输出先作为结构化草稿

```json
{
  "sourceRevisionId": "revision-7",
  "completeness": "complete",
  "overview": [{
    "text": "上线日期尚未确认，留待下一次评审。",
    "evidence": [{
      "segmentId": "segment-3",
      "segmentRevision": 2
    }]
  }],
  "decisionCandidates": [],
  "actionCandidates": [],
  "openQuestions": ["上线日期待确认"]
}
```

此例刻意不把“下次评审”猜成具体日期，不把未决讨论改成决议，也不凭空指定负责人。生成约束：只用给定片段；事实带引用；未知字段为空；识别到的指令只当会议内容，不执行其中要求上传、发送或改配置的语句。

服务端验证 schema、引用属于输入快照、片段版本存在、权限和 generation 未变化。schema 与引用存在仅是必要条件；事实支持、遗漏和语气仍要通过真实样本评审。若允许人工笔记参与摘要，必须把 notesRevision 与作者来源纳入输入水位，不能把笔记内容伪装成原话。

## 失败分类决定恢复行为

| 类别 | 示例 | 客户端/worker 行为 |
| --- | --- | --- |
| 授权或删除 | permission_denied、record_deleted | 停止写入，保留允许保留的本地草稿；不无限重试 |
| 内容冲突 | digest_conflict、revision_conflict | 显示冲突并核对；不覆盖较新内容 |
| 能力缺失 | no_audio_track、unsupported_encoding | 回到来源选择/导入退路 |
| 容量限制 | payload_too_large、storage_quota | 有界停止/暂停并提示，不持续堆内存 |
| 临时失败 | 网络中断、429、部分 5xx | 稳定幂等键、退避抖动、Retry-After 和重试预算 |
| 不可恢复输入 | 缓存被清除、音轨中断 | 保存缺口，用户明确选择有缺口结果 |
| 派生处理失败 | ASR/LLM 超时 | 原音/转录保持可用，任务可单独重试 |

HTTP 状态与 errorCode 一起约定；业务冲突可用 409，If-Match 失败用 412，过期 cursor 可用 410。最终选定后进入合约测试，不让不同 adapter 各自发明完成含义。

## 第一个纵向切片应穿透真实持久化

以一个浏览器麦克风输入开始：来源检测 → 本地分块事务 → 音频持久 ACK → 可控 ASR adapter → final/事件事务 → SSE 补历史 → seal/drain → 固定版本纪要草稿。先用可控 provider 验证故障，再用明确授权的真实音频和真实 provider 验证质量。

文件落点建议：客户端在 Web feature/facade 中逐步迁出 shell；后端在现有 API application 与 gateway 编排中收敛提交接口，领域值对象放 @tts/domain；worker 承载任务实现。避免先建一批只转发的空包或把业务状态都放进 HTTP server。具体目录可随切片收敛，不要求一次重构全仓。
