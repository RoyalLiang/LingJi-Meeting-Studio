# 自动开始与结束会议：信号、边界与最小方案

研究日期：2026-10-28。本文只做官方资料核查与方案建议；未实现自动监测，未接入用户日历、真实会议或收费服务，未在 Windows/macOS 真机校准触发条件。

## 结论

**扬声器关闭、系统静音、几分钟无声，都不能单独证明会议已经结束。** 音频输出状态、采集健康状态和业务上的入会/离会是三个不同信号。首选最小方案是“显式开启辅助提醒 → 用户确认开始/结束”，先复用现有采集与停止排空流程；后续只对用户选择的会议应用增加原生音频活动观察，有可靠会议 SDK 状态时再评估自动动作。下文所有阈值和自动化规则均为建议。

## 当前项目事实

- 当前 React 入口已区分暂停与结束；采集源故障有暂停路径。停止流程以本地音频持久化及封存为完成边界，上传和 ASR 可继续处理。研究时通过 CodeGraph 核对了 `stopCapture`、`controllerFor`、`quickRecord` 和记录模型的 `pause`/`seal`。参见[会议入口](../../apps/web/src/App.tsx)、[记录状态模型](../../packages/records/src/record.mjs)。
- 因此新信号应驱动既有状态机，不能直接关闭窗口、清空队列或删除音频，也不能将“采集源断开”写成“用户结束会议”。本次未验证这些路径在全部设备和权限组合下的实际行为。

## 各类信号实际说明什么

