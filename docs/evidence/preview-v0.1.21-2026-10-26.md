# v0.1.21 交付验证（进行中）

本轮范围与使用方式见[发布说明](../releases/v0.1.21-preview.md)。当前仅完成本地回归与源码评审，尚未视为已发布。

本地：474 项 Node 回归、32 项 Rust 回归、TypeScript、ESLint、Web 构建通过。缺陷修复先验证失败任务去重与默认间隔的红色回归，再修复转绿。Windows 轻量原生 DLL 哈希与三屏界面夹具 [40214343384](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40214343384) 通过。

独立评审发现的私有会话/profile、胶囊 ready 后最小化、安装 DLL/GUI 初始化分离、Windows 路径别名、WebView2 一致环境与测试预算问题已修正。Windows [40220795162](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40220795162) 的六分钟隐藏录音、采样覆盖与重启完整补传步骤通过；该次后续打包因短路径漏生成哈希清单失败，未计为发布成功。双侧路径规范化修正后，[40223322837](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40223322837) 的真实短路径、三屏界面、完整打包和默认/取消模型及较旧注册版本夹具覆盖升级步骤通过，包含未变模型时间戳、变化资源恢复与同一安装器 HWND 断言。诊断流程最终收集步骤缺少正式版本输出而失败；正式版本仍须四项工作流全部通过。

修正后，本机原生 WebView 自动夹具通过：私有会话加载、胶囊自动最小化/暂停/返回/结束确认、设置取消后重开、后台录音与重启队列补传均有断言通过。较早失败夹具不计为通过。本机 CUA 人工鼠标/键盘与视觉验收仍受 Mac 锁屏阻塞；未使用浏览器调试。公开安装包、远端源码/标签、附件与校验和待正式发布后核对。


v0.1.20 [40226397818](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/40226397818) 在 verify 阶段发现 preview 覆盖版本仍为 0.1.19（基础配置为 0.1.20），构建和发布均跳过。保留失败标签，以 v0.1.21 修正；新增实际仓库版本回归先复现该不一致，再转绿。
