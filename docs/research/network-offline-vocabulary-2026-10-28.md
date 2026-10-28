# 网络词库与下载词库：研究与最小落地建议

核查日期：2026-10-28（Asia/Shanghai）。产品代码基线：`2166661`，对应已发布 v0.1.34 的后续发布回执。本文为研究与建议，没有实现网络查询、公共词库下载、读音索引或供应商云词表管理，也没有读取私人词表或发送真实会议内容。

**建议优先做“可下载的公共离线字音/词语包＋现有账户/目录私人词集”，再按需接云端热词表；在线实体查询只在用户明确需要时触发。** 字库、字音表、实体库和 ASR 热词表解决的问题不同，扩大词条数量本身不能保证同音字纠错更准。

## 1. 当前产品基线与尚缺的能力

代码已核实：账户全局与目录词集按 `owner` 和 scope 读取，保存词语/名称及显式误识别 alias；本地候选匹配 alias，模型校对手动触发，修改原文需要人工确认并核对片段版本。ASR 提示按标题、笔记和近期片段择优，当前豆包实现对传入的词施加**合计 100 个字符的工程预算**；Deepgram Nova-3 分支已经用重复 `keyterm` 参数传递候选，兼容转录接口已传 prompt。内置 SenseVoice worker 没有热词注入入口。[词集领域逻辑](../../packages/records/src/vocabulary.mjs)、[按账户/目录加载与候选](../../services/records/src/vocabulary.mjs)、[豆包请求](../../services/records/src/asr-terms.mjs)、[其他 ASR provider](../../services/records/src/providers.mjs)、[本地 worker](../../services/records/src/local-asr-worker.mjs)。

因此，公共字音词库首先改善的是**候选召回与读音比较**，不会让当前 SenseVoice 自动获得新的声学词典。不要把“下载安装词库”展示成“已训练/已注入本地识别模型”。公共库也不能可靠包含本单位所有人员姓名、客户内部简称或新项目代号，私人词集仍是高价值补充。

## 2. 三种方案对比

| 方案 | 最适合解决的问题 | 离线/隐私 | 本项目建议 |
| --- | --- | --- | --- |
| 公共在线词典/实体查询 | 查公开人名、组织、地点的规范写法和多语言别名，人工消歧 | 查询词会离开设备；服务不可用时无结果 | 作为显式查询工具，不接每段实时识别关键路径 |
| 供应商云端热词/词表 | 提升当前 ASR 对特定专名的召回；绑定词表后由供应商识别模型使用 | 依赖网络，词表也属于上传数据；供应商账号/应用隔离不同于产品账户隔离 | 需要明确云同步选择与服务端映射，逐 provider 接入 |
| 下载本地词库＋读音索引 | 脱网查字音、词语读音及同音/近音候选，减少网络延迟 | 公共包可共享只读；私人覆盖层隔离保存 | 第一优先，先定版小包和人工候选，不自动全局替换 |

## 3. 网络公共数据：Wikidata 可以用，但不当实时 ASR 词库

