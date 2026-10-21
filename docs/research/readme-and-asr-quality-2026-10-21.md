# README 与转录准确率调研（2026-10-21）

本报告为本轮 README 和 ASR 改造提供一手资料依据。**官方文档事实、仓库文档证据和实施建议分别标注**；没有调用真实语音供应商、读取密钥或核听用户录音。下面的参数能力不等于本项目已接入，改造效果必须另行验证。

调研日期为 2026-10-21。开源项目 README 使用当日 `main` 页面，属于可变化的参考资料；供应商能力也应以实际开通的资源、接口和当次文档为准。

## README 应帮助读者完成首次使用

GitHub 官方说明，README 通常回答项目做什么、为什么有用、如何开始、在哪里求助，以及谁在维护；仓库根目录 README 可直接展示，仓库内导航宜使用相对链接。[GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

以下只提炼结构，不复制相关项目的宣传文案、准确率或性能数字。

| 官方项目 | 当日 README 的结构特点 | 适用于本项目的做法 |
| --- | --- | --- |
| [WhisperX](https://github.com/m-bain/whisperX/blob/main/README.md) | 介绍处理管线及术语，区分基础安装、开发安装、命令行/Python 示例，再列技术细节、限制、路线图、引用和支持入口。 | 将录音、ASR、纪要、引用的职责分清；把依赖、运行示例与已知限制放在可查的位置。 |
| [Buzz](https://github.com/chidiwilliams/buzz/blob/main/README.md) | 产品定位、功能、按操作系统区分的安装方式、依赖与平台限制、截图、完整文档和 FAQ 入口。 | 给出真实可运行的快速开始；明确浏览器与桌面入口、平台差异和导出格式，不能让读者从历史文档猜启动命令。 |
| [Meetily](https://github.com/Zackriya-Solutions/meetily/blob/main/README.md) | 定位与隐私主张、功能、下载/源码构建、按工作流展示截图、模型选择、架构与开发文档；另标注社区版与商业产品边界。 | 用“录音 → 转录 → 整理 → 核对 → 导出”的流程组织能力；明确数据是否送供应商，避免照搬其本地处理主张。 |
| [Vibe](https://github.com/thewh1teagle/vibe/blob/main/README.md) | 下载入口、截图、功能与格式、支持平台、开发/贡献、社区、路线图、翻译和问题报告。 | 首页突出入口和核心操作，把构建、调试、贡献和后续计划链接到专门文档。 |

**建议的完整结构**：项目名称与一句话定位；版本状态与截图；适用场景；已实现功能与验证范围；快速开始；浏览器录音/共享权限与第一次会议；后端模型配置；数据保存与隐私；播放和导出；架构与目录；开发命令与验证；常见故障；版本发布；路线图；贡献、支持和许可证。README 应链接现有设计、运行手册与证据，避免复制易漂移的长篇内部历史。

**发布事实**：GitHub Release 围绕指定 tag 创建，可包含说明和二进制附件，预发布应明确标为 prerelease。[GitHub：Managing releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

**本轮建议**：发布说明固定记录 tag、提交 SHA、安装/启动方式、改动、验证和已知缺口。先区分源码发布、可安装产物发布与线上部署，不能用一个“已发布”代替三者。没有核实远程仓库、权限或附件时，不写成已完成 GitHub Release。

## 当前准确率证据还不足以宣布改善比例

以下来自仓库文档定点核对，没有将历史记录重新当作实时测试结果：

- [当前状态](../engineering/current-state.md)记录：默认两秒短批次存在跨批次上下文评测缺口；约六秒中文合成音频成功识别，不能证明真实会议 CER、跨段语义或长会话质量。文档还记载短批次二遍与热词已接入，因此继续改造前应核查实际请求，避免把已有能力重复计为新增。
- [Alpha 学习](../engineering/alpha-learning.md)记录：现有学习评审支持核听、人工纠正、原音哈希、版本身份、会议隔离以及 dev/test 先盲标。文档所述当轮人工 gold 为 0；这是该轮证据，不是本次对当前数据的统计。
- 同一文档说明当前 NeoHorse 训练的是文本候选选择与意图分类，**不是声学 ASR 权重**。选择器可以学习偏好，不能据此声称已经提升原始语音识别准确率；正确答案不在候选中时尤其需要人工补写或重新识别。

## 先修输入与切句，再评估更复杂的模型

### 官方 ASR 能力与容易混淆的边界

| 能力 | 官方事实 | 对本项目的建议 |
| --- | --- | --- |
| 音频与语言 | PCM/WAV 内部为 `pcm_s16le`，16 kHz、16 bit；总 API 文档明确 `audio.language` 仅 `bigmodel_nostream` 支持，二遍不支持，留空使用默认中英文及方言能力。 | 回归音频声明与实际编码、时间轴一致性；异步二遍不要将纯英文直接改为 `language=en-US`。 |
| ITN、标点、顺滑 | `enable_itn` 为文本规范化；`enable_punc` 负责标点；`enable_ddc` 会删改停顿词或语义重复等不流畅文本。 | 可读性和逐字准确率分开评价。逐字稿建议保留 `enable_ddc=false`，数字/IP/否定等关键字段单列评测。 |

以上参数事实见[豆包大模型流式 ASR API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)。参数存在不保证对特定会议有效。

| 能力 | 官方事实 | 对本项目的建议 |
| --- | --- | --- |
| 二遍识别 | 双向流式优化链路 `bigmodel_async` 可用 `enable_nonstream=true`，在 VAD 判停后以非流式模型重新识别分句；确定结果以 `definite` 区分。 | 检查最终版本是否替代草稿、尾包是否排空以及人工改稿是否受保护，不能只检查开关被发送。 |
| 判停窗口 | `end_window_size` 是静音判停阈值，默认 800 ms，官方推荐 800–1000 ms；`vad_segment_duration` 是语义切句最大静音阈值，职责不同。 | 先保持官方范围，在慢语速、短暂停顿和长句上做配对比较，同时量最终文本延迟；不把纪要的两分钟文字窗口直接用作 ASR 静音阈值。 |
| 提示预算 | 双向流式热词与上下文合计受 100 tokens 限制；开启二遍时需按对应非流式规则核对。 | 按实际接口做预算和裁剪；若没有精确 tokenizer，不能把字符数宣称为供应商 token 数。 |

以上参数事实见[豆包双向流式 WebSocket API](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)。RTC 产品里的 `StreamMode` 是另一层配置封装，不应原样加入裸 WebSocket 请求。

**热词与上下文事实**：官方最佳实践将热词定位为软引导，推荐精简领域专有名词；`corpus.context` 内可合并 `hotwords` 与 `dialog_ctx/context_data`，后者从新到旧排列。非流式/二遍相关上下文上限为 800 tokens、20 轮；完整规则取决于模型及链路。不要把错误的识别历史、全量会议文本或大量无关热词持续回灌。[豆包：热词与上下文最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/hot-words-and-context?lang=zh)

**持续流语言结论**：新 `bigmodel_async` 专页的请求与示例未列 `audio.language`，总 API 又明确二遍不支持该参数；因此建议异步二遍请求省略它，不能声称从 `zh-CN` 改成 `en-US` 会改善英文。`bigmodel_nostream` 可显式指定 `en-US`，与持续二遍的契约分别处理。[双向流式 API](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)；[单向流式 API](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)

**提示字段示例**：下面展示异步二遍语境的字段位置，不包含音频发送、认证或完整运行流程；实际使用前还须匹配已开通的资源和协议。

```js
const request = {
  model_name: 'bigmodel',
  enable_nonstream: true,
  enable_itn: true,
  enable_punc: true,
  enable_ddc: false,
  show_utterances: true,
  corpus: {
    context: JSON.stringify({
      hotwords: [{ word: '聆记' }],
      context_type: 'dialog_ctx',
      context_data: [
        { text: '最新一段已确认的同来源转录。' },
        { text: '更早一段已确认的同来源转录。' },
      ],
    }),
  },
};
```

此处 `context` 是 JSON 字符串，`hotwords`、`context_type`、`context_data` 在同一个对象内，不是把 `dialog_ctx` 放到 `request` 根上。官方明确非流式/二遍支持该组合；双向一遍与二遍预算不同，不能以一遍文档的限制推断二遍不支持上下文。[热词与上下文最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/hot-words-and-context?lang=zh)

**字符预算建议**：固定总字符 100 不等于官方 100 tokens。对二遍能力而言，它会过早舍弃可用热词；对中文一遍而言也不保证不超 token 预算。没有官方 tokenizer 时应将本地字符/字节上限标为工程预算，按词去重、按相关度保留，并分别约束热词、历史轮数和请求大小；扩大上限前需用所选模型验证。不能直接宣称 800 个汉字等于 800 tokens，也不应一开始把二遍 5000 词容量填满。

**最小实施建议，按顺序验证**：

1. 固定音频协议、尾包与 final 修订链路的基线，记录当前 provider、资源、语言和开关；保留当前配置作为回退。
2. 在已有二遍/热词基础上补齐正确的、按来源隔离的近期已确认转录上下文。优先人工确认术语及会议元信息；限制提示长度，不能混入另一音源、未来转录或模型臆造内容。上下文是识别提示，不是替换原文的依据。
3. 检查两秒硬切是否丢失词首/词尾和跨段语义。持续链路优先保持同一来源会话；短批次可另设“较长分句/少量重叠”实验，但必须验证时间对齐、去重、引用和延迟后再改默认值。具体批长需要真实会议评测，本报告不给未经测试的默认数值。
4. 评估当前授权资源是否支持更合适的 ASR 模型与二遍模式，先做同音频 A/B；不根据名称直接宣布新模型更准确，也不自动切供应商。
5. 仅当错误分析证明为固定术语问题时维护词表。只改热词通常比“把错误词全局替换成正确词”更可控；人工纠错和原始识别应分版本保存。不要用 LLM 润色代替忠实转录。

**推断**：现有两秒独立识别如果切断词语，扩大连贯输入可能比继续训练文本选择器更直接；这仍需音频回放和配对评测确认。WhisperX 论文将 VAD 切分和长音频处理作为独立设计问题，不能将其特定模型上的结果直接外推到豆包。[WhisperX，INTERSPEECH 2023](https://www.isca-archive.org/interspeech_2023/bain23_interspeech.pdf)

## 标注应先建立能复用的真实会议金标准

以下是**建议方案**，沿用现有学习评审的核听与分组能力；不是声称已经存在的标注成果。

### 用少量代表性会议启动

先取得允许用于评测的原音，按整场会议固定分组，再从中取连续片段。建议首批 10–20 场、总计 2–5 小时，覆盖麦克风/共享音源、近讲/远场、背景声、中英混说、专有名词、数字/IP、否定句、口音、重叠说话和停止尾段。该规模用于发现主要错误，不足以代表所有用户或发布普适准确率结论。

不要只挑“识别错的片段”：保留随机抽取的自然分布主测试集，困难样本另设挑战集，否则总体指标会失真。分组比例可先用 train/dev/test 约 60/20/20，但会议数量和场景覆盖优先于追求比例；样本不足时先只建冻结测试集，暂不训练。

### 保留逐字真值和格式规则

1. 每段保留原音身份、哈希、来源、开始/结束时间、会议分组、语言、标注者、规范版本、转录修订及是否已看过预测。标注文件与报告只引用身份，不把敏感原文提交到 Git。
2. dev/test 先只看音频盲标，允许回听上下文，不先展示候选或教师输出。另一人复核关键实体、否定、数字及争议；建议首批全量复核，后续至少抽检 20%，争议始终复核。
3. 分开保存逐字原文和阅读规范文本。规范预先固定数字、单位、英文大小写、全半角、口头词、语气词、标点和无法听清/重叠标签。不能看完某个模型结果后只为它改规则。
4. 无法听清的部分标为不确定，保留时段并公布排除比例。重叠讲话单列统计，不悄悄删除难样本来降低错误率。
5. 评测标签冻结版本。已看到模型预测后修改的标签标为经预测辅助修订，不能继续当作独立盲标金标准；来源删除/过期仍按原留存规则处理。

NIST 的会议识别评测明确限定参考、评分条件和重叠语音范围；其历史配置不是本项目应照抄的排除政策。它说明发布指标时必须同时说清“哪些音频被计分”。[NIST 会议识别评测报告](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication500-257.pdf)

### 在采样和提示阶段防止泄漏

- 同一会议的所有来源、切片、重叠窗口、候选和后续修订必须位于同一 split；重复音频按哈希及近重复身份合并。不能把同一会不同两秒切片随机分进训练与测试。
- 若需要说明“新说话人”能力，增加说话人隔离；若只按会议隔离，应明确可能仍包含熟悉说话人。对未来会议的泛化可另加按时间留出的测试集。
- 词表、纠错规则、候选选择器和提示模板只用 train/dev 调整。test 标签不能进入热词、上下文、纠错表或模型训练；测试会的提示只能用真实会前资料和按时序已到达的允许上下文。
- 各方案使用同样的输入音频、片段和允许上下文；计算时间必须从相同起点开始。冻结音频清单、标签、规范、评分脚本、模型/参数和实验提交 SHA。

说话人隔离是公开语音数据集采用的分组方式之一，例如 Mozilla 官方数据说明给出 speaker-disjoint 划分；本项目还需要更严格的会议与音频身份隔离来覆盖双来源和重叠切片。[Mozilla Data Collective：分组说明](https://mozilladatacollective.com/datasets/cmrt6zrob000zmm07yqwjlpwi)

## 同时量文字、关键实体与最终结果延迟

WER 和 CER 均按编辑距离统计替换 S、删除 D、插入 I：`(S + D + I) / N`，N 为参考词数或字符数；错误率可能超过 100%，不应截断。NIST 的 SCTK/SCLITE 提供对齐与评分工具。[NIST SCTK/SCLITE](https://github.com/usnistgov/SCTK/blob/master/doc/sclite.htm)；[Hugging Face CER 实现](https://github.com/huggingface/evaluate/blob/main/metrics/cer/cer.py)

**建议的指标合同**：

| 指标 | 固定口径 |
| --- | --- |
| 中文 CER | 以中文字符为主要单位，预先固定空格、大小写、标点及 ITN 的统一规则；全测试集按总编辑数/总参考字符数汇总，同时报告逐会议分布。 |
| 英文 WER | 英文子集使用固定分词、大小写和标点规范；不能将中文按任意空格切分后所得 WER 与英文 WER 直接比较。 |
| 混合语种 | 至少报告统一规范下的 CER 和中英子集结果；分词版本必须随结果留存。CER 对无清晰词边界的语言更稳健，但也不能表达所有业务损害。[多语种 CER 评测论文](https://arxiv.org/abs/2410.07400) |
| 关键事实 | 人名、产品/术语、数字/日期/IP、肯定/否定分别统计正确命中、漏识别和误插入；单列不可接受的事实反转示例。 |
| 时效和稳定性 | 首字延迟、最终确认延迟 p50/p95、停止至排空耗时、漏尾字、跨段重复和修订次数；分音源/噪声/口音/重叠讲话报告。 |

格式规范会显著影响 ASR 错误率，因此需同时保留原始输出与统一规范结果，不用移除数字或否定等业务内容的规则“美化”分数。[Hugging Face：ASR evaluation](https://huggingface.co/learn/audio-course/en/chapter5/evaluation)

**建议门槛，尚未获真实基线支持**：候选方案在冻结测试集上相对 CER 至少降低 10%，关键实体错误不增加，严重否定/数字反转没有新增，最终确认 p95 延迟增加不超过 20%；同时报告绝对 CER 差值、样本量和按会议配对的置信区间。小样本区间不清晰时只报告趋势，不能宣布稳定提升。所有门槛应在实验前确认，并随业务容忍度调整，不能写成行业标准或本轮已达成。

声学微调仅作为后续路线：先依据错误分布判断热词、输入质量和上下文是否已足够；确需训练时，核实可训练的声学模型、音频/文本授权、算力及独立测试集。没有带核听文本的音频金标准时，增加文本 LoRA 步数不是已验证的 ASR 改进方案。

## 本轮未验证项

- 尚未复跑当前源码请求、真实采音或供应商调用；没有新的真实 CER/WER、延迟、实体准确率或长会话结果。
- 未访问学习数据库或核听原音；当前可用 gold 数量、训练 split 和标签质量需另行盘点。
- 未确认账户实际开通的模型、资源与上下文能力；官方页面的提示预算需要按实际端点核对。
- 本文件仅为研究与建议，不构成版本发布成功、模型更换、声学训练完成或真实准确率验收的证据。
