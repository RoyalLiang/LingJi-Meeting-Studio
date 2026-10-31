# PROTOTYPE：Pi 会议调度 fixture

验证问题：Pi Durable 1.4.0 能否承载会议Skill/插件任务的排队、取消、持久恢复与版本切换，哪些策略仍需聆记实现？这是可丢弃的隔离实验，不被主程序或根工作区依赖。

使用Node26.12.1。首次在本目录执行 `npm ci --ignore-scripts`，此后从仓库根目录用一个命令运行：

```sh
npm --prefix services/records/prototypes/pi-meeting-fixture test
```

只用官方faux假模型、合成会议与模拟资料源；禁止fetch，没有编码工具或生产Record API。SQLite只放临时目录用于验证恢复，结束后清理。逐例输出已断言状态；区分Pi原生行为与fixture中的会议宿主策略。没有验证真实模型质量、MCP传输、恶意代码隔离或生产会议权限。

当前8个场景：会议Skill/正确工具结果/引用及撤权、忙时排队和输入去重、工具并发模式、父子agent取消、不配合插件的取消边界、宿主deadline、旧插件版本恢复、真实SIGKILL后的检查点恢复。正常路径应输出`passed:8`，失败的工具结果必须让进程非零退出。

关键边界：版本化任务名称和会议授权由fixture宿主提供；Pi不会自动保留或下载旧插件，也不能强制停止同进程中忽略取消的代码。崩溃例使用虚拟时钟，只验证已提交checkpoint及完成phase不重放，不验证外部副作用或断电。
