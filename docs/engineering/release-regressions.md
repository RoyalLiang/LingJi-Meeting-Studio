# 功能冒烟后的发布回归

每次功能修改先执行 `npm run test:smoke`，通过后执行 `npm run test:release-regression`；`npm run verify:feature` 串行完成两步。随后运行完整 Node 回归、lint、Web 类型检查和构建。发布工作流也按这一顺序执行，不能以功能冒烟代替安装包回归。

| 已出现的故障 | 固定回归入口 | 验收边界 |
| --- | --- | --- |
| 已预载录音浮窗不跟随深浅主题、透明窗口出现白底 | `records-theme-sync`、同源双窗口界面检查、原生候选检查 | 初始主题、storage 切换与重置、根节点和原生 WebView 透明；Windows/Linux 客户区随主题更新，Windows 11 标题栏单独配色，Windows 10 与 Linux 系统装饰保留系统主题 |
| 字段标签带状态徽标后输入框错位、页签和标签尺寸不一致 | 逐页深浅主题与窄屏界面检查 | 模型、音频、网络、词表、更新、会议正文、知识与扩展；按钮/标签共用尺寸变量，保留键盘焦点 |
| 状态徽标与长说明挤在同一行，检测按钮挤压内容 | 共享 `ModuleConnectionCheck` 的模型、翻译、飞书、MCP、诊断界面检查 | 深浅主题、1250px/390px、成功短提示同行绘制勾选，减少动效时立即显示；长错误和配置变化仍显示说明 |
| 网络设置移位后统一保存漏掉代理、重复请求或意外清除密码 | `records-settings-save` | 网络→备份→词表→模型顺序；失败停止后续保存并保留草稿；并发去重；空密码保留、显式清除；切页签保留草稿 |
| 商店审核落后于 GitHub 导致官网 Windows 入口退回 EXE，或错误显示测试版号 | `records-site-downloads`、三平台真实页面入口检查 | Store 独立版本、固定官方 ID，macOS/Linux 固定仓库 Release，备用独立包带完整版本；旧同源 HEAD/Range 接口保持可用 |
| 人物停止后在途匹配仍落名、后续学习意外恢复、旧库删除或失败授权留下人物 | `records-local-speakers` | 显式全目录同意与库版本；暂停继承、源引用/留存/账户校验、在途匹配/入库、旧库事务失败、删除残余清理重试；不能由合成向量推导真实识别准确率 |
| 未确认的自动归属成为训练数据，或取消授权后在途任务仍入库 | `records-local-speakers` | 单人明示授权、人工确认且留存的音频、每人每会去重、推理期间撤销的写入护栏 |
| 同麦相似发言生成多余身份，已知重叠发言被自动标名，反复学习同一片段 | `records-local-speakers` | 模糊候选弃权，重叠片段排除自动归属，同一人物同一修订复用样本 |
| 总结卡片错配、飞书人物标签使用错误修订或未经授权的引用 | `records-minutes-summary`、`records-feishu` | 有内容才选择卡片，保留对应证据；冻结发布块和预览一致，关闭引用时省略人物标签 |
| 人物弹窗被通用 760px 规则覆盖，列表状态出现单字换行 | 人物中心深浅色与窄屏界面检查 | 1250px 宽屏弹窗 1120px；390px 无横向溢出；列表、来源和识别设置可滚动访问，状态保持完整词组 |
| 录音状态重复显示聆听／处理说明，隐藏普通说明时误伤封存补传 | `records-meeting-lifecycle`、录音状态合成界面检查 | 逐字动效仅用于正常录音，辅助技术只读一次标题；减少动效设置停用动画；导入进度、暂停／封存补传、转录失败和纪要失败保持可见 |
| 后端嵌套依赖、缺失锁定依赖、可选 peer 被误打包 | `records-backend-dependencies` | 检查真实依赖树与打包闭包 |
| runner 将 GitHub URL 指向尚无新 SHA 的本地镜像，checkout 报 `not our ref` | runner 登记前的固定 SHA 镜像预检（环境门禁） | 先补齐 Git 对象并确认精确 CI ref 可见，再消耗一次性 runner；工作树保持不变 |
| WGS 复用旧产物、源码漂移或平台资源混用 | `records-wgs-build-contract` | 固定 SHA、完整文件摘要与目录锁；两个平台串行 |
| MSIX 固定版本中间目录与旧候选冲突 | WGS 实际候选构建、`records-wgs-build-contract` | Store 包在本次临时输入目录中生成；失败重试前，在锁内核对回执并隔离保留不完整输出，不覆盖旧候选 |
| 候选改为 SHA 目录后 Linux 收集器仍读取旧路径 | `records-wgs-build-contract` | 直接从隔离目录收集，不复制到旧目录掩盖错误；Windows/macOS 默认输入保持可用 |
| MSIX 任务栏图标出现系统底板或带底色的缩略图 | `records-windows-msix`、候选原包校验 | 透明素材、主题与像素规格、MakePri 索引与同源码摘要；Windows 实际图标选取需独立验收 |
| MakePri 全新输出目录不存在，或 WGS 从 GitHub Blob 获取图标产物重试耗尽 | `records-windows-msix`、Windows MakePri 与 WGS 资源恢复步骤 | 从空目录生成图标；作业输出分块传递，拒绝缺块、不同源码及篡改资源 |
| MSIX 包内 Fixed WebView2 无法从 WindowsApps 启动、缓存不完整 | `records-windows-msix`、`test-windows-msix.ps1` | 临时签名副本安装，正常 AUMID 冷启动及再次启动，验证真实 WebView 进程与缓存摘要 |
| Windows 首次绑定回环端口返回 Winsock 10013 | Rust `config::tests`、Windows 隐藏录音与重启回放 | 初次分配绕过系统保留或独占端口，记录既有 WebView 来源后沿用同一端口和离线队列 |
| 包内后端、模型路径与用户数据位置混淆 | `records-desktop-entry`、原生测试、Windows MSIX 脚本 | 包内后台启动及只读本地模型推理；不以文件存在代替运行 |
| Windows 音频落盘刷新方式不兼容 | `records-audio-storage-sync` | Windows 文件刷新与 POSIX 目录屏障分别检查 |
| 后台冷启动测试的10秒预算短于原生客户端15秒预算 | `records-desktop-entry`、原生启动与安装验证 | 测试握手对齐实际15秒上限，健康/父管道EOF退出断言保持；上游测试失败造成缺包时先定位首个失败 |
| 隐藏目录的验证证据未上传、混淆源 SHA 与工作流 SHA | `records-preview-release`、平台 artifact 上传 | 隐藏证据显式保留；源码、运行、产物与摘要一致 |
| 官网下载 503、旧脚本缓存、HEAD/Range 行为退化 | `records-site-downloads`、`records-site-download-upload` | 本地合约后，发布后单独核对 API 元数据与公网行为 |
| OSS 大文件 PUT 超时、响应丢失而服务端可能已提交 | `records-site-download-upload` | 同版本重跑先核对既有对象，不覆盖；三平台全部验证后才更新 current.json 清单 |
| GitHub 附件获取中断，已有平台上传但清单未切换 | `records-site-download-upload` | 保留上一完整清单；同版本重跑核验既有对象，不覆盖附件、不移动标签 |
| 四段修订被旧解析器忽略、按字符串比较或重复编码 | `records-preview-version`、`records-site-download-upload`、Rust preview updater 测试 | 旧三段补零；`.9 → .10`；native 与 MSIX 单调；macOS 交接身份与版本；OSS 四段升级及禁止降级 |

