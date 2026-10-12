# 豆包流式说话人编号的连续性与边界

核实日期：2026-10-12。仅核对火山官方公开文档及文档附件，不调用 ASR、不使用密钥或会议数据。目标是让同一说话人再次发言时复用“说话人 1/2”等编号，避免每个片段新建一个身份。以下区分官方合同、示例行为与本项目建议。

## 先保持一个识别上下文，再复用身份映射

官方 Python sample 在一次 `execute()` 中建立一个 WebSocket，发送初始配置，再在同一连接内发送整段音频的全部分包，最后用负序号标记尾包并关闭。默认每包 200 ms，发送间隔也按该时长等待；它没有为每个音频包创建新连接，也没有跨连接说话人合并逻辑。[官方 SAUC 文档与 Python 附件](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)

这支持“一个来源、一个连续识别上下文内维护说话人映射”的接入方式；并不构成同一人永远不会被模型误分为两人的质量保证。官方资料没有承诺普通 SAUC 匿名说话人 ID 在新连接、重连或独立识别请求间稳定。相同的 `uid` 或 `X-Api-Connect-Id` 也没有被文档定义为恢复声学聚类状态的令牌，不能据此推断身份继承。[SAUC 鉴权与协议](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)

因此，不能把独立的短音频请求返回的 `"0"` 都当成同一个真实人，也不能每次请求都顺延生成一个新的“说话人 N”。

## 开关和字段必须按链路核对

| 项目 | 官方证据 | 实现含义 |
| --- | --- | --- |
| `enable_speaker_info` | 默认关闭；用于匿名说话人聚类分离。语言不指定或为 `zh-CN` 时可用。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh) | 只设置 `show_utterances` 不会自动启用说话人分离。 |
| `show_utterances` | 必须同时启用，才会在分句列表返回说话人标识。[说话人分离最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) | 不能仅保存整段 `result.text`，需要保留每个分句和音频范围。 |
| `enable_nonstream` | `bigmodel_async` 的说话人分离需启用二遍；二遍最终分句以 `definite:true` 表示。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh) | 不把未确定的 partial 当成最终说话人归属。 |
| `ssd_version` | 2026-08-06 更新的 SAUC 总文档要求与 `"200"` 配合，建议 ASR 2.0；2026-09-22 更新的 SSD 最佳实践中，SAUC 示例只列说话人开关与二遍开关，没有要求 AUC 的长音频模式。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)、[SSD 最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) | 两份官方说明存在细节差异。兼容接入可带 `ssd_version:"200"`，但不能把 AUC 专用的 `"300"` 或长音频模式推断为 SAUC 能力。真实资源权限与参数还需实际验收。 |
| 分句与人数 | 最佳实践说明 SAUC 最多分离 10 位说话人；二遍的最终句会按说话人拆分。[SSD 最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) | 供应商不是无限身份源；未知、超限或异常 ID 应有明确的未确认状态。 |

一般多人会议不要启用 `ssd_mode:2` 的短音频声纹认主模式。官方将它限定为短音频单主说话人场景，需要预注册声纹，不适用多说话人分离。[SSD 最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh)

## 当前官方响应示例使用 `additions.speaker_id`

新版官方 `bigmodel_nostream` 一句话识别文档的实际输出示例中，说话人字段位于：

```text
result.utterances[].additions.speaker_id
```

值为字符串，例如 `"0"`；同一分句还包含 `definite`、`start_time`、`end_time` 和 `text`。这是官方示例可直接确认的嵌套结构，不应只读取顶层 `speaker`。[官方一句话识别字段与输出示例](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)

旧 SAUC 总文档没有完整展示含说话人的响应例子；SSD 最佳实践只概括为分句中的 `speaker_id`。如果项目还兼容历史 `additions.speaker` 或其他供应商字段，应将其标为兼容读取，不能把这些别名写成当前官方统一格式。适配器需要把合法的数字 `0` 或字符串 `"0"` 归一为同一值，不能用真假值过滤而丢掉零。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)、[SSD 最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh)

## 首字延迟要让一遍结果立即上屏

2026-09-28 更新的官方实时识别文档明确：`bigmodel_async` 开启 `enable_nonstream` 后仍实时返回一遍文字；检测到一句话结束，再用重新识别的结果替换之前文字。二遍是在已有实时结果上的校正，不是要求客户端等整句话结束才显示。旧 SAUC 文档进一步说明，二遍结果才携带 `definite:true`。[当前实时识别文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)

客户端如果只处理 `definite:true` 或负尾包，首字就会额外等待停顿、二遍处理甚至整段结束。建议把非确定结果作为可替换的“正在识别”草稿立即显示，二遍确定后再提交转录、可信说话人归属和下游纪要输入。这是本项目的处理建议，不表示 partial 已获得最终文本或最终身份的保证。

