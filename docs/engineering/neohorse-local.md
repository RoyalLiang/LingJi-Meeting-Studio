# 在 wgs 调试 NeoHorse-Jev-4B

本轮由用户授权安装第三方开源 `TokenRhythm/NeoHorse-Jev-4B`。它不是 TypeSafe 官方 Jev；官方 Jev 当前仅提供托管 API。本文描述独立实验环境，不代表已经接入会议产品，也不代表中文会议意图质量通过验收。

## 安装位置和文件

- SSH：`wgs`，主机名 `westwell`。
- 目录：`/home/westwell/ai-labs/neohorse-jev-4b`。
- Python：上述目录内的 `.venv`，不修改系统 Python 或已有应用环境。
- 模型：`model/`；原始作者文件保留不改。
- 下载与安装日志、依赖锁定清单、推理报告：`evidence/`。
- 合成训练输出：`checkpoints/`，与原始 `pointer_head.safetensors` 分开。

代码副本在仓库的 `tools/neohorse/`。下载器使用作者 ModelScope 发布清单的逐文件 SHA-256；省略展示用 GIF，其余 70 个文件共 9,104,254,961 字节已下载并校验。保存的快照清单用于发现上游文件变动，不将移动的 `master` 当作固定版本。

## 当前验证状态

2026-10-12 在 wgs 实测，GPU 为 RTX 4060 Ti 8GB：

| 检查       | 结果                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 环境       | PyTorch 2.8.0+cu126、Transformers 5.17.0、bitsandbytes 0.50.2；CUDA 运算和 `pip check` 通过 |
| NF4 推理   | 346 个量化线性层；峰值分配显存 3424.7MiB，约 3.34GiB                                        |
| 合成推理   | 六条中英文样例的 Choice 均符合预期；Choice/Noul/Score 概率结构检查通过                      |
| 短输入耗时 | 首条 0.665 秒，其余约 0.124–0.125 秒；不包含模型加载，不代表长文本性能                      |
| 决策头训练 | 冻结骨干，1,311,232 参数，六条合成样例、20 步；损失从 0.0413717 降至 6.95387e-7             |
| 检查点     | 权重确实变化，保存后重载的缓存特征 logits 完全一致                                          |
| 新进程加载 | 训练检查点重新加载成功；六条合成 Choice 样例仍符合预期                                      |
| HTTP 调试  | `/health`、`/v1/decision`、`/v1/systemone` 通过；非法模型返回 400；仅监听回环地址           |

结果保存在仓库的 `docs/evidence/neohorse/`，服务器保留完整日志。六条样例不是正式评测集。否定外发样例虽然选中 `none`，其概率约 0.529，次高 `actions` 约 0.469，说明不能仅凭最高概率直接执行敏感操作。

原始骨干权重约 9.08GB。`quantized_runtime.py` 在加载时使用 bitsandbytes NF4 和双重量化，计算类型为 BF16；不覆盖原权重。量化可能改变概率分布，原模型及官方 Jev 的校准结论不能直接套用。

当前未安装可选的 `causal_conv1d` 和 `flash-linear-attention`，Transformers 使用 PyTorch 参考实现。上述短输入已跑通，长上下文和优化内核性能尚未验证。验收后已停止临时服务，安装环境和检查点保留，默认不持续占用 GPU。

## 重新下载或安装

从本仓库执行，脚本仅安装到指定实验目录：

```bash
ssh wgs 'mkdir -p /home/westwell/ai-labs/neohorse-jev-4b'
scp tools/neohorse/*.py tools/neohorse/*.sh tools/neohorse/intent_policy.json \
  wgs:/home/westwell/ai-labs/neohorse-jev-4b/
ssh wgs
cd /home/westwell/ai-labs/neohorse-jev-4b
python3 download_model.py --root "$PWD"
bash setup_env.sh "$PWD"
```

下载器会校验已有文件并跳过正确副本，支持断点续传。保留 `evidence/modelscope-files.json` 才会沿用本轮文件快照；删除该清单会重新获取作者当前分支，可能不是本轮版本。安装脚本固定已经验证的核心版本，完整环境版本保存在 `evidence/requirements.lock.txt`。PyTorch 使用官方 cu126 源，其他依赖使用国内镜像。

## 运行合成推理检查

