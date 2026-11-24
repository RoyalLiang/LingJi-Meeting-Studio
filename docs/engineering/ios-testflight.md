# iOS TestFlight 构建

iOS 版使用 Swift 和 WKWebView 运行随包安装的移动工作台。应用使用 `https://lingji.rookiehouse.com` 的账号和加密同步接口。首次登录需要联网。已解锁资料库可在前台录音，录音先加密写入本机，再排队同步。麦克风和网络状态由 iOS 与 WebKit 管理。

## 构建和分发

1. 在 Xcode 打开 `apps/ios/LingJi.xcodeproj`。选择 **Product → Xcode Cloud → Create Workflow** 完成首次关联。工程使用共享的 **LingJi** scheme。iOS 与 macOS 共享 **聆记 LingJi** App 记录和 Bundle ID。
2. 选择需要构建的 GitHub 分支，添加 iOS **Archive** 操作。在归档后添加 **TestFlight Internal Testing** 操作，选择内部测试组。
3. Xcode Cloud 执行工程旁的 `ci_scripts/ci_post_clone.sh`。脚本按 `package.json` 的 Node 版本和锁文件安装依赖，执行 `npm run build:ios`，将工作台打包到 `apps/ios/Generated/mobile.html`。Cloud 随后归档、签名并上传。
4. 等待归档和 Apple 处理完成。在 App Store Connect 的 **TestFlight → iOS** 核对版本、构建号、内测组和可测试状态。按 Apple 提示填写该构建的出口合规信息。

[Apple 首次配置 Xcode Cloud](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow) · [Apple 自定义构建脚本](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts)

## 内测验收

用 iPhone 登录并解锁资料库后，允许麦克风，开始、暂停、继续、结束并回听一段录音。已登录时切到飞行模式再录一段，恢复联网后核对桌面是否接收、录音时长是否一致。记录来电、切后台、锁屏以及撤销麦克风权限后的表现。当前设计以 iOS 前台麦克风录音为范围。系统通话音频、锁屏持续录音和 Android 优先直传由各自的原生入口处理。