| 信号 | 官方定义或能力 | 本项目可采用的判断（建议/推断） |
| --- | --- | --- |
| 扬声器静音、音量为零 | Windows 的端点音量/静音与音频会话控制分离；浏览器还允许抑制本地播放，同时继续采集音频。[Windows 端点音量](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudioendpointvolume)、[W3C 屏幕采集](https://www.w3.org/TR/screen-capture/) | 只表示播放设置，不能自动结束。不要为判断会议状态修改用户系统音量。 |
| `MediaStreamTrack.muted` / `mute` | 源暂时无法提供数据；应用控制的 `enabled=false` 是另一状态。无数据时可以输出静音，轨道仍为 `live`。[W3C 媒体轨道生命周期](https://www.w3.org/TR/mediacapture-streams/#life-cycle-and-media-flow) | 采集健康信号，先提示并观察恢复。不能等同“会议软件的静音按钮”或结束。 |
| `MediaStreamTrack.ended` | 轨道永久停止，可能来自权限撤销、设备移除或远端停止；主动调用 `stop()` 不会再触发该事件。[MDN：ended](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event) | 记录具体来源与原因。单源失效不应截断仍健康且获授权的其他源；全部源失效应提示故障/暂停，不能推断正常散会。 |
| 音量/RMS/VAD 长时间无语音 | 轨道可合法输出静音；音频活动 API 观察的是流/IO，未提供会议语义。[W3C 媒体轨道](https://www.w3.org/TR/mediacapture-streams/)、[Apple 输出 IO 状态](https://developer.apple.com/documentation/coreaudio/audiohardwareprocess/isrunningoutput) | 只能产生“可能已结束”的提醒。安静讨论、等人、阅读、单向听会与采集故障均可能命中；VAD 阈值需实测。 |
| Windows `AudioSessionState` | `Active` 为至少一个流运行，`Inactive` 为仍有流但没有运行，`Expired` 为没有流。[Microsoft 定义](https://learn.microsoft.com/en-us/windows/win32/api/audiosessiontypes/ne-audiosessiontypes-audiosessionstate) | 可观察选定应用的音频活动变化；播放提示音、音视频和通话可能相似，不能据此直接封存。 |
| macOS 进程音频 IO | `AudioHardwareProcess` 提供 PID、bundle ID 和 input/output IO 是否运行。[Apple 定义](https://developer.apple.com/documentation/coreaudio/audiohardwareprocess) | 原生层可限定会议应用观察 IO 活动；这是 IO 状态，不是会议状态。系统版本与接口可用性需单独核验。 |
| 会议应用启动/退出 | macOS 有应用终止通知；部分后台应用需观察 `runningApplications`。[Apple NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace/didterminateapplicationnotification) | 启动可能只是打开首页，退会后进程也可能保留。只用来补强提醒，并处理浏览器多标签、辅助进程和多个并行会议。 |
| 日历开始/结束时间 | Graph event 含计划时间、取消标记和在线会议信息。[Microsoft Graph event](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0) | 计划并非实际入会/离会证据。可提前提醒；不能到点自动录制或强制结束，需考虑改期、超时、提前结束与未参会。 |
| 会议 SDK 的明确状态 | Zoom Windows Meeting SDK 提供 `onMeetingStatusChanged`，区分结束原因；Web SDK 区分连接、断开和重连。[Windows SDK](https://marketplacefront.zoom.us/sdk/custom/windows/class_i_meeting_service_event.html)、[Web SDK](https://marketplacefront.zoom.us/sdk/meeting/web/enums/onMeetingStatus.html) | 在本应用集成且授权的 SDK 会话中，这是较强信号；不能据此宣称可读取任意外部会议软件状态。重连不应按散会处理。 |

以上 API 定义支持的共同推断是：**当前所查通用音频/进程接口不足以可靠表达任意会议软件的“会议结束”**。不能把若干弱信号相加后描述为确定事实；专用集成与真实误触发率仍需验证。

## 浏览器与原生层的差异

浏览器的 `getDisplayMedia()` 需要用户瞬时操作，每次由用户选择共享源，授权不能持久化；即使请求音频，也可能只返回视频。因此 Web 的“自动开始”首版宜是自动提醒、点击授权后开始，不能承诺日历到点即可静默重新采集。窗口临时不可访问可能使轨道静音，关闭/撤销共享则需分别处理。[W3C Screen Capture](https://www.w3.org/TR/screen-capture/)

`AudioContext` 可能被应用挂起或受外部中断；后台页面也存在冻结/丢弃等生命周期。它们需要健康检查与恢复提示，不能成为结束会议的证据。不要仅靠前台 UI 定时器累计判断静音时长或执行关键封存，需使用时间戳并在恢复时重算。[AudioContext 状态](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)、[Chrome 页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

Tauri 可在原生层观察音频会话：Windows 可从音频会话取得 PID，但会话也可能跨进程；WASAPI loopback 采集渲染端点的音频流，不能由物理扬声器是否出声判断捕获是否终止。[GetProcessId](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-getprocessid)、[Loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)

macOS Core Audio tap 可采集指定进程或进程组的输出，官方示例也支持让输出进入 tap 而不从扬声器播放，进一步说明“听不到”不代表没有音频流。该采集需系统音频授权；官方示例要求 macOS 14.2 或更高。应先做平台探针并保留浏览器路径，不能将示例版本直接当作当前应用已兼容的范围。[Apple Core Audio tap 官方示例](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)

## 首选最小方案（建议，未实现）

1. **单独开关“会议开始/结束提醒”**，默认关闭。用户选择监测的会议应用及音频源；可选绑定日历。只监测最少必要的状态，不保存窗口标题、完整进程清单或日历正文；排除本录音程序自己的音频会话，避免自触发。
2. **开始只提醒并确认**：选定应用的音频活动稳定出现，或所选日历临近时，提示“是否开始录制”，展示将采集的源、录音状态和云端处理选项。Web 点击后再请求共享/麦克风权限。拒绝后本次不自动重试；不录制授权前的预缓冲音频。
3. **结束先提醒**：在所有仍健康的已选源都持续无语音时，提示“可能已结束：继续录制 / 结束并整理”。例如 5 分钟仅可作为待校准初值。用户无回应时默认继续已有授权的录制，明确提示该默认可能延长录音；提供手动结束和用户预设的录制时限。日历到点、扬声器静音或单源失效不直接结束。
4. **故障不冒充散会**：记录源被撤销、设备切换、音频上下文中断与重连。尊重用户停止共享，不自动重新获取权限；只处理仍获授权的源。全部源不可用时提示并保存已有音频，进入明确的暂停/故障状态。
5. **确认后走原有停止排空**：停止采集并收齐尾块 → 本地持久化与确认最后序号 → 暂停或封存 → 上传/ASR 继续排空并显示进度。不要为了“已结束”动画或积压数字归零丢弃尾音频；转录、纪要完成状态与录制结束状态分别展示。

如果后续确有免确认需求，再增加**逐应用、明确启用的自动规则**：优先使用该集成会话的明确结束事件，加入可取消倒计时、重连宽限与活动恢复取消；普通 IO/静音规则先通过提醒积累验证数据。可选“静音超时自动暂停”也必须单独说明：保留已有音频不等于不会漏录，暂停期间的新发言无法事后恢复；不能宣称暂停完全可逆或无损。自动结束还应防止事件重复触发、过期回调结束新会议及设备重连竞争。

## 授权与隐私边界

录音告知、系统/麦克风采集许可、日历访问、云端 ASR、原音留存和分享是不同选择；自动提醒或日历访问不代表同意自动录音。Graph 读取事件需对应日历权限；EventKit 读取日历也有独立权限，macOS 沙盒还需 Calendar entitlement。首版没有日历授权时应继续支持手动录音，不为提醒申请多余权限。[Graph 获取事件权限表](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0)、[Apple 访问事件存储](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)

监测应用/日历只是开始提示的理由，不是参与者录音告知的替代。默认继续录音存在会后环境音被保留的风险，默认静音结束则存在安静会议漏录风险；需让用户明确选择，并持续展示录音指示、快捷停止入口和可删除的原音。上述为产品设计建议，未作特定地区法律判断。

## 实施前验收集

- 扬声器音量零/静音、会议内静音、系统麦克风禁用、耳机/蓝牙切换、单向听会、长时间阅读：不因无声误封存。
- 共享撤销、设备拔出、一个源失败、全部源失败、系统休眠唤醒、窗口最小化/后台、`AudioContext` 中断：区分故障、恢复与正常结束，保留已确认音频；用户撤权后不自动重采。
- 应用打开未入会、退会后进程保留、网页多标签、同时两场会议、音乐/提示音、会议重连：不误开始，不以旧事件结束新会议。
- 日历取消/改期/超时/未参会、权限拒绝/撤销、离线：提醒可降级，手动流程仍可用。
- 用户手动停止与自动候选并发、最后尾块未落盘、上传/ASR 有积压、重复结束事件：只封存一次，序号与音频完整，界面分别显示录制时长及处理进度。

验收应分别报告浏览器、Windows、macOS 真实设备结果，并用误开始率、误结束率、漏提醒率和尾音频完整性评价；当前仅完成资料核查与代码路径定位，没有这些实测结果。
