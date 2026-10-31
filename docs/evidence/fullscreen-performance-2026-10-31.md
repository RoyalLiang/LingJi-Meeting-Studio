# v0.2.6：全屏与后台处理

日期：2026-10-31。基线 v0.2.5，已发布并完成整包核验，见[发布回执](preview-v0.2.6-2026-10-31.md)。[需求与边界](../design/fullscreen-performance-2026-10-31.md) · [安装说明](../releases/v0.2.6-preview.md)。

## 已复现与修复

- 实际容器在1920和2560视口都只有1720px；修复后分别1888和2528px，均保留16px边距。另测1280→1248、390→390，无横向溢出。
- 实际重点组件原本渲染“下一步”和负责人/日期；当前不再展示，原actions数据仍在，正式纪要不受影响。
- 合成600段、4窗口的真实纪要流水线，快照guard读取源ID由1,983,300次降为6,600次；共用索引匹配覆盖运行、提交与保留部分结果路径。该数字只是查找开销，不是端到端或真实模型提速比例。
- 原流程在最终模型调用开始时仍显示window阶段；已在实际请求开始前发出synthesis进度。缓存复用时进度既有行为正确，保留了回归。
- 会议标题容器的收尾文字原先nowrap并被截断；当前处理态可完整换行，明确“正在汇总会议终稿”，节点全齐时仍保持后台处理中。

针对性17项、领域160项及默认入口完整779/779回归通过；lint、TypeScript、Web构建及276份Markdown检查通过。新增三个流水线回归已接入npm test。独立评审和三平台发布结果另记发布回执。

## 界面证据

实际组件和应用容器CSS，全部使用合成资料。验证2560、1920、1280、390视口，浅深主题，状态文字无截断，重点不含下一步。

[尺寸与读取次数](assets/fullscreen-performance-20261031/regression-metrics.json) · [宽屏](assets/fullscreen-performance-20261031/fullscreen-wide.png) · [深色处理态](assets/fullscreen-performance-20261031/processing-dark.png) · [窄屏处理态](assets/fullscreen-performance-20261031/processing-mobile.png) · [转录失败提示](assets/fullscreen-performance-20261031/failed-mobile.png)。

## 未覆盖

未连接真实ASR/LLM，未测真实供应商耗时、真实Windows窗口最大化/全屏及GPU差异。Windows共享会话监听继承v0.2.5边界，独占音频和真实Chrome/飞书活动仍未验。此轮没有降低上下文、引用和人工编辑保护来换速度。

## 独立评审

固定候选dc899ff，以v0.2.5为基线分别评审。Standards无确定违规或需行动smell；Spec发现1项P2：ASR重试耗尽后仍假显示转录处理中。已区分需要重试与仍在运行的独立纪要，修复悬浮提示，保留已完成结果；真实重试恢复queued状态。原评审定点复核确认关闭。进一步用实际组件验证失败态在390视口完整换行且不再有处理样式，显示警示色。
