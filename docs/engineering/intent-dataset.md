# 从会议 JSON 备份生成意图训练数据

离线工具位于 `tools/neohorse/build_dataset.py`，已安装到 wgs 的 `/home/westwell/ai-labs/neohorse-jev-4b`。它读取显式选择的 Record JSON 备份，生成预标、审核文件、审计和兼容 NeoHorse 的 JSONL。它不调用在线模型、不读取业务数据库，也不执行会议中的行动。

本轮实现的数据边界记录在 [proposed ADR 0009](../adr/0009-offline-intent-training-data.md)。这是训练数据工具，不包含产品内逐条审核界面、实际教师模型或大规模训练器。

2026-10-13 起输出使用 `neohorse-intent-dataset-v2`，预处理版本为 `intent-window-local-v2`。旧数据版本和训练报告保留；已填写的旧审核／教师标签会被新生成器拒绝，需按新输入重新审核。已有 LoRA 检查点使用旧预处理验证，不能自动视为与 v2 兼容或质量达标。

## 先生成预标与审核文件

从工作台导出 JSON 备份；现有接口是 `GET /api/records/:id/export?format=json`。支持单条 Record、Record 数组或 `{records: [...]}`，不支持旧 transcript-api 的 replay 格式。选择允许用于训练的记录，将文件放到自己的输入目录。

创建 `allowed-records.json`，把示例 ID 替换为备份中确实允许训练的 Record ID：

```json
{ "purpose": "intent-training", "recordIds": ["approved-record-id"] }
```

这个文件是操作者对训练范围的声明，不是身份或授权认证系统。`analysisConsent` 不会被当作训练许可。已删除或已过保留期的记录会被跳过；未选择记录的正文不会写入输出。代码只使用已持久化的 `segments`，不使用识别草稿、笔记或音频对象。

在 wgs 执行：

```bash
cd /home/westwell/ai-labs/neohorse-jev-4b
.venv/bin/python build_dataset.py --input inputs/meeting.json \
  --allowed-records allowed-records.json --tokenizer model/tokenizer \
  --output datasets/intent-v1-prelabel --train-limit 64
```

输入文件上限 20MiB，合计上限 100MiB；最多 200 个不同 Record、10000 个选中片段。输出必须是新目录，已有版本不会被覆盖。目录权限为 0700，输出文件为 0600。

首次预标通常只有候选和审核队列，`train.jsonl` 为空是预期行为：规则命中和历史模型候选都不会默认成为训练真值。

生成的数据集是独立副本，源记录后续删除或过期不会自动清理这些版本。应按审计中的 Record ID 管理数据副本的留存；本工具没有实现自动清理或模型遗忘。

## 审核标签后导出新版本

编辑 `intent-v1-prelabel/review.jsonl`。每行已经带有当前发言、前文、问题、来源、`sample_id` 和 `input_hash`。保留这些字段，仅填写：

- `label`：`present`、`absent` 或 `skip`；保持 `null` 表示未审核。
- `reviewer`：审核者的本地标识，填写标签时必需。
- `note`：可选的判定说明。

随后生成新目录，沿用首次输出的分组：

```bash
.venv/bin/python build_dataset.py --input inputs/meeting.json \
  --allowed-records allowed-records.json --tokenizer model/tokenizer \
  --split-map datasets/intent-v1-prelabel/split-map.json \
  --reviews datasets/intent-v1-prelabel/review.jsonl \
  --output datasets/intent-v1-reviewed --train-limit 64
```

标签绑定输入哈希和片段版本；更改正文、修订、上下文或标注策略后，旧标签会被拒绝，需重新审核。`gold` 表示导入了明确审核标签，工具不会认证审核者身份，也不能证明标签语义一定正确。

每个焦点发言生成五个独立的二选一问题：决定、行动候选、提议、问题、否定／撤回。同一句可以同时标记“决定”和“行动”。行动候选不代表承诺、人工确认或外发授权。未命中规则、历史模型未提及、教师弃标，都不会自动变成负例。

导出行可直接被现有 `train_lora.py --dataset` 读取。例如：

<!-- prettier-ignore -->
```jsonl
{"sample_id":"synthetic-example","request":{"state":"[当前发言][S1]我来跟进接口文档。","questions":{"action":{"type":"choice","instructions":"当前发言是否包含明确的待办、责任分工或跟进事项？只识别行动候选，不代表承诺或执行授权。","criteria":{"present":"存在该类讨论意图","absent":"不存在该类讨论意图"}}}},"target":"present"}
```

