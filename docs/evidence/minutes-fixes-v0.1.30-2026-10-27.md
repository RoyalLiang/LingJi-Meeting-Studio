# v0.1.30 会议修复交付与发布核验（2026-10-27）

十一项会议体验与结束保留修复已包含在[公开测试版](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.30)中。[Actions 40494259772](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772)五项任务全部成功。

## 固定来源与交付范围

- 标签v0.1.30剥离后的源码/工作流提交：`46d45a8e71de0d821d34d098110a88825cc2ca03`；产品0.1.30，macOS build0.1.52。
- 本轮业务修复首先提交于`05b879c50b5ae6c291f9c89c51033b38179a4103`；最终标签包含该提交。具名原生按钮探针与Linux依赖修正在最终来源中保留。
- 固定源码331文件，重新计算的清单SHA-256：`ddc9f67e1f97ab2555f663404be8050fb54d5275fd3ec8df31ea5427f6dc4fd0`。当前工作树产品代码与固定标签逐字一致，交付补记只涉及文档。
- 核验时间：2026-10-27T11:57:45.704Z。完整下载三个公开安装器，逐个核对Release API大小/摘要、正文校验行及文件格式（PE、UDIF、DEB）。

## 十一项修复

1. 小窗增加麦克风按钮，复用主窗实际断开/接入麦克风；系统/会议音源可以继续。暂停且补传完成时可重新开启，忙碌/补传门禁保留。
2. 确认会中单次模型请求120秒、终稿/暂停补齐240秒，没有会议五分钟硬截止。修复200ms节流只发前沿、模型暂停时已收到正文不发布的问题；切流、完成和取消清理尾部更新并保留任务栅栏。
3. 移除主题和讨论细节折叠，正文默认展示所有要点。
4. 每段右上角从冻结引用读取说话人，支持多人；未标注与缺失引用明确显示，不猜身份。
5. 学习评审、导出和删除放入顶部工具栏，移除底部操作块与重复导出；到期日期放在留存提示。
6. 底部整理状态压为44px单行，长内容可悬浮查看。
7. 本机保存每场纪要的阅读位置与跟随意图，重新打开恢复阅读；主动回到最新内容后继续跟随。
8. 连接图标和连接文字同排居中，待保存数量独立显示。
9. 移除标题下会中更新标签和重复说明。
10. 新会议默认60秒整理，已保存的明确间隔保留；生成过程默认关闭。已校验分窗仍可以提前显示；开启生成过程后可看未校验流式草稿。
11. 结束会议前保存仍在任务中的有效已校验分窗，再进入终稿，避免切换/取消任务后正文变空。留空名称本身没有删除纪要逻辑。原音按点击加载，结束时不自动读取音频及扫描波形；字节定位跳过不相交PCM块，更名不重载已打开的播放器。

## 可复现验证

- Node24完整537/537；锁定依赖的Rust smoke-test特性34/34；lint、typecheck、Web构建通过；补记后180份Markdown引用及围栏检查通过。
- 独立相关57/57、探针相关21/21及合并复核通过，这些是定向子集，不与全量相加。
- 受控流在供应商仍未完成时，300ms内显示已收到的正文，原红例已转绿；取消任务不接受迟到更新，并行窗口不混流。
- 真实worker多窗和单条6000字拆8窗24节的结束/终稿排队保留通过；修订旧证据不被过期草稿覆盖。
- Chrome合成会议1440px/390px通过：全部六条详情可见、冻结说话人正确、底部44px、无横向溢出与page errors；已结束会议重开从旧版0恢复至600px，连接图标/文本中心误差小于1px。
- 合成双轨旧版结束即触发2波形+2音频请求；新版结束为0，点击后2+2，更名不增加请求。真实本机HTTP尾部2字节请求从读取20块降至1块，既有跨块/权限/保留回归通过。
- GitHub全部状态Issues在本轮读取时为0，无可评论关闭条目。

## 后台构建与报告

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155584899)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659059)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659066)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122155659220)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40494259772/job/122171690724)：success。

Windows隐藏录音和重启回放已实际通过，随后完成安装器验证；macOS与Linux也完成对应构建及安装/启动检查。平台原生、包内模型和安装器证据属于CI/合成样本验证，不能替代用户设备或真实供应商验收。

公开附件按合入的发布流程仅有三个成品安装包。五个Actions artifact元数据均绑定同一源码且未过期；三平台报告、Windows原生报告与发布回执保留在Actions。匿名下载报告ZIP返回401，未在本机重新解包这些报告；三平台内部来源一致性由成功publish任务的固定脚本校验。下表为实际完整下载的公开文件。

## 公开安装包

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.30-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-linux-amd64.deb) | 222650826 | `ef6265a41053c1409fc965c25d1e8390526517ceeaaf144d9261d8b711972999` |
| [Lingji-0.1.30-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-macos-arm64.dmg) | 219565122 | `5f7370709fc680eeaf90c187fbdba56c9ece0a3ff7cd4c527874f36e8d5211df` |
| [Lingji-0.1.30-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.30/Lingji-0.1.30-windows-x64-setup.exe) | 407698114 | `29e9e4de43ca3685425aa08dace7b74f43bb9fa27b8fd8397804fe40a61947a8` |

## 并发发布与边界

v0.1.28的Windows冒烟因新增按钮使位置选择器失配而失败，publish跳过。另一会话创建了v0.1.29/v0.1.30并合入Linux及同一探针修正；本会话核对最终候选包含全部业务修复后，采用同一v0.1.30构建。原子推送拒绝时没有覆盖远端，旧标签未移动；补记沿用同一发布证据，不创建新版本。

真实Kimi首字及首个有效窗口耗时、用户Windows设备/缩放/GPU、Linux实际采音与长会议没有复验。一分钟是调度间隔，转录/排队/多窗口/重试仍影响端到端等待；默认关闭生成过程后，要等首个完整窗口校验后显示。本次复现不能证明用户五分钟等待全部由节流造成。

未访问用户Windows数据库，也没有执行历史草稿恢复；修复用于防止之后结束时丢失已校验内容。此前记录能否从缓存或重新整理恢复仍需针对实际数据检查。Windows未代码签名，macOS ad-hoc签名且未公证；未替换本机安装。
