import Foundation
import WatchConnectivity
import WidgetKit

/// iPhoneのkurashioから届いたセンサーの値を受け取り、App Groupへ書いてコンプリケーションを更新する。
final class WatchConnection: NSObject, ObservableObject, WCSessionDelegate {
    /// `nil` はまだ一度も届いていない・ログアウトされた
    @Published private(set) var payload: WatchSnapshot.Payload?

    override init() {
        payload = WatchSnapshot.load()
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func apply(_ context: [String: Any]) {
        if context[WatchSnapshot.clearedKey] != nil {
            WatchSnapshot.clear()
            DeviceSensors.clearToken()
            payload = nil
        } else {
            // 端末用トークン（#683）。context は最新の1件なので、無ければ捨てられたということ
            if let token = context[WatchSnapshot.deviceTokenKey] as? String {
                DeviceSensors.saveToken(token)
            } else {
                DeviceSensors.clearToken()
            }
            if let data = context[WatchSnapshot.contextKey] as? Data,
               let received = WatchSnapshot.decode(data) {
                WatchSnapshot.save(received)
                payload = received
            }
        }
        WidgetCenter.shared.reloadAllTimelines()
        // 渡された値は古いことがあるので、トークンがあればすぐ取り直す
        Task { await refreshFromServer() }
    }

    /// 端末用トークン（#683）でサーバーから取り直し、画面とコンプリケーションへ反映する。
    /// トークンが無い・直近に取った・取れなかったときは何も変えない
    @MainActor
    func refreshFromServer() async {
        guard let updated = await WatchSnapshot.refreshed(), updated != payload else { return }
        payload = updated
        WidgetCenter.shared.reloadAllTimelines()
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        // アプリが閉じていた間に届いた最後の値
        let context = session.receivedApplicationContext
        guard !context.isEmpty else { return }
        DispatchQueue.main.async { self.apply(context) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        DispatchQueue.main.async { self.apply(applicationContext) }
    }
}