来源、审核者、规则与教师版本保存在审计中，不进入模型 request。sample_id 是外层关联键，现有训练器只消费 request 和 target。

## 导入离线教师标签

可以将 `candidates.jsonl` 交给已批准的本地教师流程。生成器不附带教师模型，也不读取 `.env` 或发起 HTTP 请求。教师每行结果需要：

- 从候选原样复制 `sample_id`、`input_hash`。
- `label` 为 `present`、`absent` 或 `abstain`。
- 非空 `model`、`prompt_version`、`run_id`。
- `evidence` 使用候选来源中的 `{segmentId, revision}`；非弃标结果必须引用焦点片段。

导入时传 `--teacher-labels teacher.jsonl`。默认仍只导出审核标签；加 `--accept-silver` 才会把“规则与非 NeoHorse 教师一致的正例”导入训练集，标为 silver。教师声明的模型身份不能由本工具认证，一致也不证明正确。历史 `insights.method=model` 只作弱信号，不满足独立教师条件。

冲突进入审核队列，人工标签可覆盖冲突。教师负例不会自动入库，验证／测试集始终要求明确审核标签。规则或两个近似模型可能一起犯错，应以人工校准样本评估预标误差；这是[弱监督](https://snorkelproject.org/get-started/)，不是自动产生真实标签。

## 检查数据隔离与输入预算

默认使用固定 seed 按 Record 分组为约 80%/10%/10%；同一 Record 的 Session 和窗口不能跨组。精确重复会议及较长重复窗口会合组；同样的模型 request 在输出中去重，冲突标签全部隔离。近似改写和同一项目的相似会议尚未做语义去重，可通过 `--split-map` 将相关记录手工放入同组。重复内容被指定到不同组时明确报错。分组评测依据见 [scikit-learn 分组交叉验证](https://scikit-learn.org/stable/modules/cross_validation.html#cross-validation-iterators-for-grouped-data)。

窗口默认取最多两个已结束的前文片段，加当前发言；不会包含后续发言或会后纪要。它使用备份的最新修订，不能重建当时的在线 ASR 输入或历史修改轨迹。正式在线评测还需独立留存当时的版本化输入。

使用已安装的 native 编码器与本地 tokenizer 校验：state 最多 128 tokens，包含 state 的完整问题行最多 256 tokens。超限时逐条移除较早上下文；焦点本身仍超限则进入 `rejected.jsonl`，不截断焦点。输出记录 tokenizer 文件指纹与 native runtime 版本。

工具匿名化已知说话人显示名，并替换常见邮箱、中国手机号和 URL；可用 `--redact-map replacements.json` 提供额外的字面替换。它不识别所有人名、合同内容、商业秘密或国际电话号码。审核者应检查剩余内容以及上下文裁减是否影响标签。

输出文件：

| 文件                      | 用途                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `train.jsonl`             | 审核标签；显式允许时可含 silver 正例                       |
| `dev.jsonl`、`test.jsonl` | 仅审核标签，分别用于调参与最终评测                         |
| `candidates.jsonl`        | 全部可编码窗口、弱信号及处理状态                           |
| `review.jsonl`            | 未解决或冲突样本的可编辑审核模板                           |
| `audit.jsonl`             | 来源版本、输入哈希、分组、标注来源及是否导出               |
| `rejected.jsonl`          | 焦点超预算样本及原因                                       |
| `manifest.json`           | 数据版本、计数、标签覆盖、输入／策略／tokenizer 指纹与限制 |
| `split-map.json`          | 固定 Record 分组，后续版本应复用                           |

`--train-limit 64` 优先保留 gold，再按稳定哈希抽取，未导出行仍保留审计；它不是类别均衡采样。不设上限可生成更大的数据集，但当前 LoRA 验证器会拒绝超过 64 条的输入。训练集应补足负例与少数类，不能只训练自动接受的正例。

## 验证训练与独立测试集

下列命令只做接线验证，6 步不等于完整训练一轮：

```bash
.venv/bin/python train_lora.py --model-dir model \
  --dataset datasets/intent-v1-reviewed/train.jsonl \
  --output-dir checkpoints/my-intent --steps 6 --rank 4
.venv/bin/python train_lora.py --model-dir model \
  --dataset datasets/intent-v1-reviewed/train.jsonl \
  --output-dir checkpoints/my-intent --verify-only
.venv/bin/python evaluate_dataset.py --model-dir model \
  --dataset datasets/intent-v1-reviewed/test.jsonl --output evidence/base-test.json
.venv/bin/python evaluate_dataset.py --model-dir model \
  --dataset datasets/intent-v1-reviewed/test.jsonl \
  --lora-adapter checkpoints/my-intent/adapter --output evidence/lora-test.json
```

评测器报告各任务的 TP/TN/FP/FN、准确率、精确率、召回率和 F1；没有对应分母时返回 null。它只对传入标签计分，不验证这些标签是否属于独立人工测试集。应使用 build_dataset 输出的分组和审计核实来源；不要用 test 选择提示或超参数。正式训练仍需独立补齐按轮次打乱、验证集选择、最佳检查点与恢复训练。

## 训练与推理使用同一输入

`intent_inputs.py` 同时为数据生成器和单焦点请求准备入口构造输入。先选择最多两个已结束前文和焦点，再在这个窗口内生成临时说话人别名和邮箱／电话／URL 占位符；上下文超限被移除后重新构造。后续姓名、尚未结束的重叠发言和不在窗口中的实体不会影响当前请求。固定的 `--redact-map` 在两个入口中必须一致。

`S1` 只在当前窗口内表示同一个声音标签，跨窗口可能对应不同说话人；这不会修改 Record 内的说话人身份。姓名脱敏仍不完整：不在窗口说话人标签或固定替换表中的姓名不一定被识别，应审核后再使用。

为未来推理适配器准备请求时，传入一份已确认的单条 Record 快照及焦点片段 ID：

```bash
.venv/bin/python prepare_intents.py --input inputs/confirmed-record.json \
  --focus-id segment-id --tokenizer model/tokenizer \
  --output evidence/prepared-focus-v2.json
```

输出 `window.requests` 中的五个请求与生成器同一焦点的 `request` 一致；`window.rejected_tasks` 列出超限任务，调用方应弃判。工具只准备请求，不调用模型、不写业务记录。正式 worker 尚未接入这一入口。

manifest 保存上下文条数、脱敏配置哈希、预算、预处理版本、提示策略及 tokenizer 指纹。候选中的 `model_input_hash` 只绑定实际模型 request；审核用 `input_hash` 还绑定来源版本和预处理配置。在既有片段、顺序和时间范围不变时，追加后续片段或修改其正文／姓名不会改变早期模型输入；当前或前文修订则应重新准备。原始 ASR 的迟到、修订和实际可见快照必须另存，完整会后备份仍不能重建历史实时请求。

## 本轮验证记录

2026-10-13（v2）：本机 28 项完整性测试通过。wgs 使用实际 tokenizer 完成 230 组整场／逐段／回归／CLI 对照，请求、token 数、输入哈希及引用一致。新预标默认训练数为 0，合成标签重新生成后 train/dev/test 为 30/10/10；旧审核标签被拒绝。新产物为 `datasets/intent-window-v2-prelabel-20261013` 和 `datasets/intent-window-v2-reviewed-20261013`。本轮未训练、未调用推理引擎，也未接入产品 worker；证据为 `docs/evidence/intent-dataset/preprocessing-v2-*.json`。

2026-10-12（v1 历史验证）：本机 19 项完整性测试通过；规则优先级用实际 Node `ruleIntents` 对照。合成备份由项目 `exportRecord` 真实函数生成。wgs 使用实际 NeoHorse tokenizer 输出 50 个预标问题，默认训练行数 0；导入合成测试标签后生成 train 30、dev 10、test 10。

生成的训练文件完成真实 LoRA 6 步更新，训练损失 0.503908 → 0.469369；新进程重载权重一致，概率差为 0。最长训练执行行 92 tokens，峰值分配显存 5588.3MiB。独立合成测试集 10 条：原模型 70%，LoRA 后仍为 70%，没有观察到准确率提升。这些数据使用合成标签规范，不是真实会议的人工金标准，也不足以估计模型质量。

现成服务器产物：`datasets/intent-prelabel-v2`、`datasets/intent-gold-v3`、`checkpoints/dataset-smoke/adapter`。`dataset_fixture_reviews.py` 只支持仓库中命名的 synthetic 记录，是测试辅助工具，不应用于真实会议。原模型与默认调试服务未替换。

教师导入分支另用 8 条合成教师记录验证：显式接收后只有 4 条一致正例进入训练集，1 条冲突留待审核，验证／测试集均为 0；没有把弱标签混入评测集。

本轮没有读取真实会议、调用实际教师或提交数据到在线服务。验证汇总保存在 `docs/evidence/intent-dataset/`。
