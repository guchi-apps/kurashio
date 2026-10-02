import SwiftUI
import WatchKit
import WidgetKit

/// Apple Watch用のkurashio（#655）。温度・湿度・CO2濃度を見るだけのアプリ。
/// 値はiPhoneのkurashioが送ってくるほか、端末用トークン（#683）が渡されていれば、アプリを開いたとき・
/// 約15分ごとのバックグラウンド更新でWatchが自分で取りにいく（JWTは持たない）。
@main
struct KurashioWatchApp: App {
    @StateObject private var connection = WatchConnection()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connection)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await connection.refreshFromServer() }
            WatchRefresh.schedule()
        }
        // OSが起こしたときに取り直し、次の更新を予約する（実際の間隔はOS任せ。Watchの電池・予算による）
        .backgroundTask(.appRefresh(WatchRefresh.identifier)) {
            _ = await WatchSnapshot.refreshed()
            await MainActor.run {
                WidgetCenter.shared.reloadAllTimelines()
                WatchRefresh.schedule()
            }
        }
    }
}

enum WatchRefresh {
    static let identifier = "kurashio.sensors"

    /// 約15分後にバックグラウンド更新を予約する。トークンが無いときは予約しない
    static func schedule() {
        guard let date = DeviceSensors.nextRefreshDate() else { return }
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: date,
            userInfo: identifier as NSString
        ) { _ in }
    }
}
