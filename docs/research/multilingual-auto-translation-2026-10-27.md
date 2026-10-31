# 多语种自动识别与目标语言翻译：现状与建议

核查日期：2026-10-27（Asia/Shanghai）。代码基线：`9db52f0`。本文是研究建议；本轮只调整设置页展示，没有实现新的语言检测协议、切换识别供应商或完成真实多语种验收。

**建议先把“识别原文”和“翻译目标”分开：音频按语音段自动识别并保留原语种原文，确认片段再按本场设置的目标语言翻译。优先沿用内置 SenseVoiceSmall 与现有翻译队列，先验收其覆盖的中、英、日、韩、粤语；更广语种再选兼容的识别服务。** 不必先增加一个按文字猜语言的独立服务。

## 当前代码已经具备什么

| 环节 | 已核实实现 | 当前边界 |
| --- | --- | --- |
| 本地识别 | 内置 `sensevoice-small-2024-07-17-int8`，sherpa-onnx-node 1.13.8；worker 未强制指定本场语言，模型按默认模式识别 | 目前只读取 `getResult(stream).text`；语言标签、其他元数据没有经 IPC 保存到转录片段。不能在界面宣称已显示可靠的逐段识别语种 |
| 外部 FunASR | 将本场 `record.language` 中支持的固定语种传入兼容接口；其他值传 `auto` | 默认本场语言为 `zh`，因此选外部服务不等于已开启全自动识别；部署服务是否接受 `auto` 仍需实测 |
| 豆包识别 | `bigmodel_async` 采用二遍识别；仅在 `bigmodel_nostream` 路径发送 `audio.language` | 本场“主要语言”不能覆盖供应商接口的实际能力；不能简单向二遍接口添加任意 `auto`/`ja` 参数 |
| 翻译 | `translateSeedText` 只传 `translation_options.target_language`，未把记录的主要语言强设为源语言；确认片段逐段进入翻译队列 | 请求形状已适合让翻译模型判断源文本语言；真实跨语种、同句混语质量和该配置下的服务能力仍未实测 |
| 结果隔离 | 队列回写核对片段 revision、记录 generation、目标语言、translationRevision 和 lease fence | 切换目标语言/修订原文后，过期请求不能覆盖新状态；新增语言元数据也应遵循同一版本边界 |

代码依据：[资源版本](../../services/records/src/local-asr-resources.json)、[本地识别 worker](../../services/records/src/local-asr-worker.mjs)、[本地 IPC](../../services/records/src/local-asr.mjs)、[外部 FunASR](../../services/records/src/funasr.mjs)、[豆包请求配置](../../services/records/src/asr-terms.mjs)、[翻译请求](../../services/records/src/seed-translation.mjs)、[翻译队列](../../services/records/src/worker.mjs)、[翻译设置模型](../../packages/records/src/translation.mjs)。

“自动翻译”的目标语言目前仍保存到**当前记录**的 `record.translationTarget`，不是账户级默认，也不会自动为后续新会议开启。标题改名不改变保存范围。若未来需要全局默认，必须另行设计新建记录时的继承与逐场覆盖规则；不要静默扩大音频或原文的云端发送范围。

## 官方能力和不能推导的结论

