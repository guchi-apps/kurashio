import Combine
import Network
import SwiftUI
import UIKit
import UserNotifications
import WebKit
import WidgetKit

/// Web版を開く WKWebView と、その読み込み状態を持つ。
final class WebViewModel: NSObject, ObservableObject {
    @Published private(set) var failure: LoadFailure?
    @Published private(set) var isRetrying = false

    let webView: WKWebView

    private let auth = NativeAuth()
    private let pathMonitor = NWPathMonitor()
    private var isNetworkAvailable = true
    private var hasStarted = false
    /// 最後に開こうとしたメインフレームのURL。読み込みに失敗すると `webView.url` は
    /// 直前に表示できていた画面のままなので、再試行はこちらを開き直す
    private var lastRequestedURL: URL?

    override init() {
        let configuration = WKWebViewConfiguration()
        // Cookie・localStorage（Supabaseのセッション）を端末に残し、再起動後もログインを保つ
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = AppConfig.userAgentApplicationName

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        // WKUserContentController は登録した相手を強参照するので、弱参照の中継を挟む
        configuration.userContentController.add(
            WeakScriptMessageHandler(target: self),
            name: AppConfig.bridgeName
        )
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // 読み込み前の一瞬に白い面が出ないよう、ヘッダーと同じ色を下地にする
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "HeaderBand")
        webView.scrollView.backgroundColor = UIColor(named: "HeaderBand")

        // ウィジェットのボタンが押された（アプリが起動済みのとき）。中身は渡さず合図だけ送る（#546）
        NotificationCenter.default.addObserver(
            forName: .widgetPressPending, object: nil, queue: .main
        ) { [weak self] _ in
            self?.nudgePendingWidgetPress()
        }
    }

    deinit {
        pathMonitor.cancel()
    }

    func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true
        WatchSync.shared.activate()

        pathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            DispatchQueue.main.async { self?.networkChanged(available: available) }
        }
        pathMonitor.start(queue: .main)
        load(AppConfig.baseURL)
    }

    func retry() {
        isRetrying = true
        load(lastRequestedURL ?? AppConfig.baseURL)
    }

    private func load(_ url: URL) {
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    private func networkChanged(available: Bool) {
        let recovered = available && !isNetworkAvailable
        isNetworkAvailable = available
        if recovered, failure == .offline { retry() }
    }

    private func fail(with error: Error) {
        let nsError = error as NSError
        // 別の読み込みに置き換わった・レスポンスを見て自分で止めた（5xx）場合は失敗扱いにしない
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain", nsError.code == 102 { return }

        isRetrying = false
        let offlineCodes: Set<Int> = [
            NSURLErrorNotConnectedToInternet,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorDataNotAllowed,
            NSURLErrorInternationalRoamingOff,
        ]
        if !isNetworkAvailable || (nsError.domain == NSURLErrorDomain && offlineCodes.contains(nsError.code)) {
            failure = .offline
        } else {
            failure = .server(status: nil)
        }
    }

    private func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }

    /// ウィジェットの表示データ（`SharedWidgetSnapshot`）が変わった直後に呼ぶ。
    /// Widgetは自発的に再読み込みしない設計（`KurashioTimelineProvider`の`.never`ポリシー）のため、
    /// 変化のたびにこちらから明示的に再評価を促す。
    /// ウィジェットは複数ある（`KurashioWidget`・`GarbageWidget`・#647）ので kind は指定せず全部を再読み込みする
    private func reloadWidgetTimelines() {
        // 室温の「KurashioWidget」・電気の「KurashioEnergyWidget」・ごみの日の「KurashioGarbageWidget」を再評価する（#648・#647）
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func finishSignIn(_ result: NativeAuthResult) {
        switch result {
        case .code(let code):
            var components = URLComponents(
                url: AppConfig.baseURL.appending(path: "auth/callback"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [URLQueryItem(name: "code", value: code)]
            if let url = components?.url { load(url) }
        case .failed:
            var components = URLComponents(url: AppConfig.baseURL, resolvingAgainstBaseURL: false)
            components?.queryItems = [URLQueryItem(name: "authError", value: "failed")]
            if let url = components?.url { load(url) }
        case .cancelled:
            // ボタンを「Googleへ移動しています」から元に戻す（login-screen.tsx が受ける）
            webView.evaluateJavaScript("window.dispatchEvent(new Event('myroom-native-auth-cancelled'))")
        }
    }
}

// MARK: - 読み込み

extension WebViewModel: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }

        if ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }

        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if AppConfig.isAppURL(url) {
            if isMainFrame { lastRequestedURL = url }
            return .allow
        }
        // 埋め込み（iframe）はそのまま。画面ごと他のサイトへ移るものはSafari等で開く
        if !isMainFrame { return .allow }
        openExternally(url)
        return .cancel
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
        // Apache の 502/503（バックエンドの再起動中など）を、素のエラーページのまま見せない
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 500 {
            isRetrying = false
            failure = .server(status: response.statusCode)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isRetrying = false
        failure = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(with: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(with: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // メモリ不足などでWebの描画プロセスが落ちると、白い画面のまま戻らない
        load(lastRequestedURL ?? AppConfig.baseURL)
    }
}

// MARK: - 新しいウインドウ・ダイアログ

extension WebViewModel: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // target="_blank" のリンク。アプリの画面なら同じWebViewで、外部ならSafari等で開く
        if let url = navigationAction.request.url {
            if AppConfig.isAppURL(url) { load(url) } else { openExternally(url) }
        }
        return nil
    }

    /// `window.confirm()`（記録の削除など）。UIDelegateで実装しないと常に false が返り、削除できない
    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            guard present(alert) else { return continuation.resume(returning: false) }
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume() })
            guard present(alert) else { return continuation.resume() }
        }
    }

    private func present(_ controller: UIViewController) -> Bool {
        guard var top = webView.window?.rootViewController else { return false }
        while let presented = top.presentedViewController { top = presented }
        top.present(controller, animated: true)
        return true
    }
}