**事实。** Wikidata 的主、Property、Lexeme、EntitySchema 命名空间结构化数据以 CC0 发布；其他命名空间的说明文字是另一种许可，不能把网页文字一并当作 CC0。实体标签、别名可通过 Wikibase API 取回；实体 ID 可用于区分同名对象。CC0 不要求署名，但项目建议注明来源。[官方许可](https://www.wikidata.org/wiki/Wikidata:Licensing)、[Wikibase API](https://www.mediawiki.org/wiki/Wikibase/API)、[数据访问说明](https://www.wikidata.org/wiki/Wikidata:Data_access)。

**事实。** 公共 SPARQL 服务性能会随负载变化；当前文档列出 60 秒查询超时、单客户端每 60 秒最多 60 秒处理预算等约束，更新异步存在延迟。访问需使用可识别 User-Agent，遇到限流遵守 `Retry-After`。官方还提供周期性 JSON/RDF dump，适合离线提取子集，但全量 dump 不宜让每台客户端直接下载。[WDQS 使用约束](https://www.mediawiki.org/wiki/Wikidata_Query_Service/Implementation#Usage_constraints)、[访问约定](https://www.wikidata.org/wiki/Wikidata:Data_access#Access_best_practices)、[官方数据库下载](https://www.wikidata.org/wiki/Wikidata:Database_download)。

**推断与建议。** 它适合“查公开名称→显示实体描述与多语言别名→用户选中→加入私人词集”，或在构建端提取经过筛选的公共专名小包。它不是覆盖所有普通词和读音的汉语词典，公开人物也不等于本场参会者。不要把整段会议、私人姓名清单或目录词集自动送去搜索；仅上传用户明确查询的最小文本。查询结果保存来源实体 ID、语言与获取时间，不能因搜索排名第一就自动纠错。

## 4. 云端热词：优先接现有 provider，严格区分接口

### 豆包

**事实。** 官方热词管理文档提供 `CreateBoostingTable`、`UpdateBoostingTable`、`ListBoostingTable`、`DeleteBoostingTable` 等操作；维护接口与音频识别 WebSocket 并非同一接口。文档列有 AK/SK 签名方式及 API-Key 接入说明，权限和限额应按实际账号读取，不能把示例额度当成所有账号保证。[热词管理 API](https://docs.volcengine.com/docs/DoubaoVoice/HotWordManagementAPIv10?lang=zh)。

**事实。** 官方控制台热词说明支持上传 UTF-8 TXT，生成热词 ID 后通过 `boosting_table_id` 或名称引用；该说明给出中英文优化、每文件 5000 词等限制。现行 `bigmodel_async` 实时接口同时有较小的热词/上下文预算，开启二遍时又引用单向接口约束；最佳实践也区分二遍、直传与词表，且强调热词只是提示、不是强制替换。不能把控制台可保存的 5000 词等同于每条识别请求全部有效，更不能把项目的 100 **字符**预算当成供应商的 100 **tokens**。[热词使用说明](https://docs.volcengine.com/docs/doubao-voice/hot-words?lang=zh)、[实时接口](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)、[热词与上下文最佳实践](https://docs.volcengine.com/docs/doubao-voice/hot-words-and-context?lang=zh)。

**建议。** 第一版先允许管理员绑定已创建的词表 ID，并明确显示 provider、应用、目录和同步范围；确有动态管理需求后再做创建/更新。同步内容按目标账号/目录选择，不把所有用户词集合并进同一张供应商词表。采用 `(owner, workspace, provider account/application, vocabulary revision)` 映射并核对远端归属，更新失败保留旧 ID。上传专名需要单独的云同步授权；删除私人词集后也要有远端同步/解绑策略。

### Deepgram

**事实。** Nova-3 与 Flux 提供 Keyterm Prompting；单次请求合计上限为 500 tokens，多个词使用重复 `keyterm` 参数，不能借用旧 `keywords=term:weight` 的权重语法。当前文档还支持相应流式连接通过 `Configure` 替换 keyterms；预录音请求不能这样中途更新。这是识别请求提示，不是可下载的公共字典。[Deepgram 官方 Keyterm 文档](https://developers.deepgram.com/docs/keyterm)。

**建议。** 当前项目使用 `/v1/listen` 的预录音短请求，继续复用已有 Nova-3 keyterm 适配，先验收请求实际命中、预算和噪声回归；没有必要为它新建云词表平台。未来升级流式实现才考虑动态更新。不同供应商的条数、字符、字节与 token 上限不能共享一个未经校准的数字。

## 5. 下载本地数据：推荐源、授权与适用范围

| 数据源 | 已核实内容/格式 | 数据许可与再分发边界 | 适合本项目的位置 |
| --- | --- | --- | --- |
| Unicode Unihan | UTF-8 字符属性；`Unihan_Readings.txt` 中含普通话等读音字段，另有变体关系。字符读音不是整词读音或词频 | Unicode 数据许可允许使用、修改、分发，须保留版权和许可通知；按实际固定版本归档许可 | 首选离线字音基底，供私人名称和词语生成候选读音 |
| `mozillazg/pinyin-data` | `U+码点: 带调拼音列表`；支持多音字，数据分文件区分 Unihan 等来源 | 仓库 MIT；README 同时列出 Unihan、CC-CEDICT、汉典等源。分发具体数据前保留来源链，不能只看到根 MIT 就把所有聚合数据标成 MIT | 便于开发验证；首发可只取来源明确、许可已核对的文件 |
| `mozillazg/phrase-pinyin-data` | `词语: 带调分音节拼音`；有人工修订及多个聚合文件 | 根目录 MIT；`large_pinyin.txt` 明示合并 CC-CEDICT/汉典等，不能忽略上游数据条件 | 词级多音字消歧的候选源，选定具体文件后审核、定版 |
| CC-CEDICT / MDBG | 简繁词形、数字声调拼音、英文释义；可下载 ZIP/GZip UTF-8 文本。本次 2026-10-28 观察页面标记最新发布为 2026-10-27，条数为 125326；不是固定规模，也不代表全是专名 | 当前数据明确为 CC BY-SA 4.0；署名、保留许可、标明修改；衍生数据分享要求按最终选定数据和交付方式落实，不作整个软件许可结论 | 可选独立词级数据包，补普通词和部分公开专名；不优先携带用不到的英文释义 |
| THUOCL | 分类词表＋DF 文档频次（TAB 分隔），IT、地名、历史名人等；公开资料主要为 2016–2017 年版本，无读音 | 仓库 MIT；作者 README 直接说明词库可研究和商用，科研成果要求引用。保留文件级来源与许可 | 可选领域候选词表，DF 只作该历史语料的排序信号，不能视为本场出现概率 |
| rime-ice 雾凇拼音 | 输入法词库、拼音与权重及配置；词库文件列有各自数据/词频来源 | 仓库 GPL-3.0；部分数据文件另列外部源，须逐文件核查来源和通知，不以代码仓标签替代数据结论 | 不作为第一版默认整包；它包含输入法专用配置与远超本任务需要的内容 |

逐项一手依据：[Unihan 格式与属性](https://www.unicode.org/reports/tr38/)、[Unicode 数据许可](https://www.unicode.org/license.txt)、[Unicode 18.0.0 发布文件目录](https://www.unicode.org/Public/18.0.0/ucd/)、[pinyin-data README](https://github.com/mozillazg/pinyin-data/blob/master/README.md)与[LICENSE](https://github.com/mozillazg/pinyin-data/blob/master/LICENSE)、[phrase-pinyin-data README](https://github.com/mozillazg/phrase-pinyin-data/blob/master/README.md)与[LICENSE](https://github.com/mozillazg/phrase-pinyin-data/blob/master/LICENSE)、[MDBG 数据下载及许可](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)、[CC-CEDICT 格式](https://cc-cedict.org/wiki/syntax)、[THUOCL README](https://github.com/thunlp/THUOCL/blob/master/README.md)与[LICENSE](https://github.com/thunlp/THUOCL/blob/master/LICENSE)、[rime-ice LICENSE](https://github.com/iDvel/rime-ice/blob/main/LICENSE)与[一个词库文件的来源说明](https://github.com/iDvel/rime-ice/blob/main/cn_dicts/8105.dict.yaml)。

授权比较依据上述发布者声明；这不是对所有来源链的法律认证。首发包要形成精确到文件、固定 revision 的清单。尤其不要将来源不同的聚合文件重新标为一个“全部 MIT”包，也不要把下载变成规避数据许可的办法。

## 6. 最小分期

### 第一阶段：离线读音候选，保留人工确认

1. 先选 Unihan 的所需读音字段，构建固定版本小包；词级补充可选独立 CC-CEDICT 包并保留其许可。私人词集继续沿用现有账户/目录保存，不复制到公共数据包。
2. 先给**已有私人词集**生成读音索引，再按需检索公共词包。保留声调与词边界；多音字维护多个合法读法，优先词级读音，不对整段做所有组合的笛卡尔展开。普通话拼音索引不能直接用于粤语、日语或韩语文本纠错。
3. 由同音/近音关系生成带原文位置、片段 revision、候选来源和理由的建议，复用当前确认入口。名称读音可能特殊，允许用户覆盖；公共高频词不能压过明确的私人专名。
4. 用“同音且都合法”“姓氏多音字”“新项目名”“中英型号”“噪声/否定句”测试误报；比较候选召回和用户拒绝率。对不确定读音保留未知，不发明置信分数，不自动全局替换。

这阶段没有必要实现全网词典搜索、云端上传、通用插件框架或整库 ASR 注入；先证明读音候选对现有词集有增益。

### 第二阶段：可下载更新的公共包

使用一个受控包清单即可，不先做通用包管理器。构建端从已许可源提取所需字段，发布不可变包；清单至少包含 `id/version/source revision/schema/languages/bytes/sha256/license/attribution`。用固定版本 URL，不让应用在启动时直接抓 `master`/`latest` 并静默改变候选结果。

下载到临时文件后检查来源/HTTPS、大小与解压上限、路径、摘要及 schema；索引构建和抽样校验成功后，原子切换活动版本指针，保留上一版本以回滚。断网、磁盘满、哈希不符、部分下载和解析失败都继续用旧包，不破坏私人词集。SHA-256 证明完整性，真实性仍依赖可信清单发布路径；可复用产品现有发布信任渠道，不能宣称“有哈希即已签名”。

小型包先整体更新即可。上游有变动时定期生成版本差异；待真实下载量证明需要后，再做增量补丁。增量必须绑定基底 hash，并再次核对目标全量 hash；失败回退全包。公共只读索引可共用，私人覆盖层及查询历史按账户/目录隔离；含私人词的派生索引或缓存也不能按公共缓存跨租户复用。

### 第三阶段：有明确需求才接网络

先提供显式公开名称查询；选中结果后仍经用户确认加入私人词集。再针对已使用的豆包账号加入云词表 ID 绑定，并验证目标 ASR 端点、语言与词表预算；动态上传放到后续。候选排序后只发送本场相关小子集，公共全库保留本地，绝不塞进当前 100 字符热词预算。

## 7. 应当独立验收的边界

- **效果：** 用固定合法样本比较无词库、私人词集、加入公共读音包、云热词四种模式；分别记录专名召回、误替换/误报、延迟和内存。下载成功不代表 ASR 提升。
- **数据：** 多音字、简繁、组合字符、姓名特殊读音、英语大小写、型号数字；语言不匹配时不套用普通话索引。
- **隔离：** 账户切换、目录切换、共享设备、云词表 ID 归属、修改/删除私人词集后的缓存失效，不能让 A 的词库或候选泄露给 B。
- **更新：** 离线启动、旧版本读取、坏包、截断包、错误 hash、解压炸弹/越界路径、并发下载、回滚和取消；已有会议原文与人工编辑均保留。
- **授权：** 公共包下载无需上传会议；公开名称查询、私人云词表同步、云 ASR 和模型校对是不同的数据外发行为，不能合并为同一个默认开关。

本研究未下载或重新分发完整数据包，未实测供应商热词管理权限/额度，未做真实会议准确率、离线索引性能或读音候选效果测试。可再分发性和更新方案需以最终选定文件/版本落地核验，不能将本报告写成已实现能力。
