# 多语种与词表实现验证

日期：2026-10-28（Asia/Shanghai）。起点 `0ad2fc526dec54e6e6e966090c6723e0a2ca6eca`。本轮改造的发布版本计划为 v0.1.34，公开分发状态由发布回执独立核对。

## 实现范围

原文与目标语言分离：新建默认 auto，内置 SenseVoice 保留实际 `lang`，只接受中、英、日、韩、粤白名单；实际绑定输出 `<|zh|>` 先规范化再经 IPC 校验，未返回语种的旧片段不补猜。段落语种标注为原音批次元数据、记录模型与初始修订，不能据此解释同句每个词的语种。

词表用现有 aggregate repository 持久化，按 owner/scope 隔离，不变更音频 ACK 和音频定位。全局和当前工作目录词表组合，正确写法按相关性挑选到支持供应商的提示预算。别名匹配是本地建议；模型校对由明确按钮触发，仅允许返回来自原文的连续短跨度和词表正确写法，不能改写整句事实。确认前校验词表 fingerprint、片段修订、非重叠范围；人工确认走现有 editSegment，原始识别文字保留，翻译 lease/fence 作废。

词表确认后的同段剩余候选迁移跨度与版本，可连续处理；普通人工编辑的后续版本仍受保护。可一次确认本段多个不重叠改动。界面新增逐字记录折叠入口，词表保存按钮处于原设置页固定底栏。

自动翻译复用现有目标/修订/租约隔离。实际通用 Responses 服务不提供默认 Seed 模型，旧请求返回 404；因此新增自动/当前文字模型/豆包 Seed 模式，自动模式在专用配置或官方方舟端点上选择 Seed，其余选择已配置文字模型。专用 URL 缺少密钥不借用不同 URL 的文字密钥。设置保存范围仍为本场，未默认启用后续会议翻译。

## 确定性检查

- Node 24.21.0：566/566（合并 v0.1.34 回放更新并含新增指南契约检查），通过完整串行回归；Rust 37/37，通过（另1项网络更新探针按既有配置忽略）。
- 新覆盖：账户/目录隔离、保存重开、HTTP 权限与陈旧修订、语言切换排空、连续/批量确认、重叠拒绝、普通人工编辑保护、混语整句翻译及迟到结果拦截、通用与专用翻译分流、IPC 语种校验。
- lint、Web typecheck/build、192份文档链接检查、隔离打包后端导入均通过。已有 Web chunk 体积提示不构成新增失败。
- 独立审查者 `/root/update_review` 初次发现 2 项 P2，修复后复核无剩余 P1/P2，独立定向测试 27/27。

## 真实本地模型与真实文字接口

内置 `sensevoice-small-2024-07-17-int8`、sherpa-onnx-node 1.13.8 使用 macOS say 生成虚构合成语音，不使用真实会议。

| 输入 | 返回语种 | 语音时长 | 本机推理观察 |
| --- | --- | --- | --- |
| 普通话 | zh | 7.16 秒 | 返回中文原文 |
| 英语 | en | 5.16 秒 | 返回英文原文 |
| 日语 | ja | 9.19 秒 | 返回日文原文 |
| 韩语 | ko | 7.00 秒 | 返回韩文原文 |
| 粤语 | yue | 6.36 秒 | 返回粤语原文 |
| 普通话＋英语拼接 | zh | 两段拼接 | 同时保留中文和英文，单标签未阻止后续翻译 |

真实已配置通用文字模型处理虚构短句“王小明负责灵记项目，please keep the original recording。”，按 en 返回 “Wang Xiaoming is responsible for the Lingji project, please keep the original recording.”；词表校对也返回通过结构校验的候选。未向模型发送真实会议、录音或个人词表。原始探针保存在 gitignored `.agent-runtime/multilingual-20261027/`，不包含配置密钥。