// MARK: - Webからの呼び出し（ブリッジ）

extension WebViewModel: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // Web版の画面（メインフレーム）からの呼び出しだけを受ける
        let origin = message.frameInfo.securityOrigin
        guard
            message.frameInfo.isMainFrame,
            origin.`protocol` == AppConfig.baseURL.scheme,
            origin.host == AppConfig.baseURL.host,
            let body = message.body as? [String: Any],
            let type = body["type"] as? String
        else { return }

        switch type {
        case "signIn":
            guard
                let urlString = body["url"] as? String,
                let url = URL(string: urlString),
                url.scheme == "https"
            else { return }
            auth.start(url: url) { [weak self] result in
                self?.finishSignIn(result)
            }
        case "requestNotificationPermission":
            requestNotificationPermission()
        case "queryNotificationPermission":
            refreshNotificationAuthorizationStatus()
        case "openSystemSettings":
            openSystemSettings()
        case "widgetSnapshot":
            // ホーム画面ウィジェット（#537）が表示する値を、ダッシュボードが開かれているあいだ
            // App Group共有のUserDefaultsへ書き写す（`frontend/lib/native-app.ts` の
            // `syncWidgetSnapshot()` が送ってくる）。**JWTは一切渡さない**——Widget（別プロセス）が
            // 独自にrefresh tokenを更新すると、WKWebView側のクライアントと同じrefresh tokenを
            // 奪い合ってログアウトを引き起こすため（`CLAUDE.md`「iOSアプリとのつなぎ目」参照）
            guard let snapshot = body["snapshot"] as? [String: Any] else { return }
            SharedWidgetSnapshot.save(snapshot)
            reloadWidgetTimelines()
            // Apple Watch（#655）。センサーの値だけを送る（中身が前回と同じなら送らない）
            WatchSync.shared.send(snapshot: snapshot)
        case "widgetSnapshotCleared":
            SharedWidgetSnapshot.clear()
            WidgetPressStore.clear()
            reloadWidgetTimelines()
            // Watchに残る別アカウントの値も消す（#655）
            WatchSync.shared.clear()
        case "widgetReady":
            deliverPendingWidgetPress()
        case "widgetPressResult":
            // Webが送った結果（ack）。ここで初めて保留を消し、ウィジェットへ結果を出す
            guard
                let key = body["key"] as? String,
                let status = (body["status"] as? String).flatMap(WidgetPressStore.Status.init(rawValue:))
            else { return }
            WidgetPressStore.acknowledge(key: key, status: status)
            reloadWidgetTimelines()
        default:
            break
        }
    }
}

