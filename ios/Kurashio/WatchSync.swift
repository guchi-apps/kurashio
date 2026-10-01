import Foundation
import WatchConnectivity
import os

/// ダッシュボードのセンサーの値を Apple Watch へ送る（#655）。
///
/// `SharedWidgetSnapshot` を保存したのと同じタイミングで、センサーの部分だけを
/// `updateApplicationContext` で送る。context は「最新の1件だけが届く」仕組みなので、Watchが
/// 離れていても、つながった時に最後の値が届く。**JWTは渡さず、Watch側は通信しない**
/// （`ios/README.md`「Apple Watch」の節）。
final class WatchSync: NSObject, WCSessionDelegate {
    static let shared = WatchSync()

    private let logger = Logger(subsystem: "com.gucchii.kurashio", category: "WatchSync")
    /// 有効化が済む前に届いた送信。有効化の完了で送る
    private var pending: [String: Any]?
    /// 最後に送った中身。変わっていなければ送らない（context は上書きで済むが、無駄な送信を避ける）
    private var lastSent: Data?

    private override init() { super.init() }

    /// 起動時に呼んで、セッションを有効化しておく（Watchを持たない端末では何もしない）
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil { session.delegate = self }
        if session.activationState != .activated { session.activate() }
    }

    /// `widgetSnapshot` の辞書から、センサーの値をWatchへ送る
    func send(snapshot raw: [String: Any]) {
        guard let payload = WatchSnapshot.payload(from: raw) else {
            // センサーが1台も無い（すべて非表示など）ときは、古い値を残さず消す
            clear()
            return
        }
        guard let data = WatchSnapshot.encode(payload), data != lastSent else { return }
        lastSent = data
        deliver([WatchSnapshot.contextKey: data])
    }

    /// ログアウト時。Watch側の保存とコンプリケーションを消させる
    func clear() {
        lastSent = nil
        deliver([WatchSnapshot.clearedKey: true])
    }

    private func deliver(_ context: [String: Any]) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            pending = context
            activate()
            return
        }
        push(context, on: session)
    }

    private func push(_ context: [String: Any], on session: WCSession) {
        guard session.isPaired, session.isWatchAppInstalled else { return }
        do {
            try session.updateApplicationContext(context)
        } catch {
            logger.error("Watchへ送れない: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - WCSessionDelegate

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            guard let context = self.pending else { return }
            self.pending = nil
            self.push(context, on: session)
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // 複数のWatchを切り替えたあとは、新しいセッションを有効化し直す
        session.activate()
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        // Watchアプリがあとからインストールされたとき、最後の値を送り直す
        Task { @MainActor in
            if let data = self.lastSent, session.activationState == .activated, session.isWatchAppInstalled {
                self.push([WatchSnapshot.contextKey: data], on: session)
            }
        }
    }
}