| 参数或环节 | 官方约束 | 不能混淆的边界 |
| --- | --- | --- |
| 音频分包、发包节奏 | 建议每包约 100–200 ms，间隔约 100–200 ms；双向链路推荐每包 200 ms。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh) | 这是供应商输入节奏，不是浏览器必须攒几秒才能上传的要求。分包大小与用户看到的字幕段落无关。 |
| `end_window_size` | 当前实时文档默认 800 ms、范围 `[300,5000]`、推荐 `[800,1000]`；连续静音达到阈值后判停并触发分句。[当前实时识别文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 旧 SAUC 总文档写最小 200 ms，存在版本差异；新接入宜遵循更新文档的 300 ms 下限。缩短它主要缩短定稿等待，不等于缩短首个一遍字符的识别时间。 |
| `vad_segment_duration` | 默认 3000 ms；只影响语义分句，不决定判停或 `definite` 出现位置；设置 `end_window_size` 后不生效。[当前实时识别文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 当前官方页面没有列出它的完整合法取值范围，不能自行宣称某个区间是供应商合同。不要用它代替首字加速或 VAD 判停参数。 |
| `enable_nonstream` | 默认关闭；开启后保留实时一遍输出，并在句后执行二遍修正。[当前实时识别文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 关闭二遍可能影响准确率，并与 async 说话人分离的要求冲突；不要为首字速度直接关闭它。 |
| `enable_accelerate_text`、`accelerate_score` | 首字加速默认关闭；开启后可能牺牲首字准确率。旧 SAUC 总文档给出的加速率范围为 `[0,20]`，默认 0；当前实时文档仍说明此参数，但未重列范围。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh)、[当前实时识别文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 加速属于速度与准确率的选择，不是保证时延的 SLA；先解决攒包和只显示 final 的延迟，再用真实语音对照评测决定是否开启。 |
| 二遍说话人尾包延迟 | SSD 最佳实践描述开启二遍说话人分离带来的额外尾包延迟约 40–80 ms。[SSD 最佳实践](https://docs.volcengine.com/docs/DoubaoVoice/speaker-separation?lang=zh) | 这个数字不是整段 ASR 总时延，也不是首字时延，还不包含 VAD 等待和本项目上传、排队、SSE 传输。 |

### 打字机效果不能继续延迟真实字幕

建议前端按草稿段 ID 更新可变文字：一遍结果可能改写末尾，`result_type:full` 还会重复之前的内容，所以不能把每个响应都追加到句尾。保留已确认内容，只替换当前草稿；二遍确定后用同一段位置校正，避免重复段落与滚动跳动。

逐字动画是显示效果，不应伪装成供应商逐字事件。可以只对新增尾部做轻量显示过渡；到达新结果、用户切换页面或积压时立即追平最新文本，尊重减少动态效果设置。真实文本一到即可读，不能为了动画排队播放数秒。说话人尚未确定时展示“正在识别”，不能随每次 partial 新建说话人。

延迟应分别测量：麦克风产生首个有效音频样本 → 后端接收 → 供应商首个非空一遍结果 → 浏览器首次绘制，以及一句话停止 → 二遍定稿。合成文件导入的总耗时包含解码、上传和按节奏回放，不是麦克风实时首字延迟；协议 fixture 也不能证明真实网络与模型的 P50/P95。

## 连接限制中哪些仍未公开

| 边界 | 本次官方核实结果 |
| --- | --- |
| 分包与发包间隔 | 官方建议约 100–200 ms；双向链路建议每包 200 ms。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh) |
| 等包超时 | 官方定义错误码 `45000081`，但本次核对的 API 正文与附件没有明确给出触发的空闲秒数。[SAUC API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh) |
| 单连接最长持续时间、单次音频上限 | 本次核对的 SAUC 总文档、SSD 最佳实践和 Python sample 没有找到明确数值。不能把录音文件识别或其他产品的长度限制移植过来。 |
| 超时与心跳 | Python sample 没有建立可复用身份的心跳/恢复协议，也没有显式声明服务端空闲期限。WebSocket ping 不等同于音频包，不应假设它能避免业务等包超时。 |
| 跨连接说话人身份 | 没有找到稳定 ID、聚类恢复令牌或跨连接合并接口的公开合同。需要向供应商确认；重新连接后应视为新的识别上下文。 |

这些“未找到”仅表示本次有界公开资料核实的缺口，不代表服务端不存在限制。生产长会议必须单独测量并记录断线码、最后已提交音频位置和可恢复范围。

## 本项目建议：稳定显示编号，未知时不要制造新人

1. 为每个连续来源建立持久识别流，记录 `sourceId`、采集 epoch 和独立的 ASR 上下文 ID。音频分包、客户端持久 ACK 和供应商连接周期分别建模。
2. 同一 ASR 上下文内维护 `providerSpeakerId → recordSpeakerId`。第一次可信出现时分配“说话人 1”，再次出现时直接复用；不同分句、重复结果和修订不能分配新身份。
3. 本地维护记录级说话人表及人工命名，不用片段序号或音频包序号生成说话人编号。相同供应商 ID 在不同上下文里先隔离，不能直接合并。
4. 设定明确的匿名人数上限，与本轮接入的供应商能力相匹配。缺失、异常或超限 ID 显示“未确认说话人”，不继续无限递增，也不强行归入最后一位。
5. 断线、新来源或重新识别后，只有经过可验证的跨窗音频对齐、独立声学身份模块或人工合并，才能映射回已有记录身份。没有这些证据时，应保留待确认归属。
6. 若要保证整场会后身份一致，可另设整段重新分离与校对阶段；这属于新增能力及独立验收，不能由短批次 SAUC 测试证明。声纹姓名匹配还需要独立授权。

最低验收用例应包含 A→B→A、重复最终包、partial→final 修订、`speaker_id:"0"`、供应商缺字段、异常大量 ID 和断线重连。前五类可用协议 fixture 验证身份表不会无限增长；“第二次 A 的声学身份是否识别为 A”仍必须用真实多说话人音频验证。
