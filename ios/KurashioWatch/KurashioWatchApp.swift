import SwiftUI

/// Apple Watch用のkurashio（#655）。温度・湿度・CO2濃度を見るだけのアプリで、
/// 値はiPhoneのkurashioが送ってくる（Watch側は通信も認証も持たない）。
@main
struct KurashioWatchApp: App {
    @StateObject private var connection = WatchConnection()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connection)
        }
    }
}
