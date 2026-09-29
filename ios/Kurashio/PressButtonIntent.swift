import AppIntents
import Foundation

extension Notification.Name {
    /// ウィジェットのボタンが押されて保留ができたとき、アプリのプロセス内で飛ばす（`WebViewModel` が受ける）
    static let widgetPressPending = Notification.Name("com.gucchii.kurashio.widgetPressPending")
}

/// ホーム画面ウィジェット（Large）の電気の操作ボタンを押したときの処理（#546）。
///
/// **ウィジェット自身は送信しない。** 認証（Supabase JWT）をウィジェットへ渡すと、別プロセスが
/// refresh token を更新してWKWebView側と奪い合いログアウトを起こす（#537）。代わりに、押された
/// ボタンIDを `WidgetPressStore` へ書いてアプリを前面に出し、WKWebViewのログイン済みセッションで
/// Web側が `POST /api/remote/buttons/{id}/send` を送る。
///
/// **このファイルはメインApp・Widget Extensionの両方のフォルダに同じ内容を置いている**
/// （`SharedWidgetSnapshot.swift` と同じ理由。1ファイルが1つのtargetにしか属せない）。
/// `openAppWhenRun` の `perform()` はアプリのプロセスで動くため、アプリ側でもコンパイルされている
/// 必要がある。変更するときは `ios/Kurashio/PressButtonIntent.swift` と
/// `ios/KurashioWidget/PressButtonIntent.swift` の両方を揃えること。
struct PressRemoteButtonIntent: AppIntent {
    static var title: LocalizedStringResource { "電気の操作" }
    static var description: IntentDescription { "登録済みのリモコンボタンを押します。" }
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "ボタンID")
    var buttonId: String

    init() {
        buttonId = ""
    }

    init(buttonId: String) {
        self.buttonId = buttonId
    }

    func perform() async throws -> some IntentResult {
        guard !buttonId.isEmpty else { return .result() }
        WidgetPressStore.setPending(buttonId: buttonId)
        // アプリが起動済みなら、Webへ「保留あり」を知らせる。落ちていた（cold start）なら
        // Webが描画後に自分で取りにくる
        NotificationCenter.default.post(name: .widgetPressPending, object: nil)
        return .result()
    }
}