浏览器隔离开发账户完成新建 auto、两类词表保存重开、连续三次确认、修订到 v4、识别原文展开。桌面 1280×720、窄屏 390×844 检查输入区和固定底栏；没有将合成音频识别、模型候选或翻译输出解释为真实会议准确率验收。

## 未验收

真实多人混语、同音人名歧义、远场/重叠采音、更多语种、其他真实 ASR 账号、多小时双路负载、实体跨版本安装升级及 PG/S3 都未验证。候选仍需人工核听，不把模型建议当成真实姓名或事实。供应商收费与长会话延迟不由本次短样本证明。

## 发布说明格式修复

v0.1.33 已推送后发现缺少发布器要求的 `## 版本改动与修复` 标题。新增当前版本安装说明契约回归，针对旧说明先复现失败，再补齐 v0.1.34 文档。保留 v0.1.33 标签，不移动远端历史；v0.1.34 重新由后台构建。该调整只涉及版本说明、版本配置与发布前测试，不改变已验证的转录/翻译实现。

另补跑真实闭环：虚构日语合成音频经 durable ACK、封存、内置识别保存到片段，得到 `languageDetection.language=ja`、原音批次范围和模型版本；现有翻译 worker 按 en 完成英文译文，其中保留“不要删除原始录音”的否定。所有音频包完成处理，无真实音频设备或会议参与。

并发版本集成：另一任务以 `0bd866140d359f339c40840fa498909f3a67bfda` 创建 v0.1.34，其父提交就是多语种实现 `4cf04206da44f6c155ff5af0a3b10e152da55a1a`。多语种、词表、IPC 和翻译核心文件保持相同；本轮未移动该标签，合并其回放/设置优化，并复用 Actions `40545835150`。额外指南检查与本地验证说明作为同版文档/测试补记，不重打产品标签。

## v0.1.34 公开发布补记

[Release](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.34)；[Actions](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40545835150)；[统一分发回执](preview-v0.1.34-2026-10-28.md)。verify、macOS、Windows、Linux、publish 五项均成功。产品源码为 `0bd866140d359f339c40840fa498909f3a67bfda`，其父提交为本轮多语种实现 `4cf04206da44f6c155ff5af0a3b10e152da55a1a`；v0.1.34 注释标签对象 `984454ed97785976c26db036f4e4ea7f0b75860e`，macOS build `0.1.56`。

下列三个安装包的公开 GitHub 摘要与 `preview-update.json` 对照一致，独立 HEAD 核对了实际下载尺寸；清单源码 SHA 与标签解引用一致，清单本身字节摘要也与公开资产一致。未在本机完整下载这三个新安装包或做实体覆盖安装，不能将摘要/CI 验证描述为实体升级验收。

| 附件 | 字节 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.34-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-macos-arm64.dmg) | 218389148 | `e0f71d8dd0488e7d13f85ae20c4657e8789d3ba7c09f2b3599835b90e7d405fa` |
| [Lingji-0.1.34-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-windows-x64-setup.exe) | 407133207 | `e262d5d06cf7e1890b3f82b1241eae2868678535baaceafdb71a6a6f84163906` |
| [Lingji-0.1.34-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.34/Lingji-0.1.34-linux-amd64.deb) | 221485846 | `7c6de047288742d895c481a456d21c07c59dadedaaff1b0e40cdc0718ebe17ff` |
| preview-update.json | 5202 | `ae1182df3cae5c69e4bac672ae533827baa5b9561d68d316cdbc1c36e86e7ef7` |

本地集成加指南契约回归 566/566；产品源 CI 回归 565 项，额外指南契约检查以同版测试补记提交，不改变安装包产品源码。Rust 37 项通过；三平台安装器由现有 Actions 生成发布，未手动上传本地成品。

用户提出的字库方向仍为后续建议：可在现有项目词库之上增加读音索引，Unihan 的普通话/粤语读音数据可作为候选数据源。本版未接入拼音/读音召回，也不对同音人名自动全局替换。
