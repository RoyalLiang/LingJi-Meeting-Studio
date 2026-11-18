# 构建与发布 Microsoft Store 版本

Windows 商店通道使用 MSIX，由 Microsoft Store 审核并签名。现有 NSIS 安装包继续用于独立下载；把 EXE 挂到商店不会获得微软重签。签名边界见[微软包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)。

2026-11-19 已在 Partner Center 核对产品“聆记 LingJi”（Store ID `9NCW0WT5W9D1`）。公开提交 4 对应 `0.3.36.0` / MSIX `1.3.3600.0`，已通过认证并上架。原包通过 Windows SDK、桌面激活和内置后台验证。中英文介绍和新增／修复说明已保存核对，继续支持 X64 与 Windows 10 2004（`10.0.19041.0`）及以上。附加许可条款包含[完整 WebView2 许可](https://rookiecode.com/licenses/webview2-fixed-version.html)入口与 SmartScreen 告知。

## 使用已预留的产品身份

2026-11-16 已在 Partner Center 创建 **聆记 LingJi**，类型为 **MSIX 或 PWA 应用**。原有“聆记”EXE/MSI 草稿保留。

公开身份保存在 [microsoft-store.json](../../apps/desktop/src-tauri/microsoft-store.json)：

| 字段 | 值 |
| --- | --- |
| Store ID | `9NCW0WT5W9D1` |
| Package/Identity/Name | `Fengqi.LingJi` |
| Package/Identity/Publisher | `CN=2B865656-95E5-4197-9091-E3AF97C7A990` |
| PublisherDisplayName | `Fengqi` |
| Package Family Name | `Fengqi.LingJi_zfjq9r1geh5sg` |

构建从固定源码读取身份，不使用猜测名称、临时证书或个人 CA 替代商店身份。创建产品、认证、上架与设备安装验证是不同证据；当前上架包以 Partner Center 的提交 1 和公开产品页面为准。

## 区分产品版本和商店包版本

商店要求包版本第一段非零，第四段留为 `0`。为保留产品 `0.x` 版本及后续升级顺序，映射为：

```text
产品 A.B.C → 商店包 (A+1).B.C.0
0.3.33     → 1.3.33.0
1.0.0      → 2.0.0.0
```

三段历史版本按原义映射，不重新编码已发布包。四段产品版本 `X.Y.Z.R` 先映射为 native `X.Y.(Z*100+R)`，再映射为 MSIX `(X+1).Y.(Z*100+R).0`；例如 `0.3.34.1 → 0.3.3401 → 1.3.3401.0`。产品主版本最大为 65534，编码后的其余段不超过 65535。根 `package.json.releaseVersion`、客户端和 GitHub 标签使用产品版本，构建回执显式记录产品版本与包版本；native 版本按映射推导。不能直接按商店包前三段匹配 GitHub 标签。[微软版本规则](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements#package-version-numbering)

## 在现有发布流水线生成 MSIX

`preview-release.yml` 沿用 WGS 当前目录串行构建 Linux、Windows。Windows 程序、NSIS 和原始 MSIX 都在 WGS 隔离容器生成；不在 Windows Actions 重新打包发布文件。固定微软 MSIX SDK 源码提交及归档摘要位于 `tools/release/wgs.Dockerfile`。

WGS 把同次构建的 `windows-app.exe`、资源归档、`windows-store-unsigned.msix` 和 `store-package.json` 写入输入回执，逐文件记录大小和 SHA256。Windows Actions 的 `node scripts/windows-msix.mjs` 验证源码及所有输入摘要，用 Windows SDK 解包原始 MSIX 并核对清单和主程序，不重新 pack。

清单声明 `runFullTrust`、麦克风和网络能力；最低系统为 Windows 10 2004（19041），支持 x64。包内 Node 后台和资源保持只读，用户数据使用客户端配置目录。

商店包附带 Fixed Version WebView2。版本、微软下载地址和 CAB 摘要固定在 `tools/release/webview2-fixed.json`；应用在创建首个 WebView 前，按构建时生成的完整文件清单将运行时准备到应用专用的 `LocalCache/WebView2/<清单摘要>`，并选择该缓存路径。每次启动核对文件数量、大小和 SHA256；缺失或损坏时先在临时目录完成复制与校验，再发布到目标目录。完整运行时、供应商 notices 和独立许可随包保留，不修改包目录 ACL，不关闭浏览器沙箱。Fixed Version 的安全修复需要随应用升级，维护时应更新固定版本和摘要。隐私页保留 SmartScreen 告知及微软隐私链接；提交商店时还须把微软 WebView2 再分发条款加入附加许可条款。[官方运行时分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

缓存以完整清单摘要复用，相同运行时不因应用补丁版本重复复制。首次启动额外占用一份运行时的磁盘空间；后续启动仍需读取并校验完整运行时。旧摘要目录暂时保留，避免影响仍运行的旧进程；升级固定运行时时应评估磁盘成本，卸载由包数据生命周期清理。该实现须通过真实 AUMID 的冷启动、再次启动与窗口验证后才能作为已验证修复。

`test-windows-msix.ps1` 在一次性 Windows runner 内创建测试签名副本，先通过普通 AUMID 激活验证真实应用、Node 子进程包身份、窗口和包内 WebView2。随后以 `Invoke-CommandInDesktopPackage -PreventBreakaway` 的诊断上下文运行安装目录内的 Node，验证只读后台与本地模型推理，并再次核对 Node 的真实包身份。诊断上下文不能代替普通激活；测试不更改 WindowsApps ACL。测试证书及安装在结束后清理，原始提交包保持未签名。[微软调试命令说明](https://learn.microsoft.com/en-us/powershell/module/appx/invoke-commandindesktoppackage?view=windowsserver2025-ps)

`v0.3.33` 的[完整发布流水](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/43878591731)与[独立 MSIX 验证](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/43879682491)均已通过。受限于临时测试证书，这些结果证明包结构、安装及应用冷/再次启动可用；不代表已获得微软商店签名、真实设备验收或 NSIS 用户数据迁移验证。

`windows-msix-check.yml` 可在不重新构建的情况下针对原 WGS 附件快速重跑这项验证。发布控制器与产品源码分别固定；重新验证既有版本时，先核对两个平台的完整回执、源码和所有文件摘要。任何缺失或不一致均停止并保留原件，不覆盖重建。原构建 CI 回执保存在 `buildCi` 和复用证据附件中，新运行记录验证控制器来源。

这些检查不替代真实音频设备、真实模型服务、现有独立安装包的数据迁移和 Microsoft Store 审核。

作业产物 `microsoft-store-submission-源码SHA` 包含：

- `windows-store-unsigned.msix`：仅用于提交商店，不能当作可信站外安装包发布。
- `store-package.json`：产品/包版本、公开身份、固定源码、工具与 WebView2 版本、包摘要。
- 原包解包校验和隔离安装启动验证结果；Actions 运行另外记录控制器 SHA。

## 提交商店并启用官网入口

1. 在 Partner Center 打开产品 `9NCW0WT5W9D1`，创建提交，上传本轮 MSIX。
2. 填写实际功能、支持联系方式、年龄分级、隐私说明和审核说明。隐私页面为 `https://rookiecode.com/privacy`。说明 `runFullTrust` 用于桌面窗口、本地后台、音频采集和工作目录访问；本地转录与用户配置的云端模型分别说明。
3. 等待包验证、认证与实际公开发布。产品 ID、提交成功或审核中都不能作为可下载的证明。
4. 核对已上架包与本轮产品版本的映射，以及干净 Windows 机器上的安装、录音、数据保存和更新。
5. 在 GitHub 仓库变量设置 `MICROSOFT_STORE_PUBLISHED_VERSION` 为**产品版本**，例如 `0.3.33`，运行官网部署工作流。 同时保留注明产品版本的 GitHub 独立安装包备用入口，供商店不可用的设备选择。

官网使用固定 Store ID。2026-11-18 官网渠道调整已部署并核对：核对实际上架后，Windows 主入口使用官方 Store Web Installer；macOS、Linux 及 Windows 独立备用入口使用不可变 GitHub Release。商店与测试版分别标识渠道，允许版本不同；不能把较旧商店包标成最新 GitHub 产品版本。

Store Web Installer 下载微软生成的轻量 EXE，再联网安装商店应用，不是完整离线包。[官方安装流程](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-use-store-web-installer-for-distribution)

## 保持渠道和回滚边界

MSIX 运行时通过 Windows 包身份 API 识别，拒绝 EXE 更新命令并隐藏独立更新策略。身份查询异常时暂停更新，不降级为独立安装器。商店版由安装渠道管理更新；NSIS、DMG、DEB 保留原更新和发布链路。

GitHub Release 和 OSS 只发布已验证的独立安装包。未签名的商店提交产物不会进入公开下载目录。商店签名包转存 GitHub/OSS 需要另行核对许可、依赖、包身份、版本映射、冷机安装和更新；本轮不把抓取商店下载链接等同于已完成该验收。

需要停止官网商店入口时，清空 `MICROSOFT_STORE_PUBLISHED_VERSION` 并重新部署官网，回到已有独立下载。不要移动标签、覆盖已发布附件，或用较低 MSIX 版本覆盖已安装的高版本。

独立 EXE 切换到 MSIX 不等同于原位置升级。正式分发前还需核对现有本地账户、工作目录、原音及设置的迁移；不要通过覆盖或移动用户数据来掩盖安装渠道差异。

## 内容举报与审核说明

商店介绍应明确外部模型生成内容的用途和限制。官网和分享页提供[内容准则与举报](https://rookiecode.com/content)，使用公开 Issue 接收问题；分享引用编号不包含访问 token 或解密密钥。处理流程见[内容举报运维](content-reports.md)。已保存 IARC：全球 12+、美国 Teen、德国 12+、俄罗斯 18+。人工撤销分享不等于用户封禁或模型输出过滤；举报机制本身不证明所有生成内容符合政策。

## 维护商店介绍与发行说明

中英文最终文案维护在 [microsoft-store-listings.json](../releases/microsoft-store-listings.json)，当前对应已上架的 `0.3.36.0` 包，只描述对应包中已存在的能力。会议助手可整理所选材料、问答可访问的目录知识、查看或取消任务并恢复中断处理；Git 归档澄清与已配置授权的 GitLab、飞书、只读 MCP 单独说明，不扩展成通用电脑控制或无限制外发。生成内容的人工核对、模型服务配置及公开反馈隐私提示必须保留。

发行说明每项只写新增或修复的功能行为，不列配色、排版、控件等视觉调整。修改说明后逐语言读回，核对安装包、附加许可、截图与可用性未变，再提交认证。只有实际上架后才更新公开文案状态；文案审核不代表升级了安装包。


当前源码为 MSIX 使用透明品牌图形。发布候选的 Windows Actions 使用 SDK MakePri 生成任务栏和开始菜单可用的无底板资源索引。图标资源通过作业输出分块传到 WGS。WGS 核对源码和完整摘要，在原有隔离构建路径中封装；Windows 验证确认原包中包含资源索引及深浅图标。系统实际选择的图标仍需在 Windows 上验收。参见[微软图标说明](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)。
