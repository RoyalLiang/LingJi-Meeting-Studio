# Windows 浏览器与飞书音频调用监听研究

日期：2026-10-31。性质：主源研究与实施建议，不是 Windows 运行验收。代码核对基线：`d30da26`；本次只新增本文，没有连接 SSH、打开音频设备或修改产品代码。

## 先做共享会话监听，不把枚举为空当成会议结束

Windows 可以使用 WASAPI 会话状态观察 Chrome、Edge、飞书的**共享模式**音频流：枚举 render 与 capture 端点，为每个端点激活 `IAudioSessionManager2`，读取会话状态与 PID，再核对进程映像路径。`AudioSessionStateActive` 表示至少一个流正在运行；静音、没有发言或音量为零都不能据此判定停止，反过来它也不证明正在开会。[会话管理接口](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nn-audiopolicy-iaudiosessionmanager2)、[会话状态定义](https://learn.microsoft.com/en-us/windows/win32/api/audiosessiontypes/ne-audiosessiontypes-audiosessionstate)。

这条路径不能承诺识别全部麦克风调用。微软明确说明 `IAudioSessionControl` 等接口用于共享模式，不适用于独占模式；独占流可以直接与硬件交换数据。因此，“共享会话都不见了”和“所有目标都已停止音频调用”不是同一个结论。[GetService 的共享/独占限制](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getservice)、[独占流行为](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams)。

建议首版保留以下边界：确认目标共享会话持续 Active 时，可以进入现有十秒开始候选；空列表、无法归属或采样失败时输出 unknown，不能推进自动结束倒计时。若产品要求仅靠这组 API 完全自动结束，必须接受“目标切换到不可见独占流”的残余误结束风险；不能宣称已经排除该风险。

## 同时覆盖所有活动 render 和 capture 端点

`EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)` 与 `EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)` 分别取得当前可用端点。这里的 `DEVICE_STATE_ACTIVE` 是设备可用状态，不是音频正在运行。只看默认扬声器会漏掉耳机、USB 声卡、通信设备和应用选择的其他输出；只看 render 会漏掉仅麦克风输入。[端点枚举参数与示例](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-enumaudioendpoints)。

会话属于一个端点，不能同时包含 capture 与 render 流；同一 PID、同一 GUID 在不同端点上也是不同会话。监听表应至少按端点 ID、方向和会话实例标识区分，不要把 PID 当作唯一键。[Audio Sessions](https://learn.microsoft.com/en-us/windows/win32/coreaudio/audio-sessions)。

端点增加、移除、禁用、默认设备变化时应重建相应端点上下文，并重置结束候选。可使用 `IMMNotificationClient`，其回调必须非阻塞；不要在回调中反向注册/注销通知或释放 MMDevice 对象最后一个引用。[端点通知及回调约束](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient)。

## 持久保存 manager、通知和会话引用

不能把“两秒重新取得一次 enumerator”当作完整会话发现机制。微软在 `GetSessionEnumerator` 的 Remarks 明确说：enumerator 可能不知道通过 `IAudioSessionNotification` 报告的新会话，仅依赖它获取所有会话可能得到不准确结果，应由应用维护会话列表。`IAudioSessionEnumerator` 文档还指出，如果通知回调返回的 SessionControl 在 enumerator 初始化前已释放，列表可能只有部分会话。[枚举器不完整的直接说明](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessionmanager2-getsessionenumerator)、[会话列表及引用生命周期](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nn-audiopolicy-iaudiosessionenumerator)。

最小可靠的共享会话实现顺序是：

1. 创建专用非 UI 线程，执行 `CoInitializeEx(NULL, COINIT_MULTITHREADED)`。COM 初始化失败则禁用本次监听，不把 UI 的 STA 接口直接搬过来用。
2. 枚举两种方向的活动端点。每个端点持有自己的 `IMMDevice`、`IAudioSessionManager2` 和通知对象。
3. 先调用 `RegisterSessionNotification`，再调用 `GetSessionEnumerator` 和第一次 `GetCount`。微软明确要求首次 `GetCount` 才开启新会话通知，不能省略。
4. 枚举已有控制对象，并合并通知到达的对象。回调对收到的 SessionControl 增加引用后入队，交给 MTA 工作线程处理；不能先释放再异步使用。
5. 工作线程维护会话表，两秒读取一次各控制对象的 `GetState`；重复通知与枚举结果去重。只有状态、归属和端点均有效的目标会话才参与统计。
6. Expired、端点移除、停止监听或配置代际改变时，解除对应注册并释放引用；所有成功的 COM 初始化都配对 `CoUninitialize`。回调与清理仍需遵守各接口的线程和引用规则。

以上顺序来自[注册通知的 GetCount 与 MTA 要求](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessionmanager2-registersessionnotification)；`CoInitializeEx` 的成功返回也包括已在同种模式初始化的 `S_FALSE`，成功调用都要配对清理，`RPC_E_CHANGED_MODE` 不能当作成功。[COM 初始化规则](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex)。

## 通过 PID 与映像路径确认归属

每个非系统声音会话查询 `IAudioSessionControl2::GetProcessId`。**仅精确的 `S_OK` 才能作为单一 PID 归属依据**；`AUDCLNT_S_NO_SINGLE_PROCESS` 虽是非负 HRESULT，却表示跨进程会话，返回的是最初创建会话的 PID，不能据此断言全部音频属于该应用。其余错误、PID 无效或进程已退出都保持 unknown。[GetProcessId 返回码](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-getprocessid)。

`IsSystemSoundsSession` 的 `S_OK` 表示系统声音，`S_FALSE` 表示普通会话；这两个返回值不能用通用“非负即同一种成功”分支处理。[系统声音会话判定](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-issystemsoundssession)。

对普通会话以 `PROCESS_QUERY_LIMITED_INFORMATION` 打开进程，调用 `QueryFullProcessImageNameW` 取得完整路径。目标路径应来自已核对的安装目录/产品身份；文件名、窗口标题、session display name、父进程名字或路径中包含 Chrome/飞书字样都不足以证明归属。Chrome/Edge 的音频可能在子进程中，不能只匹配主窗口 PID。飞书的 Windows 主进程与辅助进程路径仍需在实际安装版本核实，本文不把猜测的 exe 名当作已验证白名单。[映像路径接口与所需权限](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew)。

监听本身排除聆记及其采集进程。进程身份缓存至少包括创建时间，避免 PID 重用后沿用旧归属。后两点是本项目的安全建议，不是微软保证的应用归属机制。

## 对不完整观察保留 unknown

建议把底层结果表示为有效快照或明确错误，而不是把任何失败折成 `{input:false, output:false}`：

| 观察 | 可以得出的结论 | 对已有自动录音的处理 |
| --- | --- | --- |
| 已确认目标、有效共享会话、Active | 目标共享音频流正在运行 | 取消结束候选 |
| 同一有效目标会话明确转为 Inactive/Expired | 此共享会话的流已停止/销毁 | 仅在已接受共享模式覆盖边界时，参与结束候选 |
| 会话列表为空，或目标会话突然消失 | 本轮未看到目标共享会话 | 不据此自动结束 |
| 跨进程会话、路径权限失败、设备失效、音频服务停止 | 归属或覆盖未知 | 清除结束候选，保留录音，提示手动处理 |
| 独占麦克风/独占播放 | 这组接口没有完整覆盖保证 | 不宣称“所有调用停止” |

`GetState` 会因设备失效或 Windows Audio 服务停止而失败，这些情况必须与正常 Inactive 分开。[GetState 状态及失败码](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol-getstate)。

即使每个已见共享会话都显式停止，也不能排除目标随即进入不可见独占流。若要求**避免这类自动误结束**，最小安全策略是 Windows 端只自动开始、结束保留候选提示并由用户确认；另一个选择是增加独立、可靠的会议退出信号。单靠峰值音量、麦克风隐私图标或补查默认端点不能填补进程归属。软件峰值表在独占模式可能一直为零，不能当作修补方案。[峰值接口的独占模式限制](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudiometerinformation)。

## 用真实 Windows 会话验证 sampler

下列是待执行计划；本机没有完成任何 Windows 运行验证。

第一层在固定 Windows runner 上编译 Rust 原生模块及 Windows ABI，检查 GUID、vtable、HRESULT、引用释放和回调注销。mock/ABI 故障注入只证明本地分支与内存管理，不计为 WASAPI 实际采样通过。

第二层运行**同一份生产 sampler**，同时启动一个独立受控 helper 进程，经真实 `IAudioClient::Initialize` 创建带随机 session GUID 的共享 render/capture 流。测试通过实际 MMDevice/WASAPI 返回的端点、PID、路径和 GetState 校验，不向 sampler 注入活动布尔值，也不把 Chrome 的 fake microphone 当作真实 capture 会话。[微软共享播放示例](https://learn.microsoft.com/en-us/windows/win32/coreaudio/rendering-a-stream)、[采集示例](https://learn.microsoft.com/en-us/windows/win32/coreaudio/capturing-a-stream)。

测试专用策略可以允许该 helper 的确切 PID/路径，但必须隔离在测试构建或内部测试入口；产品白名单、自进程排除和授权检查保持正常。验证顺序如下：

| 用例 | 必须从真实 sampler 观察到的结果 |
| --- | --- |
| helper 初始化但不 Start | 对应 session 非 Active |
| render Start，持续提交静音缓冲 | 同一 helper PID 的 render session Active，证明监听不依赖音量 |
| capture Start，只排空缓冲不保存 | 对应 capture session Active；不能用 render 成功替代 |
| 两个方向同时运行，只停止其一 | 仍有目标 IO；不会进入整体结束候选 |
| Stop 后保留 client，再释放所有流 | 先 Inactive，后观察失效/过期；不把仍列出的历史 session 当 Active |
| sampler 启动后 helper 才创建会话 | 持久通知表收到新 session，验证 Register/GetCount/引用链 |
| 非默认端点、耳机切换、服务中断 | 正确发现或明确 unknown；不能把读取失败报成正常停止 |
| 未选目标和聆记自己的流 | 不满足目标触发条件 |

CI 日志只记录时间、方向、状态、脱敏端点标识、helper PID 和失败码，不保存麦克风内容。独占流作为独立边界用例：若设备支持则真实启动，确认产品不会把共享会话空白直接转换成自动结束；设备不支持或权限不足必须记为未覆盖。

公用 Windows runner 的端点与音频服务必须先实测，不能假设 `windows-latest` 自带可用麦克风。没有 render/capture 端点时，编译仍可完成，但实际会话测试应返回明确的环境不具备条件，不能输出成功。完整验收需要经授权的 Windows 10/11 自托管 runner 或带可用音频设备的 VM。需要虚拟端点时可评估微软 SysVAD：它提供操作系统层的音频设备，WASAPI 会话仍由真实系统产生；但驱动安装、签名/测试签名及主机修改需要在独立测试环境安排，不能偷偷改用户机器。[微软 SysVAD 样例与部署步骤](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/sample-audio-drivers)。

第三层才是 Chrome/Edge 与飞书实机验证：受控网页的真实 `getUserMedia`、真实播放、静音保持、停止 track、关闭标签页、加入/退出飞书会议、多设备切换及共享/独占差异。helper 证明 WASAPI sampler 路径运行正确，不能替代这层产品进程归属和误触发率验收。

## 当前代码可复用的部分

研究启动时仓库的 `apps/desktop/src-tauri/src/audio/mod.rs` 使用 CPAL；所述 `audio/windows.rs` 文件并不存在，不能把它列为已实现的 raw COM 复用点。现有 `meeting_watch.rs` 的 token/代际隔离、采样错误语义，以及前端自动会议的 owned ID、倒计时和取消规则可以继续复用。Windows 会话监听、持续引用表和真实 Windows 采样证据仍需由实施提交及 CI 回执单独确认。
