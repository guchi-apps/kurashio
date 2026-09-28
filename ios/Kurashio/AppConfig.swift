import Foundation

/// アプリ全体で使う定数。画面・機能はすべてWeb版（正本）にあり、アプリはそれを開く殻に徹する（#526）。
enum AppConfig {
    /// Web版のURL。開発サーバーへ向けるときもここだけを変える（ios/README.md）
    static let baseURL = URL(string: "https://myroom.gucchii.com/")!

    /// Googleログインの戻り先のスキーム。`kurashio://auth-callback` を Supabase の
    /// 許可リダイレクトURLに登録しておく必要がある。
    /// Web側の `frontend/lib/native-app.ts` の `NATIVE_AUTH_REDIRECT` と揃えること
    static let authCallbackScheme = "kurashio"

    /// Web側がアプリの中で開かれていると知るための入口。
    /// `window.webkit.messageHandlers.kurashioAuth` の有無で判定している（native-app.ts）
    static let bridgeName = "kurashioAuth"

    /// User-Agentの末尾に足す識別子（`KurashioIOS/1.0` の形）。
    /// 既定の `Mobile/…` を消すとスマホ向けの判定が崩れるサイトがあるため、残したまま足す
    static var userAgentApplicationName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "Mobile/15E148 KurashioIOS/\(version)"
    }

    /// このURLがアプリで開くべきWeb版の画面か（ホスト・スキーム・ポートまで一致）
    static func isAppURL(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
    }
}
