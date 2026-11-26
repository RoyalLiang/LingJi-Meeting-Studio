import SwiftUI
import WebKit

@main
struct LingJiApp: App {
    @State private var theme: ColorScheme?

    var body: some Scene {
        WindowGroup {
            MeetingWebView { theme = $0 }
                .ignoresSafeArea(.container)
                .preferredColorScheme(theme)
        }
    }
}

struct MeetingWebView: UIViewRepresentable {
    let onTheme: (ColorScheme?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onTheme: onTheme) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "LingJi-iOS/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "1.0")"
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(context.coordinator, name: "lingjiMicrophone")
        configuration.userContentController.add(context.coordinator, name: "lingjiTheme")
        configuration.userContentController.addUserScript(WKUserScript(source: """
            const syncLingJiTheme = () => {
                let theme;
                try { theme = localStorage.getItem('meeting-theme'); } catch {}
                window.webkit.messageHandlers.lingjiTheme.postMessage(theme === 'light' || theme === 'dark' ? theme : 'system');
            };
            document.addEventListener('meeting:theme', syncLingJiTheme);
            syncLingJiTheme();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.view = view
        context.coordinator.load(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.microphone.finish()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "lingjiMicrophone")
        view.configuration.userContentController.removeScriptMessageHandler(forName: "lingjiTheme")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let page = URL(string: "https://lingji.rookiehouse.com/mobile-app")!
        private let onTheme: (ColorScheme?) -> Void
        weak var view: WKWebView?
        lazy var microphone = NativeMicrophone { [weak self] result in
            guard let view = self?.view, let payload = try? JSONEncoder().encode(result),
                  let json = String(data: payload, encoding: .utf8) else { return }
            view.evaluateJavaScript("dispatchEvent(new CustomEvent('lingji:native-microphone-result',{detail:\(json)}))")
        }

        init(onTheme: @escaping (ColorScheme?) -> Void) { self.onTheme = onTheme }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let frame = message.frameInfo
            guard frame.isMainFrame, let url = frame.request.url, matchesApp(url),
                  let command = message.body as? String else { return }
            switch message.name {
            case "lingjiMicrophone": microphone.receive(command)
            case "lingjiTheme" where command == "dark" || command == "light":
                onTheme(command == "dark" ? .dark : .light)
            case "lingjiTheme" where command == "system": onTheme(nil)
            default: break
            }
        }

        func load(_ view: WKWebView) {
            guard let file = Bundle.main.url(forResource: "mobile", withExtension: "html"),
                  let html = try? String(contentsOf: file, encoding: .utf8) else {
                view.loadHTMLString("<p lang='zh-CN'>无法读取聆记资源，请重新安装。</p>", baseURL: nil)
                return
            }
            view.loadSimulatedRequest(URLRequest(url: page), responseHTML: html)
        }

        private func matchesApp(_ url: URL) -> Bool {
            url.scheme == page.scheme && url.host == page.host && url.port == nil && url.path == page.path
        }

        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if matchesApp(url), action.targetFrame?.isMainFrame == true {
                if action.navigationType == .linkActivated {
                    load(view)
                    return .cancel
                }
                return .allow
            }
            if action.navigationType == .linkActivated,
               action.sourceFrame.isMainFrame, url.scheme == "https" {
                await UIApplication.shared.open(url)
            }
            return .cancel
        }

        func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
            microphone.finish()
            load(view)
        }

        func webView(
            _ view: WKWebView,
            decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
            initiatedBy frame: WKFrameInfo,
            type: WKMediaCaptureType
        ) async -> WKPermissionDecision {
            guard origin.protocol == "https", origin.host == page.host,
                  frame.isMainFrame, type == .microphone else { return .deny }
            return .prompt
        }
    }
}