当前适配器严格限制 `state` 为 1024 tokens、每个问题连同重复 state 的完整执行行为 2048 tokens、最多 8 个问题、展开后合计 8192 tokens。作者的 `max_branch` 是完整行预算，包含 state。超限会报错，不静默截断。决策头训练示例的 state 和完整行均限 256 tokens。长会议应先选择相关转录窗口；本轮未实现产品中的分窗和路由。

```bash
ssh wgs
cd /home/westwell/ai-labs/neohorse-jev-4b
.venv/bin/python smoke.py --model-dir model --output evidence/smoke.json
```

检查实际 4bit 层、CUDA 显存、Choice/Noul/Score 结果和概率结构。六条合成中英文样例包含否定和转述；命中数只用于说明这些样例的表现，不是中文会议准确率。

## 验证决策头训练

```bash
.venv/bin/python train_head.py --model-dir model \
  --output-dir checkpoints/synthetic-head --steps 20
```

此命令冻结量化骨干，缓存六条合成样例的特征，只训练约 131 万参数的 pointer head。它检查损失下降、权重变化和保存后重载一致性。该过程不训练整个 4B 骨干，不是 LoRA，也不证明领域质量提升。合成检查点仅用于验证训练机制，不作为正式推理默认值。

自己的 JSONL 数据每行包含 `request` 和正确选项键 `target`，每个请求只包含一个 Choice 问题。例如：

<!-- prettier-ignore -->
```jsonl
{"request":{"state":"请生成会议纪要。","questions":{"intent":{"type":"choice","instructions":"用户现在是否明确要求生成会议纪要？","criteria":{"summarize":"明确要求现在生成纪要","none":"否定、转述、假设或没有请求"}}}},"target":"summarize"}
```

```bash
.venv/bin/python train_head.py --model-dir model --dataset dataset.jsonl \
  --output-dir checkpoints/my-head --steps 20
```

调试自己训练的头时，显式指定检查点；省略该参数会使用作者原始决策头：

```bash
.venv/bin/python serve.py --model-dir model \
  --head-checkpoint checkpoints/my-head/synthetic-pointer-head.safetensors \
  --port 18081
```

训练样例保留在本机。应另划分独立评测集；不能用训练损失代替效果验收。当前工具限制为最多 1000 条、100 步，超出时明确拒绝。

## 验证 LoRA 训练

已在同一台 RTX 4060 Ti 8GB 上验证 NF4 骨干加 LoRA：只训练文本注意力的 `q_proj`、`v_proj`，原骨干和原决策头冻结。使用 PEFT 0.21.2、rank 4、batch size 1、非重入梯度检查点；当前工具限制 state 为 128 tokens、完整执行行为 256 tokens。它使用原模型的决策 logits 计算分类损失，不是文本生成 SFT。

| 检查         | 实测结果                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- |
| LoRA 范围    | 16 个投影，458,752 个可训练参数；32 个 LoRA 张量发生变化，梯度非零，原决策头未变化                |
| 短样例       | 六条合成样例，最长 45 tokens，6 步；损失 0.0414926 → 0.0312019                                    |
| 长度边界样例 | 两条合成样例，完整行 252 tokens，2 步；损失 0.0266024 → 0.0208352                                 |
| 显存         | 两组峰值分配均为 5588.3MiB，约 5.46GiB；最大 PyTorch 预留显存 5670MiB；不含其他进程和部分驱动开销 |
| 保存及重载   | 适配器约 1.84MB；两组均在新进程重载，适配器权重相同，logits 与概率差为 0                          |
| 回归         | 原始模型六条结果与安装时完全相同；原有决策头训练仍通过                                            |
| HTTP         | 显式加载 LoRA 后，健康检查、两种决策接口、非法模型拒绝和回环监听检查均通过；临时服务已停止        |

在 wgs 安装目录执行，安装可选训练依赖并运行短样例验证：

```bash
cd /home/westwell/ai-labs/neohorse-jev-4b
bash setup_lora.sh "$PWD"
.venv/bin/python train_lora.py --model-dir model \
  --output-dir checkpoints/lora-smoke --steps 6 --rank 4
.venv/bin/python train_lora.py --model-dir model \
  --output-dir checkpoints/lora-smoke --verify-only
.venv/bin/python smoke.py --model-dir model \
  --lora-adapter checkpoints/lora-smoke/adapter --output evidence/lora-smoke.json
```

