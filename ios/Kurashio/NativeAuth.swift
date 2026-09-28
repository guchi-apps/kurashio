import AuthenticationServices
import UIKit

/// Googleログインを iOS 標準の認証シート（ASWebAuthenticationSession）で行う（#526）。
///
/// Googleは埋め込みのWebView（WKWebView）でのログインを `disallowed_useragent` で拒むため、
/// 認証画面だけをシートへ出す。流れは次のとおりで、**トークンはこのクラスを通らない。**
///
/// 1. Web側が PKCE の認可URLを作り、`code_verifier` を WKWebView のストレージに残したまま
///    ブリッジ（`kurashioAuth`）でURLだけを渡してくる
/// 2. シートで Google → Supabase と進み、`kurashio://auth-callback?code=…` で戻る
/// 3. `code` を WKWebView の `/auth/callback?code=…` へ渡し、交換・許可の確認・ログイン通知は
///    Web版と同じコールバックが行う（`frontend/app/auth/callback/page.tsx`）
///
/// `code` は一度きりで、`code_verifier`（WebViewの中にしか無い）が無ければ交換できない。
enum NativeAuthResult {
    case code(String)
    case failed
    case cancelled
}

final class NativeAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, completion: @escaping (NativeAuthResult) -> Void) {
        // 連打で2枚目のシートを出さない
        guard session == nil else { return }

        let session = ASWebAuthenticationSession(
            url: url,
            callback: .customScheme(AppConfig.authCallbackScheme)
        ) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.session = nil
                completion(Self.result(callbackURL: callbackURL, error: error))
            }
        }
        session.presentationContextProvider = self
        // Safariのログイン状態を使い、毎回Googleのパスワードを求めないようにする
        session.prefersEphemeralWebBrowserSession = false
        self.session = session

        if !session.start() {
            self.session = nil
            completion(.failed)
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
            return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        }
    }

    private static func result(callbackURL: URL?, error: Error?) -> NativeAuthResult {
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
            return .cancelled
        }
        guard
            let callbackURL,
            let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems,
            let code = items.first(where: { $0.name == "code" })?.value,
            !code.isEmpty
        else {
            return .failed
        }
        return .code(code)
    }
}