// MARK: - ウィジェットのボタン押下（#546）

extension WebViewModel {
    /// 保留があれば、Webへ中身の無い合図（`myroom-native-widget-press-available`）だけを送る。
    /// 起動直後でWebがまだ無いときは届かないが、Webが描画後に `widgetReady` で取りにくる。
    /// **中身をここから渡さない**——復帰時の自動リロードと重なると取りこぼす・二重に送るため
    func nudgePendingWidgetPress() {
        guard WidgetPressStore.pending() != nil else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('myroom-native-widget-press-available'))"
        )
    }

    /// Webの `widgetReady`（取りにきた）への返事。保留は結果（ack）が届くまで消さない
    fileprivate func deliverPendingWidgetPress() {
        guard let pending = WidgetPressStore.pending() else { return }
        // キー（UUID）とボタンID（remote.json 由来）を、JSの文字列としてそのまま埋めない
        var detail: [String: Any] = ["key": pending.key, "buttonId": pending.buttonId]
        // エアコンの操作（#649）だけ。電気の操作では付けない
        if let acId = pending.acId, let action = pending.action {
            detail["acId"] = acId
            detail["action"] = action
        }
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('myroom-native-widget-press', { detail: \(json) }))"
        )
    }
}

// MARK: - 通知（APNs・#527）

extension WebViewModel {
    /// アプリ起動・復帰のたびに呼ぶ。OSへ問い合わせるだけで、ダイアログは出さない。
    /// 許可済みなら `registerForRemoteNotifications()` でトークンを取り直す（端末変更・再インストール後の更新のため）
    func refreshNotificationAuthorizationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    UIApplication.shared.registerForRemoteNotifications()
                case .denied:
                    self.dispatchNotificationState(permission: "denied", token: nil)
                default:
                    self.dispatchNotificationState(permission: "default", token: nil)
                }
            }
        }
    }

    /// 「有効にする」操作。許可が未確定のときだけOSのダイアログが出る（確定済みならそのまま返る）
    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            DispatchQueue.main.async {
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                } else {
                    self.dispatchNotificationState(permission: "denied", token: nil)
                }
            }
        }
    }

    /// `AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken` から呼ぶ
    func handleDeviceToken(_ token: String) {
        dispatchNotificationState(permission: "granted", token: token)
    }

    /// `AppDelegate.didFailToRegisterForRemoteNotificationsWithError` から呼ぶ。
    /// 許可自体は取れているため、許可状態は変えずトークンだけ無しにする
    func handleRemoteRegistrationFailure() {
        dispatchNotificationState(permission: "granted", token: nil)
    }

    /// 通知タップ（`AppDelegate`のUNUserNotificationCenterDelegate）から呼ぶ。
    /// 現状の通知はすべて `url: "/"` のためダッシュボードを開く
    func handleNotificationTap(path: String) {
        open(path: path)
    }

    private func open(path: String) {
        guard let url = URL(string: path, relativeTo: AppConfig.baseURL), AppConfig.isAppURL(url) else {
            load(AppConfig.baseURL)
            return
        }
        load(url)
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    /// Web側（`lib/native-app.ts`の`NATIVE_NOTIFICATION_STATE_EVENT`）へ状態を届ける
    private func dispatchNotificationState(permission: String, token: String?) {
        let tokenLiteral = token.map { "\"\($0)\"" } ?? "null"
        let script = """
        window.dispatchEvent(new CustomEvent('myroom-native-notification-state', \
        { detail: { permission: '\(permission)', token: \(tokenLiteral) } }))
        """
        webView.evaluateJavaScript(script)
    }
}

/// `WKUserContentController.add(_:name:)` の強参照で WebViewModel が解放されなくなるのを防ぐ
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// SwiftUI に WKWebView を置くための入れ物。WebView 本体は WebViewModel が持ち続ける
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