自己的 JSONL 数据格式与决策头训练相同，当前支持每条一个 Choice 问题，默认最多 64 条，可用 `--max-examples` 显式扩大到 2048 条；训练和 `--verify-only` 都需要传入相同的 `--dataset dataset.jsonl`。校验器核对数据哈希、适配器权重和输出数值，配置容差为 logits 0.05、概率 0.002；本轮两组实测差值为 0。脚本允许 rank 1–8、1–2000 步；本轮 Alpha 另验证了 rank 4、100 步及适配器继承。`--balance-families` 轮换任务更新，`--resume-adapter` 继承权重并核对一致性，不恢复优化器状态。实际双任务样本、标注与回测边界见 [Alpha 学习说明](alpha-learning.md)。

启动使用 LoRA 的本机服务时显式指定目录：

```bash
.venv/bin/python serve.py --model-dir model \
  --lora-adapter checkpoints/lora-smoke/adapter --port 18081
```

省略 `--lora-adapter` 会使用原模型。LoRA 推理沿用训练时的 k-bit 准备和 BF16 autocast，决策头保持 FP32 运算，因此显存高于普通 NF4 推理。PEFT 作为可选依赖，原来的核心版本未变。实现依据见 [PEFT 量化训练文档](https://huggingface.co/docs/peft/developer_guides/quantization)；本轮证据保存在 `docs/evidence/neohorse/lora/`。

这些检查只证明所测配置可以训练、保存和加载。LoRA 的四分类 smoke 仍为 6/6，但否定外发样例的 `none` 概率约 0.514、`actions` 约 0.485，间距比原模型更小。训练损失下降不能证明真实会议效果改善；合成适配器不作为默认权重。长上下文、更大 batch、全部线性层 LoRA 和全参数训练尚未验证。

## 启动本机调试服务

```bash
.venv/bin/python serve.py --model-dir model --port 18081
```

该工具只绑定 `127.0.0.1`，单请求处理。它提供 `/health`、`/v1/decision` 和 `/v1/systemone`；System One 响应沿用作者适配器，不能据此声称与官方 Jev 模型等价。调试服务不是生产网关，不自动注册后台服务。

另开一个终端：

```bash
curl --fail http://127.0.0.1:18081/health
curl --fail http://127.0.0.1:18081/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"NeoHorse-Jev-4B","state":"请整理会议纪要。","questions":{"summarize":{"type":"noul","instructions":"用户是否明确要求生成会议纪要？"}}}'
```

从 Mac 访问时建立 SSH 隧道，无需开放服务器端口：

```bash
ssh -N -L 18081:127.0.0.1:18081 wgs
```

退出服务会释放模型占用的显存。CUDA 不可用或显存不足时工具报错，不静默转 CPU 或模拟输出。

## 从项目生成训练数据

已提供离线预标、逐条审核文件导入、分组隔离与 JSONL 导出工具。它复用会议 JSON 备份和五类讨论语义，输出可追溯来源；默认不把规则结果当作真值。使用步骤、离线教师格式与真实验证边界见[项目意图数据集说明](intent-dataset.md)。

当前数据工具使用 v2 窗口预处理；`intent_inputs.py` 与 `prepare_intents.py` 已同步到实验目录，数据生成和单焦点请求准备共用同一逻辑。旧标签需重新审核；上文 LoRA 结果属于 v1 历史验证，不自动证明 v2 下的质量。本轮修复没有训练新适配器，也没有启动推理服务。

## 来源和边界

- [作者模型与许可证](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B)：Apache-2.0；原运行时的 LICENSE/NOTICE 随模型保留。
- [作者部署说明](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B/blob/main/DEPLOYMENT.md)。
- [作者 ModelScope 发布](https://www.modelscope.cn/models/TokenRhythm/NeoHorse-Jev-4B)。
- [TypeSafe 企业 FAQ](https://typesafe.ai/enterprise)：官方 Jev 当前仅提供托管 API。

当前实验不上传真实会议、不修改现有 ASR/LLM 配置，不执行会议中的外发指令。真实中文质量、量化校准、长上下文、全参数骨干训练和产品集成都需要单独验证。
