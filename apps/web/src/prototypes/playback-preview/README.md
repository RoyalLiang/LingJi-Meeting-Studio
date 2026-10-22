# 录音快进控件预览（待用户选择）

这是现有 C 版会议头部中的一次性 UI 原型。只使用虚构会议、模拟时间与波形，不读取真实音频，不调用会议 API，不修改生产播放器。

运行：`node apps/web/src/prototypes/playback-preview/preview.mjs`，打开 `http://127.0.0.1:4184/?variant=A`。三种方案用 URL 参数 A/B/C 与底部切换条选择。

- A：一行完整控制，±15 秒、拖动进度与倍速持续可见。
- B：按需浮层，保持标题栏紧凑，播放入口展开完整控件。
- C：精确波形，增加可拖动波形与指定时间跳转，适合精听。

用户尚未选择；原型不能直接发布为生产实现。

## macOS 安全提示核查

v0.1.2 公开 DMG 与发布摘要相符；只读挂载后 codesign 完整性校验通过，但 Signature=adhoc、TeamIdentifier=not set，Gatekeeper 评估拒绝。本轮没有可用的 Developer ID 签名和公证凭据。

正规消除“开发者无法验证”提示需要 Developer ID Application 分发签名与 Apple 公证，当前缺少账号和证书，不能将该问题标为已修复。仓库的正式发行工作流已有证书导入及信任校验入口，正式启用仍需账号、证书和公证凭据。

临时测试可按 Apple 官方流程：先尝试打开应用，再到系统设置 → 隐私与安全性 → 仍要打开 → 打开。这是此 Mac 对此应用的例外授权，不等于分发包已被 Apple 公证。此流程仅适用于本次用户确认的“无法验证开发者”，不用于损坏或恶意软件警报。

来源：
- https://developer.apple.com/developer-id/
- https://support.apple.com/en-us/102445
- https://v2.tauri.app/distribute/sign/macos/
