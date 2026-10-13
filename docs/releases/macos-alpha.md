# 安装聆记 macOS Alpha

此版本为 **0.1.0-alpha.5**，适用于 **Apple Silicon（M 系列）Mac，macOS 14.6 或更新版本**。安装包包含界面、原生音频采集及独立客户端后台；打开应用即可启动本机 Record API 和 worker，无需运行 Web 开发服务或安装 Node。

本版改用独立本机账户和数据目录，SQLite 与音频使用带校验的无损压缩。已有 Web 或旧 Alpha 的账户、会议、密钥和待补传队列不会自动迁入。升级前请结束旧会议并等补传完成，再替换应用；保留原后台及旧数据目录，以便查阅原有会议。

## 安装并配置客户端

1. 打开 `Lingji-0.1.0-alpha.5-macos-arm64.dmg`。
2. 将 **聆记 Alpha.app** 拖到 **Applications**，从应用程序目录打开。
3. 应用自动使用本机账户。在 **设置** 中填写转录、纪要及翻译所需的服务地址、模型与密钥。
4. 完成配置后再开始需要云端识别或 AI 纪要的录音测试。

安装包不含开发环境的密钥、配置或会议数据；正式包也不使用旧 `client.json` 中的后台地址。关闭 Web 开发后台不会影响客户端本地保存与历史读取；云端转录和 AI 纪要仍需要网络及有效的供应商配置。

当前包采用 ad-hoc 签名，尚未完成 Developer ID 签名与公证。首次打开可能被 Gatekeeper 拦截；请按 [Apple 的首次打开说明](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)处理，不要关闭系统安全机制。

## 保存本机数据

macOS 默认数据目录为 `~/Library/Application Support/com.tts.meeting`。独立后台在其 `backend/` 下保存 SQLite、音频对象和供应商配置；内置运行时为 Node 24.21.0，SQLite 3.53.4。关闭应用后，会议数据仍保留在本机。

SQLite 使用 WAL 与 FULL 同步保存记录、转录、纪要和任务；大段记录 JSON 与音频按收益使用无损压缩，无法有效压缩的内容保留原样。音频标识与校验仍依据原始 PCM，读取兼容旧原始对象。WebView IndexedDB 的 48 MiB 待传队列继续保留，收到本地后台持久 ACK 后移除已确认片段。

后台目录权限为 `0700`，供应商配置文件权限为 `0600`。密钥在 `backend/providers.json` 中以明文保存；压缩不等于加密。本版没有 Keychain 集成、跨设备同步或自动备份。不要删除数据目录来解决安装或启动问题。

原 Web/旧 Alpha 的数据与 profile 保留，独立后台使用单独的稳定 profile；后台端口改变不会更换新 profile。原环境的历史仍需通过原服务查看，本版不执行自动迁移。

## 开始测试录音

默认只采集系统播放音频，麦克风需要手动开启。第一次采集可能触发 macOS 系统音频或麦克风权限提示；拒绝后会明确报错。应用内的采集确认与系统权限分别生效。系统音频可能包括其他应用声音，请在确认后开始。

暂停、继续与结束会议沿用现有协议。网络暂不可用时，音频可先保存到本机后台，供应商任务等待恢复；若本机后台不可用，待传队列仍有 48 MiB 上限，达到上限会明确停止并提示。应用重开会恢复中断任务；恢复能力不能替代长会话、设备拔插与休眠实测。

## 核对安装包

安装包旁的 `SHA256SUMS.txt` 保存文件校验值。在该目录运行：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

`release.json` 记录版本、构建源文件哈希、Git 基线、内置运行时与验证范围。当前工作区模式可能包含未提交输入，不能仅凭 Git 提交号复现；按指定提交构建的模式会排除其他会话尚未提交的改动。

## 重新构建本地 Alpha

在项目根目录运行：

```sh
node scripts/release-macos-alpha.mjs
```

需要只打包指定已提交版本时，运行：

```sh
TTS_RELEASE_SOURCE_REF=<提交号> node scripts/release-macos-alpha.mjs
```

命令冻结构建输入，校验并准备随包 Node 与后台资源，在隔离目录构建 Web 和正式 Tauri 应用，再生成 DMG。安装验证使用临时应用副本和独立数据目录，不访问现有会议、重启已有服务、采集真实音频或调用真实供应商。同版本输出已存在时会停止，避免覆盖；下次发版需更新 `tauri.alpha.conf.json` 的 Alpha 版本、数字构建号和本说明。

产物位于 `dist/releases/0.1.0-alpha.5/`。验收需核对 DMG 完整性、arm64 架构、签名、权限描述、内置后台独立启动与重启持久化；本轮具体结果以产物及验证记录为准。合成压缩基准不代表真实语音的压缩率或模型总耗时。真实会议软件采音、长会话、全新 Mac 安装及 Gatekeeper 首次授权仍需实测。

退出应用后，可把 **聆记 Alpha.app** 移到废纸篓。配置、会议与待补传数据保留在应用支持目录，卸载时不要顺手删除。

## 菜单栏与安装界面

安装磁盘使用固定窗口、翡翠色背景和左右拖拽布局。将聆记拖到 Applications 后，从应用程序目录打开；安装说明与校验文件随下载提供。安装包图标由 `apps/desktop/assets/lingji-app-icon.svg` 生成；PNG/ICO 按文件哈希核对，ICNS 按内部图片块哈希核对。

macOS 顶部菜单栏使用随系统明暗变化的单色图标。左键打开聆记，右键查看会议、录音、后台连接与待上传音频数量，并使用暂停、继续本场、结束本场、设置、隐藏和退出操作。退出复用录音与补传保护；页面状态超过 5 秒未更新时，菜单标记待确认并停用会议操作。隐藏窗口会保留记录。

布局采用 [Tauri DMG 配置](https://v2.tauri.app/distribute/dmg/)，菜单使用 [Tauri 原生系统托盘](https://v2.tauri.app/learn/system-tray/) 和 [Apple 菜单设计规范](https://developer.apple.com/design/human-interface-guidelines/menus)。
