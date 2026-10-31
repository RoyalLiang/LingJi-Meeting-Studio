# v0.1.31 回放与计时核验（2026-10-27）

[v0.1.31 已发布](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.31)；[Actions 40516041265](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265)五项任务成功。三个公开安装器已完整下载、校验格式/大小/SHA-256，源码清单与标签归档一致。

## 固定来源

- 源码与工作流提交：`234495e1677f912c9eef1232dbd7fcd10f7d4140`，标签 `v0.1.31`，macOS build `0.1.53`。
- 固定源码333文件，清单SHA-256：`4d5fb47c412af69c5f058a330e39e1b715a0660f6b2139121f66f2232c1518e7`。
- GitHub标签ZIP归档780文件与固定提交逐字一致，归档SHA-256：`0c599d78d72c506dfa59db49837739f9fbefbf12d4eaba792734e09ce7abe60e`。
- 无新增依赖，不改用户原始 PCM、历史纪要、模型配置或历史音源起点。

## 六项请求与结果

1. 结束后直接显示原音播放按钮，无额外加载入口；WAV使用`preload=none`，合成双轨初始原音请求为0，波形在后台读取；已保存时长支持先定位再播放。
2. 标题同排保留状态与录音时长，创建日期、转录版本、留存和目录移到悬浮提示，移除独立信息行。
3. 播放器202.44px压至119px，移除会议录音/双轨文字，保留44px播放和定位目标；时间刻度与波形两侧各20px。顶部连接主行与搜索框中心误差小于1px，待保存数量单独定位。
4. 0.75–2倍速的一秒媒体采样回归通过；保留静态波形、独立插值游标和音高校正。双轨播放前对齐，按最大重叠源数预留音量，顺序续录片段不因源总数变多而变小声。
5. 重新整理不触发全页busy；设置与失败提示共用局部防重复控制。真实App提交时无关置灰按钮由10降至0，失败提示连点只产生1个POST。错误/成功均释放提交状态。
6. 主窗与小窗按单调时钟显示会中时长，批量音频和回传不改变走速；暂停/结束以真实保存时长为准，切会重置。

## 额外复现的同链路缺陷

暂停续录和晚接入音源原先按源局部时间播放，恢复段可能与先前片段叠播，共享进度尾部无法播放。真实API红例：总时长1.5秒、恢复段起点1秒，但其WAV/波形只有0.5秒，定位到1.25秒后不播放。修复新源起点，并在回放响应虚拟补齐静音；音频、波形和共享定位现在使用同一时间轴。

虚拟静音按最多64KB缓冲流式输出，Range仅读取相交部分。header-only/静音区读原音0块，跨静音与PCM边界及尾部读1块；大于64KB前缀通过独立复核。原始PCM、digest、usage.samples及重传幂等保持不变；全量回归覆盖来源身份、转录修订、恢复/游标和停止排空。

第一次播放前先等待媒体时长，排除已结束的短轨；等待有15秒上限并可取消，迟到加载不自动播放。错误重载会保留所选定位。独立Chrome曾观察到短轨在前的冷首轮偶发现象；主代理原脚本未稳定复现，因此不把它写成确定的浏览器红绿结论。未知媒体选择、取消和load重置定位使用确定性单元红例锁定，修复后真实Chrome三种源顺序均正常。

## 本地和浏览器验证

- Node24完整549/549；锁定Rust smoke-test34/34；lint/typecheck/Web构建通过，文档182份检查通过（补记前），合入并行会话与本轮回执后186份检查通过。独立定向44/44，属于重叠子集不相加。
- 真实Chrome合成双轨、媒体时间按秒取整：193帧、0停顿，最大位移0.149px；2倍速440Hz正弦测得439.453Hz，数字峰值0.800005，双轨音量均0.5。
- 真实App无上传与PCM批量回传时，4秒采样时长为120、120、121、121、122、122、123、123、124秒。
- 浅/深主题390px及1440px截图核对，无横向溢出或页面异常；保留播放、15秒跳转、倍速、键盘定位与失败重试。
- API额度恢复后完整读取全状态Issues，共0条，无可评论关闭的相关条目；此前公开搜索结果一致。

## 验证边界

未验证用户Windows设备、真实声卡/音箱、长会议负载或真人语音各倍速主观音质。正弦频谱与数字峰值不能替代听感，浏览器原生时间拉伸仍可能改变音色。

新音源起点以服务端已持久化PCM进度为依据，网络与亚批次延迟下的物理同步精度仍待真机校准。历史记录保留已保存的起点；无法可靠推断旧会议中晚开启音源的真实起点，本轮不猜测回写。Windows未代码签名，macOS ad-hoc且未公证；本机未替换安装。

## 后台结果与公开包核验

核验时间：2026-10-27T14:43:20.605Z。

- [verify](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265/job/122230116673)：success。
- [build](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265/job/122230253009)：success。
- [build_windows](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265/job/122230252991)：success。
- [build_linux](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265/job/122230253012)：success。
- [publish](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40516041265/job/122251988404)：success。

Windows隐藏录音与重启回放于13:58:59–14:12:18 UTC通过（13分19秒），随后安装器检查成功；macOS与Linux的对应原生、包内启动与安装验证也通过。CI/合成录音不能替代用户设备验收。

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| [Lingji-0.1.31-linux-amd64.deb](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.31/Lingji-0.1.31-linux-amd64.deb) | 222654900 | `559d7c8636df5d7a7212a06000e3feaa7742605e8c498df3a2d3b690eff4d84b` |
| [Lingji-0.1.31-macos-arm64.dmg](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.31/Lingji-0.1.31-macos-arm64.dmg) | 219564357 | `b8921423aa103d21e4f66637c3319eedac6f84cf1c44fb24b43c39b8dcae22ef` |
| [Lingji-0.1.31-windows-x64-setup.exe](https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v0.1.31/Lingji-0.1.31-windows-x64-setup.exe) | 407715136 | `18ac122424a6b3401a67c335ffeec33a888aedc604fdad039c69e90a1ced0f18` |

初始run源码与Issues读取使用GitHub官方API；共享匿名额度再次耗尽后，最终任务状态来自官方公开Actions页，Release附件来自官方展开页、正文校验值和下载HEAD。保留来源类型，没有将HTML派生元数据描述为API响应。公开包由本机完整下载核对；三平台原始报告留在Actions，本机没有重新下载/解包受登录限制的报告，内部同源约束由成功publish任务校验。

公开全状态Issues搜索在发布后复核仍无结果，无可评论关闭的条目。并行会话main已有v0.1.32更新，本轮在完成固定v0.1.31验证后保留其全部代码；回执补记不重建安装器、不移动标签，也不为文档创建新版本。
