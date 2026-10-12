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
scp tools/neohorse/*.py tools/neohorse/setup_env.sh \
  wgs:/home/westwell/ai-labs/neohorse-jev-4b/
ssh wgs
cd /home/westwell/ai-labs/neohorse-jev-4b
python3 download_model.py --root "$PWD"
bash setup_env.sh "$PWD"
```

下载器会校验已有文件并跳过正确副本，支持断点续传。保留 `evidence/modelscope-files.json` 才会沿用本轮文件快照；删除该清单会重新获取作者当前分支，可能不是本轮版本。安装脚本固定已经验证的核心版本，完整环境版本保存在 `evidence/requirements.lock.txt`。PyTorch 使用官方 cu126 源，其他依赖使用国内镜像。

## 运行合成推理检查

当前适配器严格限制 `state` 为 1024 tokens、单问题分支为 2048 tokens、最多 8 个问题、展开后合计 8192 tokens。超限会报错，不静默截断。训练示例使用更短的 256-token state/branch 限制。长会议应先选择相关转录窗口；本轮未实现产品中的分窗和路由。

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

## 来源和边界

- [作者模型与许可证](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B)：Apache-2.0；原运行时的 LICENSE/NOTICE 随模型保留。
- [作者部署说明](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B/blob/main/DEPLOYMENT.md)。
- [作者 ModelScope 发布](https://www.modelscope.cn/models/TokenRhythm/NeoHorse-Jev-4B)。
- [TypeSafe 企业 FAQ](https://typesafe.ai/enterprise)：官方 Jev 当前仅提供托管 API。

当前实验不上传真实会议、不修改现有 ASR/LLM 配置，不执行会议中的外发指令。真实中文质量、量化校准、长上下文、骨干微调和产品集成都需要单独验证。
