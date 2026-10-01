import Foundation
import os

/// iPhoneアプリ・Apple Watchアプリ・Watchのコンプリケーションが共有する、Watchに出す値（#655）。
///
/// iPhoneのホーム画面ウィジェット（`SharedWidgetSnapshot`）と同じ設計で、**ダッシュボードが表示している
/// センサーの値そのもの**だけを渡す。Watchは通信も認証も持たず、JWTも渡さない。iPhoneアプリが
/// `SharedWidgetSnapshot` を保存したタイミングで、センサーの部分だけを WatchConnectivity
/// （`updateApplicationContext`）で送り、Watchアプリが受け取ってApp Groupへ書き、コンプリケーションが読む。
///
/// **このファイルは `ios/Kurashio/`・`ios/KurashioWatch/`・`ios/KurashioWatchWidget/` の3か所に同じ内容を置いている。**
/// ファイルシステム同期グループは1ファイルが1つのtargetにしか属せないため、物理的に複製している。
/// 変更するときは3つとも揃えること（`ios/scripts/check-consistency.mjs` が照合する）。
enum WatchSnapshot {
    /// WatchConnectivity の context のキー（値は `Payload` をJSONにした `Data`）
    static let contextKey = "watchSnapshot"
    /// ログアウト時にiPhoneが送る印。Watch側は保存した値を捨てる
    static let clearedKey = "watchSnapshotCleared"

    private static let suiteName = "group.com.gucchii.kurashio"
    private static let storeKey = "watchSnapshot"
    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "WatchSnapshot")

    /// 1センサーぶんの値（Web側の `WidgetSensor` と同じ形）
    struct Sensor: Codable, Hashable, Identifiable {
        var id: Int
        var name: String
        var temperature: Double?
        var humidity: Double?
        var co2: Double?
        /// CO2の目安（`good` / `elevated` / `high`）。**判定はWeb側の `getCo2Level()` だけが持つ**ので、
        /// Swiftはしきい値を持たず、届いた段階に色を当てるだけにする
        var co2Level: String?
        /// 受信が止まっている（値は最後に受信した時点のもの）
        var stale: Bool
    }

    struct Payload: Codable, Equatable {
        /// 選んでいないときに出すセンサー（Web側の `pickDefaultWidgetSensor()`）
        var defaultSensorId: Int?
        /// ダッシュボードの並び順
        var sensors: [Sensor]
    }

    /// 選んだセンサー。選んでいない・一覧から消えたときは既定のセンサー、それも無ければ先頭へ倒す
    static func sensor(in payload: Payload, id: Int?) -> Sensor? {
        payload.sensors.first(where: { $0.id == id })
            ?? payload.sensors.first(where: { $0.id == payload.defaultSensorId })
            ?? payload.sensors.first
    }

    /// iPhone側。`SharedWidgetSnapshot` が保存した辞書の `sensors`・`defaultSensorId` から、
    /// 送る中身を作る。センサーが1台も無いときは nil（送らない）
    static func payload(from raw: [String: Any]) -> Payload? {
        let sensors = (raw["sensors"] as? [[String: Any]] ?? []).compactMap(sensor(from:))
        guard !sensors.isEmpty else { return nil }
        return Payload(
            defaultSensorId: double(raw["defaultSensorId"]).map { Int($0.rounded()) },
            sensors: sensors
        )
    }

    // MARK: - Watch側のApp Group保存

    private static var defaults: UserDefaults? {
        // App Group が効いていないと `UserDefaults(suiteName:)` は共有できない保存先を黙って返す。
        // コンテナが取れるかで本当に効いているかを見分ける（`SharedWidgetSnapshot` と同じ）
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) == nil {
            logger.error("App Group \(suiteName, privacy: .public) のコンテナが取れない。entitlements・Developer Portal の登録を確認すること")
            return nil
        }
        return UserDefaults(suiteName: suiteName)
    }

    static func save(_ payload: Payload) {
        guard let defaults else { return }
        do {
            defaults.set(try JSONEncoder().encode(payload), forKey: storeKey)
        } catch {
            logger.error("保存できない: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func load() -> Payload? {
        guard let data = defaults?.data(forKey: storeKey) else { return nil }
        return decode(data)
    }

    static func clear() {
        defaults?.removeObject(forKey: storeKey)
    }

    static func encode(_ payload: Payload) -> Data? {
        try? JSONEncoder().encode(payload)
    }

    static func decode(_ data: Data) -> Payload? {
        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            logger.error("読めない: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: - 型の整え（WKWebViewから届く数値は NSNumber・null は NSNull。`SharedWidgetSnapshot.sensor` と同じ）

    private static func sensor(from raw: [String: Any]) -> Sensor? {
        guard let id = double(raw["id"]).map({ Int($0.rounded()) }) else { return nil }
        return Sensor(
            id: id,
            name: (raw["name"] as? String) ?? "デバイス \(id)",
            temperature: double(raw["temperature"]),
            humidity: double(raw["humidity"]),
            co2: double(raw["co2"]),
            co2Level: raw["co2Level"] as? String,
            stale: (raw["stale"] as? Bool) ?? false
        )
    }

    private static func double(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }
}
