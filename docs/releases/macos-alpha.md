# 安装聆记 macOS Alpha

此版本为 **0.1.0-alpha.1**，适用于 **Apple Silicon（M 系列）Mac，macOS 14.6 或更新版本**。安装包包含界面和原生音频采集，转录、纪要、账户及历史记录沿用已有 Record API 与 worker。

## 安装并连接现有服务

1. 打开 `Lingji-0.1.0-alpha.1-macos-arm64.dmg`。
2. 把 **聆记 Alpha.app** 拖到 **Applications**。
3. 确认已有 Record API 与 worker 正在运行，再打开应用。默认连接 `http://127.0.0.1:3030`，使用已有账户登录。

这是本机签名的内部测试包，没有 Developer ID 签名或 Apple 公证。macOS 可能阻止首次打开；核对包来源后，通过 **系统设置 → 隐私与安全性 → 仍要打开** 完成首次授权，具体步骤见 [Apple 的首次打开说明](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)。不要关闭系统安全机制。

如服务使用其他地址，退出应用，在 `~/Library/Application Support/com.tts.meeting/client.json` 写入：

```json
{
  "apiUrl": "http://127.0.0.1:3031"
}
```

然后重新打开应用。远程服务需使用 HTTPS 根地址，例如 `https://records.example.com`；地址不能含路径、账户、查询参数或片段。模型密钥只配置在后端。此包不启动或重启 API 与 worker，也不包含后端配置、密钥或会议数据。

## 开始测试录音

默认只采集系统播放音频，麦克风需要手动开启。第一次采集可能触发 macOS 系统音频或麦克风权限提示；拒绝后会明确报错。应用内的采集确认与系统权限分别生效。系统音频可能包括其他应用声音，请在确认后开始。

本包使用 `com.tts.meeting` 配置目录，与现有原生客户端共用本机配置。浏览器中的历史仍保存在后端，浏览器尚未补传的录音不会自动迁入原生客户端。更换或移除应用前，请结束录音并确认补传完成。

## 核对安装包

安装包旁的 `SHA256SUMS.txt` 保存文件校验值。在该目录运行：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

`release.json` 记录版本、构建源文件哈希、Git 基线、未提交状态及验证范围。Alpha 可从当前工作区构建，不能仅凭 Git 提交号复现未提交输入。

## 重新构建本地 Alpha

在项目根目录运行：

```sh
node scripts/release-macos-alpha.mjs
```

命令先冻结当前构建源文件，再在隔离目录构建 Web 和正式 Tauri 应用，生成 DMG，挂载并复制应用到临时目录，再用隔离 API 验证内置页面启动。它不采集真实音频、不调用真实供应商、不改变已有会议或已有服务。同版本输出已存在时会停止，避免覆盖；下次发版需更新 `tauri.alpha.conf.json` 的 Alpha 版本、数字构建号和本说明。

产物位于 `dist/releases/0.1.0-alpha.1/`。构建验证覆盖 DMG 完整性、arm64 架构、签名、权限描述和正式应用启动；真实会议软件采音、长会话、远程 HTTPS、全新 Mac 安装及 Gatekeeper 首次授权仍需实测。

退出应用后，可把 **聆记 Alpha.app** 移到废纸篓。配置和待补传数据保留在应用支持目录，卸载时不要顺手删除。
