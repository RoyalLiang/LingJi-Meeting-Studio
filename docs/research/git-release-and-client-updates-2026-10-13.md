# GitHub 发版与 Tauri 客户端自动更新研究

核查与访问日期：2026-10-13。状态：一手资料研究与实施建议，不是发布验收。用户已选择 **GitHub Releases**；客户端方向为 **Tauri 2 + Rust + 内置 React**，桌面覆盖 macOS/Windows/Linux，手机保持 Web。

## 结论

推荐链路是 **已验证提交 → 签名版本 tag → GitHub Actions 多平台构建 → OS 签名/公证与 updater 签名 → 完整 draft release → 验证并发布 → Tauri 检查/下载 → 音频安全边界内安装重启**。客户端消费签名安装制品与更新端点，不通过 `git pull` 更新应用。

自动更新应分成三个开关与状态：自动检查、自动下载、安全时自动安装。**录制、暂停待继续、停止尾包排空及未确认补传期间，可以检查/有预算地下载，不得自动安装、退出或重启。** 下载完成不是音频安全退出的证据；Tauri 不替项目完成队列兼容、会话封口或自动回滚。

## 一、当前证据与范围

- 本轮只读核查时，`git remote`/`git remote -v` 均无结果，GitHub owner/repo 与公开性仍未配置；没有远程推送、创建 release 或分发制品。
- [原生客户端说明](../engineering/native-client.md) 与 [ADR 0011](../adr/0011-native-desktop-client.md) 已描述原生音频、内置 Web、稳定本机 Origin/端口与独立 IndexedDB。**原生基础本轮已实现；尚无 updater 插件、检查/下载安装或自动重启功能。** 签名分发与真实更新仍待实现和验收。
- 本文核实的是官方接口/发布语义。更新安装成功、三系统升级、真实音频与补传无损、OS 信任、GitHub/镜像网络可达性均须另出验收证据。

本文范围是应用程序更新；模型下载/AI 策略继续使用独立制品与版本通道，不与应用 updater 混用 release tag。

## 二、Git tag、版本与不可变制品

