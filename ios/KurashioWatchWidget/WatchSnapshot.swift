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
    /// 端末用トークン（#683）。Watchが自分でセンサーを取りにいくために、iPhoneが一緒に送る。
    /// 無ければ（トークンを捨てた）Watch側も捨てる
    static let deviceTokenKey = "deviceToken"

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
        /// 値を測った時刻（JSTの文字列。Web側の `LatestData.datetime`）。端末の時計では解釈し直さず、
        /// 「HH:mm」は文字列から切り出す（`measuredClock`）。古いアプリから届いた値には無い
        var measuredAt: String?
    }

    struct Payload: Codable, Equatable {
        /// 選んでいないときに出すセンサー（Web側の `pickDefaultWidgetSensor()`）
        var defaultSensorId: Int?
        /// ダッシュボードの並び順
        var sensors: [Sensor]
        /// 受信停止とみなす分数（Web側が `GET /api/sensors/status` から渡す）。開いたまま古くなった値を
        /// 黄色にする基準で、**Swiftは独自のしきい値を持たない**。届いていなければ nil（`stale` だけに従う）
        var staleAfterMinutes: Int?
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
            sensors: sensors,
            staleAfterMinutes: double(raw["staleAfterMinutes"]).map { Int($0.rounded()) }
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

    // MARK: - アプリを閉じている間の更新（#683）

    /// 端末用トークンで取ったセンサーの値を、保存済みの一覧へ重ねる。**一覧にあるセンサーだけ**を更新し、
    /// 増やさない（表示するセンサーの選択・並びはWebが正）。受信停止の基準も最新のサーバーの値へ揃える
    static func merged(_ payload: Payload, with response: DeviceSensors.Response) -> Payload {
        var result = payload
        let fetched = Dictionary(response.sensors.map { ($0.deviceId, $0) }, uniquingKeysWith: { _, last in last })
        result.sensors = payload.sensors.map { sensor in
            guard let latest = fetched[sensor.id] else { return sensor }
            var updated = sensor
            updated.name = latest.name
            updated.temperature = latest.temperature
            updated.humidity = latest.humidity
            updated.co2 = latest.co2
            updated.co2Level = latest.co2Level
            updated.stale = latest.stale
            updated.measuredAt = latest.measuredAt
            return updated
        }
        if let minutes = response.staleThresholdMinutes { result.staleAfterMinutes = minutes }
        return result
    }

    /// Watchアプリのバックグラウンド更新・コンプリケーションのTimelineから呼ぶ。トークンがあり、直近に取って
    /// いなければ取り直して保存し、最新の値を返す。取れなかったとき・間隔内のときは保存済みの値をそのまま返す
    static func refreshed() async -> Payload? {
        guard let stored = load() else { return nil }
        guard let response = await DeviceSensors.fetchIfDue() else { return stored }
        let updated = merged(stored, with: response)
        save(updated)
        return updated
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
            stale: (raw["stale"] as? Bool) ?? false,
            measuredAt: raw["measuredAt"] as? String
        )
    }

    private static func double(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }
}

// MARK: - 値の時刻（#677）

extension WatchSnapshot.Sensor {
    /// 「12:34」。`measuredAt`（JSTの文字列）の時分をそのまま切り出す。端末のタイムゾーンでは解釈し直さない
    var measuredClock: String? {
        guard let text = Self.wallClock(measuredAt) else { return nil }
        return String(text.dropFirst(11).prefix(5))
    }

    /// 値を測ってからの経過分。`measuredAt` が読めないとき・未来のときは nil
    func ageMinutes(at now: Date) -> Int? {
        guard let text = Self.wallClock(measuredAt), let measured = Self.formatter.date(from: text) else { return nil }
        let seconds = now.timeIntervalSince(measured)
        return seconds < 0 ? nil : Int(seconds / 60)
    }

    /// 受信停止の印か、基準（`staleAfterMinutes`）を超えて古い。基準が届いていなければ `stale` だけに従う
    func isOld(at now: Date, staleAfterMinutes: Int?) -> Bool {
        if stale { return true }
        guard let limit = staleAfterMinutes, let age = ageMinutes(at: now) else { return false }
        return age > limit
    }

    /// "2026-10-02T12:34:56" の形（19文字）へ揃える。小数秒・オフセットは落とす（サーバーはJSTで返す）
    private static func wallClock(_ value: String?) -> String? {
        guard let value, value.count >= 19 else { return nil }
        let text = String(value.prefix(19)).replacingOccurrences(of: " ", with: "T")
        return text.dropFirst(10).first == "T" ? text : nil
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()
}
