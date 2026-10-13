# 客户端本地存储与音频压缩调研

核查日期：2026-10-13。本文是基于官方文档的一手资料研究与设计建议，不代表迁移、客户端独立后台或真实录音压缩已完成。运行与打包证据需要由实现阶段补充。

## 建议

继续使用 **SQLite 作为单用户客户端的主事务库，音频保留为独立的不可变分段文件**。保持 WAL 与 `synchronous=FULL` 的持久化边界，由客户端自带的后台统一拥有写入与恢复；UI 通过本地 IPC/API 使用数据。优先消除整场 JSON 重写、base64 队列和无界内存积压，再实测压缩算法。这个建议针对录音、逐段转录、纪要版本、补传和人工编辑的小事务工作负载，不是跨所有工作负载的数据库排名。

SQLite 已提供 SQL、事务、约束与 FTS5；WAL 支持同机多进程读写，但同一时刻只有一个 writer。DuckDB 的官方定位是 OLAP，LMDB 与 RocksDB 的主要接口是键值访问。由此推断，保留 SQLite 能最少改动地承接现有领域与恢复语义；目前没有证据说明换引擎比改变数据布局更有效。[SQLite WAL](https://www.sqlite.org/wal.html)、[SQLite FTS5](https://www.sqlite.org/fts5.html)、[DuckDB 定位](https://duckdb.org/why_duckdb)、[LMDB 官方接口介绍](https://raw.githubusercontent.com/LMDB/lmdb/mdb.master/libraries/liblmdb/intro.doc)、[RocksDB README](https://github.com/facebook/rocksdb)

音频建议分两步：当前可靠链路先保留 PCM 或现有无损 deflate；后续对已封口分段评估 FLAC。Opus 仅作为明确允许有损的播放/传输派生副本候选，不直接替换唯一原音。文本冷快照可评估 zstd，热数据与搜索索引保持可直接查询。

## 当前项目事实与研究边界

以下源码现状由主任务提供，本文没有把它重新解释为运行证据：Record API 使用 SQLite WAL/FULL，`records` 表保存整个 Record JSON；PCM 音频独立文件保存；Web IndexedDB 保存 base64 音频补传队列，上限 48 MiB；Tauri 当前代理外部 API。这些事实与[当前实现与验证边界](../engineering/current-state.md)记录的 SQLite/文件、IndexedDB 和开发后台边界相符。本文不读取用户录音，不运行迁移，不修改现有数据。

需要优化的对象是两类成本：音频字节及其编码/拷贝成本，以及转录增长时聚合 JSON 的序列化和重写成本。单纯启用数据库页压缩或替换数据库，不能自动消除这两类成本。该判断是基于上述布局的工程推断，尚未测得客户端磁盘写入量、CPU、峰值内存与压缩比。

## 数据库选择

| 引擎 | 官方能力与约束 | 对本项目的判断 |
| --- | --- | --- |
| SQLite | WAL 可让读者与 writer 并行，仍只有一个 writer；同机共享内存与文件锁要求使 WAL 不适合网络文件系统。`FULL` 在 WAL 下提供 ACID；FTS5 提供全文索引。[WAL](https://www.sqlite.org/wal.html)、[synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)、[FTS5](https://www.sqlite.org/fts5.html) | 首选主库。事务中同时提交分段元数据、幂等身份、补传状态和版本引用；让后台安排短事务与 checkpoint。不要将正在使用的库放进 NAS 或云盘同步目录。 |
| DuckDB | 面向列式、向量化 OLAP 与批量优化 MVCC；in-process 模式由一个进程读写，或多个进程只读。当前已有 Quack 客户端/服务端路线，但官方标为 beta，协议等仍可能变化。[定位](https://duckdb.org/why_duckdb)、[并发](https://duckdb.org/docs/current/connect/concurrency)、[Quack](https://duckdb.org/docs/current/quack/overview) | 适合以后从快照或导出数据做跨会议统计/分析。没有理由为当前录音小事务主库引入第二套引擎或 beta 协议。不能笼统说 DuckDB “完全不支持多进程”。 |
| LMDB | memory-mapped 键值库，读取通常可零拷贝；多个只读事务与一个写事务共存。长期读事务会保留旧版本占用空间，同进程不得重复打开同一环境。[官方介绍](https://raw.githubusercontent.com/LMDB/lmdb/mdb.master/libraries/liblmdb/intro.doc) | 适合键值缓存或索引专用用途。录音状态、转录版本、纪要引用、筛选与全文搜索要自行维护更多键、索引和迁移逻辑，当前收益未证实。 |
| RocksDB | LSM 键值引擎，面向多核与快速存储；支持压缩，官方建议可在底层采用 zstd。同一库的普通读写实例受文件锁约束，并不是让多个后台独立开库写入的替代方案。[README](https://github.com/facebook/rocksdb)、[压缩](https://github.com/facebook/rocksdb/wiki/Compression)、[DB::Open 官方接口](https://github.com/facebook/rocksdb/blob/main/include/rocksdb/db.h) | 适合大规模持续写入的键值系统；compaction、缓存、索引与原生依赖增加客户端调优和发行成本。未测得 SQLite 写入成为瓶颈前，不建议迁移。 |

表中“适合/不建议”是本项目的设计判断，并非官方产品对比结论，也没有用其他项目的 benchmark 代替本项目测试。

## SQLite 的版本与运行条件

### 必须核对实际内嵌版本

SQLite 官方于 2026 年披露 WAL-reset bug：约影响 3.7.0 至 3.51.2；**3.51.3 及后续版本已修复，3.44.6 与 3.50.7 有回补**。触发需要同库至少两个连接位于不同线程或进程，并在特定时序下并发写入与 checkpoint；概率低，但可能损坏数据库。因此独立后台发行基线应使用修复版本，不应仅记录“用了 WAL”。[SQLite WAL-reset 官方说明](https://www.sqlite.org/wal.html#walreset)

截至核查日，Node 官方支持的 LTS 大版本为 24 与 22，26 仍为 Current。官方发布索引对应的最新补丁为 24.21.0（2026-09-07）、22.23.3（2026-09-23）；固定标签源码分别内嵌 SQLite **3.53.4** 与 **3.51.3**，均跨过上述修复门槛。这不证明本地开发机、打包 sidecar 或发行包使用这些版本。[Node 发布状态](https://nodejs.org/en/about/previous-releases)、[官方版本索引](https://nodejs.org/download/release/index.json)、[24.21.0 SQLite 头文件](https://github.com/nodejs/node/blob/v24.21.0/deps/sqlite/sqlite3.h)、[22.23.3 SQLite 头文件](https://github.com/nodejs/node/blob/v22.23.3/deps/sqlite/sqlite3.h)

若首阶段复用 Node 后台，优先固定当前 24 LTS 的经验证补丁，并将 Node 与后台一起打包。`node:sqlite` 在 24.21.0 仍是 1.2 / release candidate；`DatabaseSync` 与 `StatementSync` 是同步 API。应保持采集线程隔离，避免在 UI 或音频回调里执行同步 SQL、大 JSON 序列化与压缩。[固定版本 Node SQLite API](https://github.com/nodejs/node/blob/v24.21.0/doc/api/sqlite.md)

发行包启动自检建议保存 `process.version`、`SELECT sqlite_version(), sqlite_source_id()`、`PRAGMA journal_mode`、`PRAGMA synchronous` 与 `PRAGMA compile_options` 的非敏感结果；直接创建临时 FTS5 表验证功能，而不只凭版本号假定可用。若最终是 Rust 内嵌 SQLite，同样应检查实际链接/捆绑版本，Node 上述版本不再作为该库的证据。

### WAL/FULL 的使用建议

- 在每个写连接初始化时明确设置 `synchronous=FULL`、忙等待上限与外键约束；检查 `journal_mode` 返回值确实为 WAL。WAL 模式会持久化，但其他配置不能因此省略。[SQLite pragmas](https://www.sqlite.org/pragma.html)
- 默认保留 `FULL`。WAL + `NORMAL` 能维持一致性，但已提交事务在断电/硬重启后可能回滚；它不满足“持久化确认后才能删补传”的同等承诺。`FULL` 仍依赖系统与设备正确执行持久化操作。[SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
- 写事务短小，避免跨网络请求、ASR/LLM 调用或整个录音会话持有事务。将后台作为逻辑上的写入入口；多个进程连接并非本身不安全，单入口能降低写竞争与生命周期复杂度。[WAL 并发条件](https://www.sqlite.org/wal.html)
- 监测 WAL 大小、checkpoint 耗时与 busy 次数。长读事务可能阻止 checkpoint 前进；自动 checkpoint 也会使部分提交较慢。先保留默认，再用真实负载决定是否在空闲时由后台做 PASSIVE checkpoint，不在每个音频包后强制 TRUNCATE。[WAL checkpoint](https://www.sqlite.org/wal.html#ckpt)
- 活跃 WAL 是数据库持久状态的一部分，不能只复制 `.db` 作为备份。数据库使用 SQLite backup API 或受控快照；独立音频还要一起保存对应 manifest 与文件集合。[WAL 文件生命周期](https://www.sqlite.org/wal.html#the_wal_file)、[SQLite backup API](https://www.sqlite.org/backup.html)

### 数据布局比替换引擎优先

建议逐步将热数据拆为 Record 元数据、Session/Source、音频 chunk manifest、转录 segment/revision、纪要 revision/来源引用、outbox/补传状态和有序事件。主键继续包含现协议的 `record/session/source/epoch/sequence`，样本定位与幂等身份不能随压缩改变。每个新片段仅写相关行；聚合 Record JSON 作为读取投影或低频快照，冷快照可以压缩。迁移应另行设计并保留恢复路径，此处不宣称已实施。

FTS5 可索引转录与纪要的当前可搜索文本，避免把所有版本重复纳入结果。external-content 表可复用正文，但必须在同一事务维护索引或用触发器并提供 rebuild；原文压成不可查询 blob 后，全文搜索不会自动生效。[FTS5 external-content](https://www.sqlite.org/fts5.html#external_content_tables)

中文搜索要单独验收：默认 unicode61 将连续字母/数字字符视为 token，并不是中文词语分词器；trigram 可做子串检索，但少于三个 Unicode 字符的全文查询不匹配。由此推断，常见两字中文词需要专门的分词/索引方案或小范围回退查询，不能把“启用 FTS5”写成“中文搜索已解决”。[FTS5 tokenizers](https://www.sqlite.org/fts5.html#tokenizers)

## 音频 BLOB 与独立分段文件

SQLite 官方测量说明小 BLOB 可以优于独立文件，不能声称“大文件永远更快”或直接套用一个普适大小阈值；其结果受页大小、数据大小、缓存和测试平台影响。[SQLite 内外部 BLOB 测量](https://www.sqlite.org/intern-v-extern-blob.html)

本项目仍建议独立音频段，理由是生命周期：音频封口后不可变，可顺序传输、逐段校验、按策略保留和删除；数据库只更新状态与引用。这样也避免音频内容进入事务页的 WAL/checkpoint 与数据库快照。代价是数据库和文件不能通过一个 SQLite 事务实现跨资源原子提交，必须有明确恢复协议。该取舍是工程建议，性能优劣需要实测。

建议文件提交顺序为：写临时文件 → 完成字节数/摘要校验 → 持久化并原子改名 → 按目标平台落实目录持久化 → 数据库事务登记 final manifest 与 durable 状态 → 返回持久化确认。重启扫描识别临时/孤儿文件和丢失引用，按身份与摘要幂等恢复；不能把“SQLite commit 成功”直接当成音频文件已可靠落盘。备份时先确定一致的 manifest 代次，再收集被其引用的不可变文件。

分段长度不宜仅为提高压缩率无限增长：段越长，封口延迟、崩溃未封口损失窗口与重传粒度越大；段越短，文件数量、元数据与 fsync 成本越高。保留协议中的样本 offset 与连续性，按现有包长和数个聚合段长做对照测量后再定值。

## 压缩的无损边界

| 方法 | 保留什么 | 建议用途与边界 |
| --- | --- | --- |
| zstd | 通用字节无损压缩；支持速度/压缩率档位与字典。[官方项目](https://github.com/facebook/zstd) | 评估重复结构明显的冷 JSON、历史快照和文本批次。先压缩二进制/UTF-8，再存储；字典必须版本化并随数据可恢复。没有本项目数据时不承诺优于 deflate 的具体比例。 |
| deflate / zlib | 通用字节无损压缩；deflate 是算法，zlib/gzip 是不同封装。[zlib 官方说明](https://www.zlib.net/) | 适合作为已有链路的保守基线。协议明确 codec、封装、未压缩长度与解压限制；对已压缩音频重复压缩的收益不得假定。 |
| FLAC | 音频样本无损，针对 PCM 建模与残差编码。[FLAC 官方介绍](https://xiph.org/flac/index.html)、[格式概览](https://xiph.org/flac/documentation_format_overview.html) | 评估已封口原音归档与供应商支持的传输。相对送入编码器的 PCM 可无损；若此前已降采样、混声或 float→int 量化，FLAC 无法恢复此前信息。两个音源不要为压缩便利混成一轨。 |
| Opus | 面向语音/音乐的音频编码，含有量化与感知误差，并非字节或样本无损。[RFC 6716](https://www.rfc-editor.org/rfc/rfc6716.html)、[Opus 官方能力](https://opus-codec.org/) | 仅作为允许有损的派生播放/传输候选。音质“听起来没差”不能证明 ASR、说话人区分或后续模型效果不变；需分别测质量。不要把 Opus 副本标为唯一原音。 |

移除 base64 可以得到确定的编码开销收益：base64 每三个输入字节编码为四个字符，通常为 `4 * ceil(n / 3)` 字节，而不是压缩。原生补传队列应保存二进制文件加 manifest；Web 分支可评估 Blob/ArrayBuffer，不必为兼容 JSON 把本地持久化也做成 base64。这是编码数学关系，不是录音压缩率测试结果，也不等同于字符串在 JS 引擎里的精确内存占用。[RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648.html#section-4)

压缩工作应离开实时采集回调，使用有界队列与后台任务；旧段成功解压/回读并验证摘要后，再改变本地存储表示。确认、重传与摘要需明确基于规范化原始内容还是压缩容器字节，codec 参数变更不能导致同一音频身份被误判为新内容。

## 分发许可

SQLite 核心代码与文档是 public domain；Node 自身采用 MIT 条款，并在发行 LICENSE 中列出其捆绑依赖的条款。将 Node sidecar 随客户端分发时应随包保留该固定版本完整 LICENSE 与第三方 notices，而非只附一行“SQLite 免费”。[SQLite copyright](https://www.sqlite.org/copyright.html)、[Node 24.21.0 完整 LICENSE](https://github.com/nodejs/node/blob/v24.21.0/LICENSE)

选型还应保留所用实现对应的许可：DuckDB 为 MIT；RocksDB 可选择 Apache 2.0 或 GPLv2；zstd 为 BSD 或 GPLv2；FLAC 的库采用 BSD 类条款、命令行程序采用 GPL，直接捆绑工具与链接库需要分别看待。本文建议优先使用适合客户端分发的库与相应许可路径，具体以打包依赖清单为准。[DuckDB](https://duckdb.org/why_duckdb)、[RocksDB](https://github.com/facebook/rocksdb)、[zstd](https://github.com/facebook/zstd)、[FLAC 许可](https://xiph.org/flac/license.html)

## 实现前后应补的证据

1. **独立运行**：在没有 Web dev、没有全局 Node、没有预先启动 API/worker 的干净环境启动发行包；离线录音、暂停继续、结束排空、退出重启、补传与本地阅读都能恢复。验证监听地址、应用数据目录和后台单实例，不以开发联调代替安装验证。
2. **持久化故障**：分别在文件写入、改名、DB commit、ACK 与上传删除前后终止进程；验证已确认数据、去重、缺段、尾段和转录版本。进程 kill 不能代替断电测试，`FULL` 也不能替代文件层恢复测试。
3. **布局对照**：用同一匿名/合成数据与固定硬件比较整场 JSON、分行事务与低频快照；记录 1/4/8 小时会话的提交 p50/p95/p99、恢复时间、峰值 RSS、DB/WAL/文件字节、实际磁盘写入量和 busy 次数。数据来自测试时必须明确标记，不能充当真实会议证据。
4. **压缩对照**：同一段单源/双源 PCM，比较原始、deflate、zstd 与 FLAC；同时记录字节数、编码/解码时间、CPU、峰值内存、首次可上传时间和原样回读校验。对 Opus 另测 ASR/术语/说话人质量，并由产品确认是否允许有损。静音与噪声分别纳入，不预先写压缩比。
5. **搜索与发行**：验证中文两字词、术语、中英混合、手工修订与版本引用；三个目标平台检查实际 SQLite 版本、FTS5、文件持久化、后台退出/重启、备份恢复和第三方 notices。当前官方源码版本表只是发行选择依据。

建议实施顺序：先让客户端自带并管理后台与数据目录；再完成二进制补传与热数据小事务；最后依据上述测量决定 FLAC、zstd、索引和归档策略。除非测量显示 SQLite 引擎本身已是主要瓶颈，否则保持主库不变。
