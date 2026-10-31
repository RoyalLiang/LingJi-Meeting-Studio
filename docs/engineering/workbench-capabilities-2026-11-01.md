# 窗口布局、后台联动与扩展能力

2026-11-01。基于完整 v0.2.6 主线与 Pi 集成分支 `ab26409` 修复，候选版本 v0.2.7。发布状态单独见[安装说明](../releases/v0.2.7-preview.md)。

## 窗口布局

短会议的纪要区会填满阅读区剩余高度，随手笔记位于其下方，靠近内容区底部；长纪要和小窗口继续使用既有滚动区，笔记仍在内容末尾。没有把编辑框绝对定位到窗口上，也不会遮住长纪要。

扩展中心删除对应用外壳、侧栏、品牌、搜索栏和背景的重设，沿用所有页面的 sage/jade 主题。目录概览与扩展中心入口共用 12px 字号、相同内边距和高度；内容标题沿用目录页面的 30px/手机 26px 层级。深色错误、警告、抽屉与图标使用主题变量。

工作目录下拉的焦点轮廓不再改变边框厚度及内边距。选中较后方的选项时仅滚动菜单自身，不通过 `scrollIntoView` 牵动侧栏、页面和阅读区。

## Windows Chrome 后台联动

Windows WASAPI 的 `IAudioSessionControl2::GetProcessId` 可能返回跨进程会话的成功码 `AUDCLNT_S_NO_SINGLE_PROCESS`，并返回创建者 PID。原代码把所有非零结果当作归属失败，导致这类 Chrome 会话无法推进自动启停。本轮保留成功返回的 PID，再核对精确的 Chrome/Edge/飞书可执行文件名；失败 HRESULT、零 PID、自身进程继续排除。依据：[Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-getprocessid)。

监听仍须先在“设置与录音环境 → 后台会议联动”勾选允许并保存，默认关闭。目标持续使用输入或输出约 10 秒后开始，全部选定目标停止调用约 30 秒后结束，仅结束联动创建的会议。音频调用并不等同于会议识别：浏览器视频/音乐可能触发，静音但仍保留音频流的会议不会自动结束，独占流不在共享会话监听范围。

Mac 使用 CoreAudio 进程对象与精确 bundle ID，不经过 Windows HRESULT 分支，因此没有同一个返回码缺陷。本轮实际只读采样 3 次均成功返回 `input=false, output=false`，未打开音频流。既有 ABI 回归覆盖未知属性/元数据失败与 CFString 所有权释放。

**验证边界：** macOS 原生回归通过，不能替代 Chrome 实际通话、隐藏窗口、锁屏和设备切换验收。两平台的自动化动作仍依赖主 WebView 收到原生事件；超过 6 秒的陈旧事件或超过 10 秒的采样空档会重置倒计时。本轮没有 Windows 实体机，未证明其隐藏窗口端到端启停通过。

## Pi 已接入并实际运行

Pi Durable 1.4.0 是会议 agent 的实际运行底座，负责任务、持久化检查点、取消和恢复。生产服务启动时创建运行时，`/api/agent/tasks` 实际创建 Pi 任务；会议复盘通过 `read_selected_meeting` 读取冻结文字，再调用既有模型适配层生成带引用结果。它不替换既有录音、ASR、实时纪要、翻译和播放流程，也不覆盖人工纪要。

证据分开看：

- 本轮 `records-agent-api`、`records-meeting-agent`、`records-pi-full-chain` 回归真实运行 Pi 调度/存储与 HTTP 接口，模型使用隔离 fixture。
- 2026-10-31 已有真实本地 ASR + 已配置纪要模型 + Pi 复盘的合成语音链路，复盘约 7.05 秒，详见[全链路验证](pi-full-chain-validation-2026-10-31.md)及[真实结果](../evidence/pi-full-chain-20261031/real-chain-result.json)。这是历史合成数据证据，不是本轮重测真实模型或用户会议。
- Pi 测试包曾由独立分支 Actions 构建，见[旧包回执](../evidence/pi-actions-packages-20261031/receipt.json)；当时未并入 main/Release。v0.2.7 的发布情况另列，不把旧测试包当成本轮已安装证据。

## 远程 Skill 和插件

**当前没有远程安装入口或远程 Skill 装载器。** Skills 页只注册内置 `meeting-review@1`；插件页只有内置的只读会议资料工具。不能通过粘贴 GitHub 地址、下载 `SKILL.md` 或放入 Codex 的技能目录，让聆记自动安装并执行。独立原型中的安装流程是设计，不是产品能力。MCP 连接和定时自动化同样尚未接入。

现有使用路径：扩展中心 → 会议助手 → 选择 1–8 场已有转录的会议 → 输入整理目标 → 确认文字范围和向已配置模型发送的授权 → 确认并开始。内置 Skill 也可在详情中点“在会议助手中使用”。没有模型配置时明确失败，不自动伪造结果。

## 会议助手和飞书导出

会议助手已落地：目标 1–2000 字，冻结材料总计最多 60000 字符；输出独立摘要、决策和行动候选，引用保留 recordId/segmentId/revision。任务页显示实际状态，可查看引用及取消；不读取原音，不写回会议，不发消息或创建飞书文档。

界面采用现有工作台外壳、标签页、选择会议抽屉、范围确认和运行详情，使用统一浅深主题。见[浅色扩展中心](../evidence/workbench-20261101/extension-light.png)和[深色会议助手](../evidence/workbench-20261101/assistant-dark.png)。

**飞书云文档直发仍未实现。** 当前导出弹窗只提供会议纪要 Markdown 和保留的原音 WAV，另外保留已有备份/分享与行动候选文件。没有飞书 OAuth、目标文档选择、写入 API 或成功回执。现阶段可导出 Markdown 后人工导入飞书；[早期飞书方案](../research/minutes-feishu-skill-publishing-2026-10-30.md)和原型样式不代表已接通。

## 本轮验证

- Node：810 项，809 通过，1 项按既有条件跳过；新增 workspace 弹出菜单滚动回归纳入 `npm test`。
- Rust：46 通过、1 项忽略。Windows 成功码用例先在原判断下失败，再在修复后通过；此用例在 Mac 运行，不代表 Windows 实体采集。
- ESLint、TypeScript、Web 构建通过。构建保留既有大 chunk 提示。
- ego-browser：390、760、1024、1280、1440、1920、3840px 扩展中心无页面横向溢出，品牌未越界、导航字号一致；3840×2053 下纪要高度约 1345px，笔记底部与滚动内容底部相差既定 28px 留白。下拉前后侧栏/页面几何尺寸一致。见[尺寸断言](../evidence/workbench-20261101/browser-checks.json)和[下拉断言](../evidence/workbench-20261101/popup-check.json)。
- 独立只读评审已复核 Windows PID 路径与 Select 行为，发现的深色对比度问题已修复。原有 IDE/播放实验改动留在原工作区，未进入本轮提交。