**官方事实。** Git 的 annotated tag 保存 tagger、日期与说明；`git tag -s` 创建带密码学签名的 tag，`git tag -v` 验证。轻量 tag 面向临时标记，annotated tag 更适合 release。Git 本身允许强制替换 tag，因此“用了 tag”不等于不可变。[Git tag](https://git-scm.com/docs/git-tag)

**建议。** 使用 `v1.2.0` / `v1.3.0-rc.1` 命名 release tag；程序内部与 manifest 使用规范 SemVer `1.2.0` / `1.3.0-rc.1`。CI 校验 tag、Tauri/package/Cargo 版本一致，固定 commit、锁文件、Rust/Node/构建工具版本，并从该 tag 构建；禁止从脏工作树或浮动分支发布。示例版本不代表本项目当前版本。

```sh
# 发布人的示例流程；verified-commit 与版本由本次验收确定
git tag -s v1.2.0 verified-commit -F release-notes.txt
git verify-tag v1.2.0
git push origin refs/tags/v1.2.0
```

CI 验证签名还需明确可信 signer 公钥/允许列表，不能只检查“存在签名”。发布过的 tag 和二进制不得同名覆盖；修复使用新 patch 版本。每个制品记录 tag、commit、平台/架构/安装格式、SHA-256、字节数、构建环境、签名结果与测试报告。Git 签名证明源码标记来源，不代替安装包签名。[SemVer](https://semver.org/)

GitHub immutable releases 会锁定已发布 release 的资产与 tag；官方建议先创建 draft、附齐资产再 publish。关联 tag 在 release 存续时不能移动/删除，资产不能补传或替换；该功能需要仓库实际启用。tag ruleset 则可以约束版本 tag 的创建、更新、删除与 bypass 身份，套餐/仓库可见性影响可用性。[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)、[管理 release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[tag ruleset 规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

**建议发布顺序：** 创建/验证 tag → 构建全部目标 → 上传 draft → 验证资产集合、签名和 manifest → publish 一次。一个平台失败时保留 draft，修复后完成同次候选构建；不能先发布不完整 manifest，再期望所有旧客户端遇到更新都成功。

## 三、GitHub Actions 与 tauri-action

**官方事实。** 访问时 tauri-action README 使用 `tauri-apps/tauri-action@v1`，支持 `projectPath`、`tagName`、`releaseId`、`releaseDraft`、`prerelease` 与 updater JSON。提供 `releaseId` 却缺少 `tagName` 时，`latest.json` 内部包 URL 可能指向 `releases/latest/download`；显式 tag 可绑定版本路径。[tauri-action](https://github.com/tauri-apps/tauri-action)

**建议的 CI 分工：**

| Job | 输入与职责 | 所需权限/退出条件 |
| --- | --- | --- |
| verify | 验证 tag/commit/版本/锁文件，运行 Node、Web 与 Rust 检查 | 默认 `contents: read`；通过后才允许签名构建 |
| build matrix | macOS aarch64/x86_64、Windows x86_64、Linux x86_64；其他架构经需求确认再加入。安装目标所需原生依赖，构建并签名 | 固定 runner 镜像/工具链；每个目标产出安装制品、`.sig`、hash 与验证报告 |
| aggregate | 汇总所有平台资产，生成一个完整 `latest.json`，核对缺项、重复键、版本、签名与 tag URL | 单一汇总者；矩阵 job 不并发决定最终通道指针 |
| publish | 上传/核查 draft，执行发布与通道切换 | 仅该 job 获得必要的 `contents: write`，通过受控 environment/发布策略后运行 |

对现有 monorepo 显式配置桌面项目路径与项目内 Tauri CLI；使用 `npm ci` 与已锁定 Cargo 依赖。安装器/音频 native 依赖与系统版本属于矩阵的一部分，macOS/Windows/Linux “编译成功”不能替代各平台安装启动。Windows ARM、Linux ARM 与 macOS universal 是额外目标，不因上游支持而默认承诺。

GitHub 官方建议令 `GITHUB_TOKEN` 默认只读、按 job 最小授权，并将外部 action 固定为完整 commit SHA；`@v1` 是官方示例的版本入口，生产工作流仍应固定核实过的 SHA并定期更新。签名 secret 仅对可信发布事件/目标开放，不能注入不可信 PR；缓存和 Actions artifacts 不能作为最终长期分发地址。[Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)、[GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)

**draft、prerelease 与 promote。** GitHub latest release 不包括 draft/prerelease，stable 客户端不能用 `/releases/latest` 获取测试通道。[Releases API](https://docs.github.com/en/rest/releases/releases)

建议稳定版候选在 draft 中验证后发布同一组制品；RC 使用独立 prerelease tag/程序版本。`1.2.0-rc.1` 改 release 的 prerelease 标志不会把已构建程序变成 `1.2.0`，最终版本必须按正确版本重新构建、签名与验收。若采用同一程序版本先发布测试通道再提升 stable，须提前设计同版本通道切换语义，不能依靠默认“大于当前版本”触发安装。

## 四、Tauri updater：已核实的接口边界

| 项目 | 官方事实 | 项目建议 |
| --- | --- | --- |
| 签名 | updater 必须校验更新签名；公钥内置配置、私钥用于签制品。签名不是 URL 文件路径 | 对最终上传的原字节验签；不要在签完后修改安装包 |
| 端点 | 支持静态 JSON 和动态服务；配置可使用 target/arch/current_version。生产默认 TLS；动态无更新返回 204，有更新返回 200 JSON | 首版用完整静态 JSON；设置超时/退避，不把 404/HTML/畸形 JSON 当“无更新” |
| 静态 JSON | `version`、`platforms` 下匹配项的 `url`、`signature` 必需；`notes`、RFC3339 `pub_date` 可选 | 缺任一支持目标即拒绝发布；asset URL 使用 `releases/download/<tag>/<asset>` |
| 默认键 | 文档基本键为 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`、`linux-x86_64` 等；custom target 必须与 manifest 键一致 | 不把 Rust target triple、`arm64`、`macos` 与默认 updater 键混用 |

以上接口依据：[Tauri updater guide](https://v2.tauri.app/plugin/updater/)。实际工具版本须固定；备用端点在不同 HTTP/JSON 错误下的切换行为应按固定版本测试，不能假设所有错误都自动使用下一个镜像。

**Windows。** `passive` 有进度窗口、无需用户交互完成；`basicUi` 需要交互；`quiet` 无进度且不能自行请求管理员权限。安装模式不改变录音保护义务。updater 的 `install()`/`downloadAndInstall()` 会在成功启动 Windows 安装器后退出应用；macOS/Linux 安装后需要 relaunch 才运行新版本。[Windows 模式配置源码](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/src/config.rs)、[Updater JS API](https://v2.tauri.app/reference/javascript/updater/)

**安装守卫位置。** 应先调用 check/download，安全条件成立后才调用 install；不能先 `downloadAndInstall()` 再考虑停止录制，也不能指望 Windows 普通窗口关闭事件完成异步尾包排空。`on_before_exit` 是补充通知/清理点，不代替安装前的持久化屏障。[Updater Rust API](https://docs.rs/tauri-plugin-updater/latest/tauri_plugin_updater/struct.UpdaterBuilder.html)

**Linux 格式。** 官方较新的 changelog 已加入 Deb/Rpm/AppImage 支持，而基础教程仍主要展示 AppImage。当前 v2 源码在未指定 custom target 时优先匹配 `{os}-{arch}-{installer}`，再回退 `{os}-{arch}`；同一 Linux 架构存在多格式时不能用一个基础键随意指向某个安装器。[updater changelog](https://v2.tauri.app/release/updater/)、[updater 源码](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/src/updater.rs)

建议首轮明确以 AppImage 验证客户端自更新，deb/rpm 暂按安装包/包管理分发；这是缩小验收范围，不是宣称新插件不支持 deb/rpm。AppImage 应验证实际启动路径、文件替换权限、只读目录、运行依赖、旧版本保留与 relaunch；不同安装格式、版本的包不能互换。若启用新格式匹配键，必须锁定支持该能力的插件版本，并将测试安装格式带入 manifest 生成过程。

**版本与回退。** 默认仅在远端 SemVer 大于当前版本时返回更新；降级必须显式配置 comparator。`1.2.0+build.2` 的 build metadata 不提高 SemVer precedence，因此补救版本用 `1.2.1`，不能只改 `+build`。自动健康回滚和数据迁移回滚不是 updater 交付的内建承诺。[Tauri 版本比较](https://v2.tauri.app/plugin/updater/#allowing-downgrades)、[SemVer precedence](https://semver.org/)

## 五、静态端点、私有仓库与动态服务

| 方式 | 适合场景 | 代价与验收 |
| --- | --- | --- |
| GitHub public release + `releases/latest/download/latest.json` | 首版单 stable 通道、所有支持平台每个 release 均完整 | 简单，但 latest 是浮动入口；不得让无客户端资产的其他 release 夺走 latest；prerelease 不会进入 stable |
| GitHub release + 独立静态通道 JSON/CDN | stable/beta 分离、GitHub 网络需镜像 | 通道指针可变、制品不可变；汇总校验后原子替换通道 JSON，设短缓存/重验证，按 hash/签名镜像原字节 |
| 动态更新服务 | 灰度 cohort、最低支持版、平台/安装格式选择、鉴权与审计 | 多一个运行服务；显式实现 204/200、缓存策略、撤回/回退、故障与旧客户端兼容 |

客户端应把 GitHub release tag 资产地址绑定在 manifest 内，不能让“版本 1.2.0 的 manifest”下载“随 latest 改变的安装包”。beta 不应让用户手改任意 URL；由预设通道和受控端点提供。静态发布不自动具备分组灰度或客户端健康回滚。

**私有仓库事实。** GitHub release/asset API 只有公开资源可匿名获取；私有资源需要适当 `Contents: read` 等凭证。[Release assets API](https://docs.github.com/en/rest/releases/assets)

若源码私有但安装包可以公开，推荐独立公开分发仓库或对象存储/CDN，不将源码 PAT 或仓库级 token 内置客户端。若安装包也私有，使用后端/分发网关保管 GitHub 凭证，为已授权终端提供短期下载地址或受限会话。发布到另一个仓库时，Actions 内建 token 的仓库作用域要单独验证，必要时使用限权 GitHub App；不能把所需发布 token 转给客户端。

**网络边界。** 国内和企业代理的 GitHub API/下载域名可达性、重定向、证书链、超时和大包中断需要真实网络测试。可增加可信镜像，但保持原制品、签名、版本和 hash；镜像落后或缺平台时应明确失败或留在旧版本，不能静默下载不匹配包。是否断点续传、下载内容是否跨重启保留，应按固定插件与应用封装验证，不能从“支持自动下载”推出。

## 六、四类签名与密钥管理

| 信任链 | 证明/作用 | 不代替什么 |
| --- | --- | --- |
| Git signed tag | 发布源码标记与 signer | 不证明安装包来自该构建 |
| GitHub release/构建证明与资产 hash | tag、构建、资产的可追溯性；immutable release 保护发布资产 | hash 本身不建立发布者身份；平台证明不等于 OS 信任 |
| Tauri updater 签名 | 客户端以预置公钥校验更新制品 | 不等于 Windows Authenticode / Apple Developer ID |
| OS 代码签名/公证 | 平台安装信任与分发要求 | 不替代 updater 端点、版本与队列安全 |

macOS 自分发涉及 Developer ID 代码签名与公证；Windows 代码签名与 SmartScreen 信誉需单独验收。Linux AppImage 更新签名不能被说成已获得某个系统信任机制。[Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)、[Windows signing](https://v2.tauri.app/distribute/sign/windows/)

建议 updater 私钥、OS 证书/公证凭证、Git tag signer 与发布权限分开；CI secret 使用最小范围、备份/恢复和轮换记录，构建日志/制品均不得包含私钥。Tauri 公钥必须稳定植入旧客户端；丢失 updater 私钥会影响既有用户后续更新，不能直接换公钥并声称旧客户端可无缝升级。轮换须在旧 key 可用期间发布桥接版本，并验旧→桥接→新 key 的完整路径。

访问时 v2 config 源码还包含 `require_signed_version`：可要求制品签名携带版本并匹配端点宣告版本。它不是“整个 JSON 都已签名”，且是否可用/默认开启取决于固定插件、CLI与制品生成版本；应明确验证后启用，不能以 `.sig` 存在推断 manifest 所有字段均受签名保护。[updater config 源码](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/src/config.rs)

## 七、Record 音频可靠性下的更新设计

以下均为项目建议与待验协议，不是上游插件保证。

### 安全状态与双层守卫

建议状态机：`idle → checking → available → downloading → downloaded → waiting_safe → installing → restarting → healthy/failed`。checking/downloading 失败只影响更新；不能停止现有录音、清空音频或切换 mock。

React 用于提示和交互；**Rust 的 install/relaunch 入口必须再次判断真实采集状态与上传安全凭据**。只检查页面 `isRecording=false` 不够：暂停、正在停止、采集已经停但尾包待持久化、历史队列待补传都可能存在数据风险。

安全安装最低条件建议：

1. 所有音源停止，Rust 回调队列/原生到 JS 的缓冲已排空；尾包具备完整 record/session/source/epoch/sequence/sampleOffset/hash。
2. 尾包已写入持久队列，上传中的请求完成或保留可幂等重试状态；本项目默认还要求待补传为零，才能自动重启。
3. 服务端按 source/epoch 的 sequence/hash manifest 已确认齐备；客户端 seal/结束确认成功，缺失序号不能被“上传了最后一包”掩盖。
4. 保存确认水位、SSE 历史游标、转录修订、人工编辑状态；重启后续接同一来源/身份，不将旧音频换 epoch 后重新编号。
5. 本地存储 schema、稳定 Origin/端口/应用标识与新旧版本迁移已验证。应用改端口、identifier 或 WebView profile 可能让旧 IndexedDB 看似消失，不能据此清理旧目录。

服务端 manifest 是音频完整性依据，GitHub `latest.json` 是软件发布信息，两者不同。ASR/纪要可以在服务端继续处理；只要音频已可靠封口、游标能恢复，不必把“全部 LLM 已完成”绑定为每次安装前提。

### 默认策略

- 启动后有延迟地检查、随后有退避/抖动地检查；设定自动下载和安全时自动安装偏好，提供手动检查与版本说明。
- 会中下载使用低优先级与并发/带宽预算；检测采集或上传受压时暂停。录制期间新版本可提示“会议结束并补传完成后更新”。
- 暂停仍属于本场进行中；离线有队列、服务器不可达、manifest/seal 未确认均不自动安装。网络恢复后补传，不以“重启可能恢复网络”为由安装。
- 用户点击安装后仍原子复核 guard，避免检查通过瞬间新录制启动；安装一旦进入临界区，禁止开始新录制。
- 不在 close/unload、Windows before-exit hook 或固定延时里猜测排空完成。退出门须由持久化/ACK/manifest 等明确状态驱动。

### 失败与补救

下载失败/验签失败保持旧版本，记录可理解的错误并可重试；禁止删用户数据。安装失败、进程退出前后断电、磁盘满/权限拒绝分别验证；启动健康检查包含内置页面、IPC、Origin/存储、Record 协议与队列读取，不自动打开麦克风作检查。

推荐先以**新 patch 版本前向补救**：撤下有问题版本的通道指针，保留不可变资产与事件证据，发布兼容数据的修复版。切回旧 manifest 只能阻止尚未升级用户，默认版本比较不会让已升级用户降级。真正降级需要受控 comparator、可信目标和可回退的数据 schema；若存储已不可逆迁移则不能自动回退。

## 八、可执行分阶段路线与验收矩阵

| 阶段 | 具体交付 | 退出条件 |
| --- | --- | --- |
| 1：本地更新边界 | updater adapter、自动检查/下载偏好、Rust 安装守卫、故障状态；显式测试 endpoint | 无更新、更新、超时、错误 JSON、错误目标、坏签名覆盖；会中/暂停/补传时安装调用为零 |
| 2：版本与 CI 草稿 | tag 校验、固定工具链、三系统 matrix、完整 manifest 聚合、draft 发布 | 所有支持目标制品与签名完整；tag/version/commit 一致；secret 不泄露；发布写权限仅必要 job |
| 3：签名试点 | 实际 GitHub repo、OS 签名/公证、发布 immutable 测试版本，独立 stable/beta 端点 | 从已安装旧版真实检查→下载→安全退出→新版启动；三系统分别保留证据 |
| 4：稳定推广 | 网络镜像/鉴权按需求接入、兼容策略、前向补救演练与运维说明 | 断网/权限/磁盘/数据迁移/坏版本场景无丢音，旧客户端可继续补传，发布和客户端状态可审计 |

| 必测场景 | 验收要点 |
| --- | --- |
| 普通升级 | 旧程序确实替换，程序版本变化，原设置/历史/稳定 Origin 保留 |
| 系统音频录制、系统+麦克风、暂停 | 可检查/下载；安装/自动退出/重启绝不发生；UI 状态明确 |
| 尾包慢 ACK、缺一个 sequence、seal 失败 | 等待而非误判；服务端 manifest 对齐之后才开放安装 |
| 断网与补传、应用重启恢复 | 队列不丢失、不换身份、不重复转录；待补传期间不自动升级 |
| 旧队列 schema/客户端跨版本 | N-1→N 迁移与失败恢复；历史音频 hash/序号保持一致 |
| 并发竞态 | 新录制与安装互斥；重复检查/点击安装幂等；多窗口共享 Rust 守卫 |
| 下载/安装故障 | 超时、404、HTML、坏签名、错误架构、低磁盘、只读 AppImage、Windows UAC/失败安装、macOS 公证失败均明确停留/失败，不清理数据 |
| GitHub 发布完整性 | 缺平台/缺签名/错 tag URL 不能 publish；prerelease 不进入 stable，immutable 发布后不可覆盖 |
| 网络/私有分发 | 无 token 的公开下载、私有鉴权、代理、重定向、镜像落后/坏包按预期处理 |
| 新版本补救 | 撤回通道与发布 patch；已升级用户不会被虚假“自动回滚”提示误导 |

单元测试或隔离服务可以验证状态机与故障分支；只有真实已安装包的旧→新版本升级，才能证明安装器、签名、公证、文件替换及重启行为。模拟 installer 成功不能计作三平台更新验收。

## 九、仍需落实的发布条件

1. GitHub owner/repo、源码公开/私有、安装包是否允许公开，以及是否使用独立分发仓库；本轮尚无 remote。
2. 发布 signer 与仓库 tag/release/environment 管理人；immutable releases、规则和 runner 权限能否启用。
3. macOS Developer ID/公证条件、Windows 签名条件、updater key 的保管/备份与轮换负责人。
4. 首轮明确支持的 OS/架构/安装格式；Linux 是否只验 AppImage 自更新，deb/rpm 是否单独维护。
5. stable/beta/镜像域名、国内/企业网络要求、私有下载鉴权；自动下载与安全时自动安装默认策略。

这些条件不妨碍先完成本地 adapter、守卫、manifest 校验和 CI 结构，但缺少真实宿主、签名与已安装旧版本时，不能将功能标为“已上线自动更新”。


## 2026-10-13 实现进展

后续用户已授权继续实现，并提供公开仓库 `RoyalLiang/lingji`（默认分支 main，已只读核实）。本报告前文中的未实现状态记录的是调研时点；当前本地实现见[客户端更新](../engineering/client-updates.md)、[发版步骤](../releases/github-client.md)、[ADR 0012](../adr/0012-signed-client-releases-and-safe-updates.md)与[验证证据](../evidence/client-brain-research/client-updater-validation-2026-10-13.md)。没有执行远程推送或发布。

固定依赖 `tauri-plugin-updater 2.13.3` 的实际源码确认支持 `requireSignedVersion`；CLI 2.12.2 的 signer 使用 `--app-version` 绑定可信版本，打包时由 CLI 自动生成。发布端使用独立 `minisign` 校验解码后的签名，不调用不存在的 `tauri signer verify`。GitHub 不可变策略读取使用官方 immutable-releases REST 接口，发布 token 需 Contents write 与 Administration read。


Linux 构建基线修正为 Ubuntu 24.04：固定 CPAL 0.18.2 的 Cargo 源码启用了 PipeWire `v0_3_53`；[Ubuntu 22.04 默认包](https://packages.ubuntu.com/en/jammy-updates/libpipewire-0.3-dev)仍为 0.3.48，而 [Ubuntu 24.04 包](https://packages.ubuntu.com/de/noble/libpipewire-0.3-dev)为 1.0.5 系列。由此选择较新的构建和运行基线，不将 AppImage 视为绕过 glibc/PipeWire 系统依赖的保证。四目标矩阵尚未远程执行。
