import UIKit
import UserNotifications

/// APNs（#527）のデバイストークン取得・通知タップ時の画面遷移を受け持つ。
///
/// `KurashioApp`はSwiftUIのライフサイクル（`@main struct ... App`）のため、
/// UIKitのコールバック（トークン取得・通知タップ）を受けるにはUIApplicationDelegateを
/// `@UIApplicationDelegateAdaptor`で載せる必要がある。結果は`webViewModel`（`ContentView.onAppear`で
/// 設定する）へそのまま渡すだけで、判断・Web側への通知はすべて`WebViewModel`が持つ。
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var webViewModel: WebViewModel?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // アプリを閉じている間のセンサー取得（#735）。起動処理の中で登録しないと OS が起こせない
        BackgroundRefresh.register()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        webViewModel?.handleDeviceToken(token)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        webViewModel?.handleRemoteRegistrationFailure()
    }

    /// フォアグラウンドで受けた通知もバナー・音で見せる（既定は無音・非表示のため）
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// タップされたとき。フォアグラウンド・バックグラウンド・cold start（アプリが落ちていた状態からの
    /// 起動）のいずれもこのデリゲートに集約される
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let path = response.notification.request.content.userInfo["url"] as? String ?? "/"
        webViewModel?.handleNotificationTap(path: path)
    }
}
