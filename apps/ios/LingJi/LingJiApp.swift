import SwiftUI
import WebKit

@main
struct LingJiApp: App {
    var body: some Scene {
        WindowGroup {
            MeetingWebView()
                .ignoresSafeArea(.container)
        }
    }
}

struct MeetingWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "LingJi-iOS/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "1.0")"
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.load(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let page = URL(string: "https://lingji.rookiehouse.com/mobile-app")!

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

        func webViewWebContentProcessDidTerminate(_ view: WKWebView) { load(view) }

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