三平台构建、Windows NSIS 与 MSIX、Ubuntu 22.04/24.04、macOS 原生检查在 Actions 中执行。推送 main 的代码改动会自动对固定 SHA 运行候选验证；也可用 `preview-release.yml` 的 `publish=false`、计划版本和固定 `source_sha` 手动验证，无需预建 tag；全部检查成功后才创建不可变 tag 并发布。候选成功不等于已经发布或商店审核通过。

macOS Apple Silicon 托管 runner 容量不足时，核对作业没有开始执行以及 GitHub 给出的取消原因。重试同一流水中受影响的作业，保留已通过的校验和既有候选版本。

同源码候选已通过，正式 Windows 验证因探针超时或进程挂起中止时，记录首个失败步骤，重跑 Windows 验证及发布下游。重试沿用同一标签、WGS 原产物和其他平台的成功结果。

公开版本从兼容过渡版之后使用 `X.Y.Z.R`，修订号 R 为 0–99。npm/Cargo/Tauri 和安装器采用合法三段版本 `X.Y.(Z*100+R)`；MSIX 为 `(X+1).Y.(Z*100+R).0`，编码后的 patch 不超过 65535。根 `package.json.releaseVersion`、Rust `product-version.txt` 与对外标签、文件名、说明使用同一产品版本；工具链配置和包内部版本使用 native 映射。旧三段版本保留原义，不重新编码已发布包。

v0.3.34 是一次兼容过渡版，使现有只识别三段 tag 的客户端获得新版解析器；其后的修补从 v0.3.34.1 开始，不移动旧标签。普通签名客户端的 Tauri `latest.json` 仍使用合法 SemVer，不能把四段产品号直接放进该清单。

真实 PostgreSQL/S3、声卡与供应商验收单独留证。公开附件发布后仅核对 Actions/API 中的名称、大小和摘要；未另行要求时不下载、解包或安装复测。

## WGS checkout 输入预检

当 runner 的 Git URL 重写指向 WGS 当前源码库时，工作流检出发生在构建脚本之前。仅准备本地文件或确认 GitHub main 已推送还不够；登记一次性 runner 前，必须确认 `refs/remotes/ci-input/<固定源码SHA>` 已在该库发布，`git ls-remote` 返回的提交正好等于固定 SHA。缺失时停止登记，避免消耗单次 runner。

在目录锁内以非强制 Git push 补齐对应对象和专用 CI ref，不切换工作树、不重置既有改动、不创建每版源码目录。补齐后再核对工作树 HEAD 与修改状态未变，并重新执行上述预检。该远端环境检查跟在本地功能/发布回归之后；它不能由本机合成测试替代。

归档回归覆盖压缩帧原样保留、重复静音去重、十分钟边界、摘要引用重启读取及清理；归档前后比较实际字节量，避免减少小文件时反而放大存储。WGS 回归同时覆盖同产品号不同源码 SHA 的候选目录隔离与同 SHA 的完整回执复用。

WGS 已完成 Linux、尚未完成 Windows 时，不能把部分目录冒充完整可复用产物。恢复前停止对应构建、取得目录锁，核对版本、固定源码 SHA 与干净工作树；将已知不完整输出及冲突的旧 Store 中间目录原样移动到 `.agent-runtime/build-attempts/` 保留回执后，重试同一候选。未知目录或不匹配的回执应停止处理。

商店说明以实际已上架包为准，中英文维护在 [商店文案](../releases/microsoft-store-listings.json)。发行说明每项只写“新增／修复”（Added／Fixed）的功能行为，不列视觉、排版、胶囊或配色调整；AI 能力、服务配置与反馈边界保留在完整介绍中。更新说明不代表已上传新安装包或审核通过。