**内置模型按 5 类语言规划。** sherpa-onnx 对本项目同款 2024-07-17 模型列出普通话、英语、日语、韩语、粤语；SenseVoice 官方当前说明也明确区分已发布 Small checkpoint 与更广的研究范围。不能把“SenseVoice 研究支持 50+ 语种”套到此内置包。官方示例支持自动语言模式，但这不构成同一句混语的准确率保证。[sherpa-onnx 同款模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[SenseVoice 官方仓库](https://github.com/QwenAudio/SenseVoice)。

**逐段语言元数据可以利用，但须先核实绑定版本。** sherpa 的识别输出示例包含 `lang`；本项目目前将结果缩减为纯文本，且多个语音窗口最终合成一个批次片段。应检查锁定的 Node 1.13.8 实际结果后再保留它，不能把一个批次的主语种标成其中每个词的语种，也不能伪造未返回的置信度。[sherpa 官方输出示例](https://k2-fsa.github.io/sherpa/onnx/rknn/models.html)、[SenseVoice 语言配置源码](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-sense-voice-model-config.h)。

**豆包不同接口要分开验收。** 当前双向流式文档列出中、英及上海话、闽南话、四川话、陕西话、粤语；流式输入 `bigmodel_nostream` 可显式指定更广语种。该接口未指定 language 时主要覆盖中文方言和英语；“支持多语种”不等于“任何语言混在一起都自动识别”。历史整合文档还明确 `language` 仅适用于 `bigmodel_nostream`，二遍不支持。[双向流式文档](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[流式输入文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[整合 API 说明](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh)。

**不要混用两套翻译 API。** 本项目使用方舟 Responses 的 `input.content.translation_options`，官方 API 和 SDK 定义源/目标语言字段；当前代码省略源语言。另一个豆包语音机器翻译接口 `openspeech.bytedance.com/api/v3/machine_translation/matx_translate` 明确说明：不传 `source_language` 时自动检测，并返回 `detected_source_language`。它的鉴权、资源权限、请求与响应结构不同，不能直接当成本项目现接口的返回能力。方舟当前已配置模型省略源语言的行为、可用语种和同句混语效果，应以真实账号请求验收。[方舟 Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)、[火山官方 SDK 字段](https://pkg.go.dev/github.com/volcengine/volcengine-go-sdk/service/arkruntime/model/responses#TextTranslationOptions)、[豆包语音机器翻译 API](https://docs.volcengine.com/docs/DoubaoVoice/MachineTranslationLargeModel-APIAccessDocumentation?lang=en)。

## 最小可行推进顺序

1. **先验现链路。** 使用经许可的中英交替、单语日/韩/粤语音样本，开启本地识别，将目标设为中文或英语。核对原文、译文、时序与引用；不先改 ASR 模型或引入语言检测服务。当前代码已有自动识别与按目标语言翻译的基础。
2. **保留可证实的语言元数据。** 在不改变已保存原文的前提下，扩展本地 worker→IPC→转录保存，携带可选的检测语种、检测来源、模型版本及其音频范围。旧片段缺值保持未知；人工修订和重试遵循已有片段版本。只有供应商确实返回对应数据才保存，单标签不能被解释成词级检测。
3. **把短句和混语当成验收问题。** “OK”“AI”“行”等短文本、专有名词以及“我们 use Redis 做缓存”可能无法由一个语言标签表达。保留原文后让翻译模型处理整句，避免按字符硬切或仅凭单个检测标签跳过整句。纯目标语言片段是否免翻译，等准确检测得到验证后再做；当前不提前增加此优化。
4. **有更广语种需求时再选识别服务。** 先列出必须覆盖的语言与是否允许云端处理，再对候选供应商逐项验收自动检测、切换语言、停顿、同句混语和时间定位。固定语言接口不能包装成任意多语种自动检测。更换 provider 不自动代表允许上传已有本地录音。

建议流程：`原始音频 → 分段识别（原文＋可选语种）→ 确认片段/版本 → 现有翻译队列（设置的目标语言）→ 译文＋原文引用`。翻译失败保留原文；识别失败明确报错，不让翻译模型猜补漏掉的语音。

## 验收集和通过条件

| 场景 | 至少检查的结果 |
| --- | --- |
| 中→英→中交替；两人轮流说不同语言 | 各段保留正确原文，译文统一为设置目标；不因上一段语言强制误识别下一段 |
| 中英同句、型号/人名、数字与否定句 | 无漏译、错否定或专名替换；一个主语种标签不掩盖句内混语 |
| 日/韩/粤单语，中文为目标 | 实际内置模型覆盖与译文质量；粤语与普通话的显示语种不混淆 |
| 西/法/德等内置范围外语言 | 明确标为未支持或经另一个已验 provider 处理，不展示“已支持”假象 |
| 已是目标语言、极短句、静音/噪声 | 不凭猜测跳过混语；静音无虚构文字；未知语种可保留未知 |
| 翻译中切目标、关翻译、修订原文、断网重试 | 旧目标/旧 revision 结果不回写；失败可见；原文与音频留存不被损坏 |
| 长会话、暂停/结束的尾音频、双来源 | 尾段处理完整，重传不重复；原音范围与片段引用可追溯 |

每组记录使用的模型/供应商、语言设置、目标语言、音频许可、原文 CER/WER 或人工错误标注、译文忠实度、首次结果与最终结果延迟。先形成固定样本基线和人工可接受阈值，再决定是否上线；本文没有提供未经测量的准确率、延迟或成本承诺。

未验证：真实账号下的翻译请求、锁定 Node 绑定的语言元数据形状、混语识别/翻译质量、长会话、真实设备和新增全局默认行为。本文没有调用收费模型或修改会议数据。

## 常用词和名称集如何辅助纠正

现有“容易识别错误的词语”将正确词形按逗号分隔，去重后发送到豆包识别请求的 `corpus.context.hotwords`；这是识别提示，不是已保存文本的替换表。当前内联预算为总计 100 字、每词最多 50 字；背景最多 400 字，且仅中英 `bigmodel_async` 二遍识别携带场景背景。更换配置只影响后续连接，不改写已有转录。内置 SenseVoice 和外部 FunASR 没有消费此热词字段。依据：[请求构建与校验](../../services/records/src/asr-terms.mjs)、[本地识别 worker](../../services/records/src/local-asr-worker.mjs)、[外部 FunASR](../../services/records/src/funasr.mjs)。

建议先维护按项目/目录选择的词表：正确名称、简称、已确认别名，以及类型（人名、组织、产品、业务术语）。识别前按会议上下文挑选少量相关正确词形，映射到供应商实际支持的热词或提示能力；不能把大词库原样塞进当前 100 字内联字段。识别后若还需纠正，将原文、相关词表和邻近发言交给纠正步骤，只生成带片段版本及原文位置的候选。专有名词、同音词和人名需核听或人工确认，保留原文与修订记录；不要全局硬替换，也不覆盖人工编辑。此方案尚未实现或用真实样本验收。
