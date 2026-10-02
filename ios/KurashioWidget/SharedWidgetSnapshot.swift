import Foundation
import os

/// メインアプリとWidget Extensionが共有する、ホーム画面ウィジェット表示用の値（#537）。
///
/// Widget（別プロセス）がバックエンドAPIを直接叩く設計だと、認証（Supabase JWT）をApp Group越しに
/// 渡す必要があり、Widget側が独自にrefresh tokenを更新するとWKWebView側のクライアントと衝突して
/// ログアウトを引き起こす（`ios/README.md`「表示用データだけをApp Group経由で共有する」節）。
/// そのため**JWTは渡さず、ダッシュボードが表示している値そのもの**をApp Group共有の
/// UserDefaultsへ書き写す。Widgetはこれを読むだけで、ネットワーク通信は一切行わない。
///
/// **このファイルはメインApp・Widget Extensionの両方のフォルダに同じ内容を置いている。**
/// Xcode16のファイルシステム同期グループ（`PBXFileSystemSynchronizedRootGroup`）は1ファイルが
/// 1つのtargetにしか属せないため、共有コードは物理的に複製している。変更するときは
/// `ios/Kurashio/SharedWidgetSnapshot.swift` と `ios/KurashioWidget/SharedWidgetSnapshot.swift` の
/// 両方を揃えること。
enum SharedWidgetSnapshot {
    private static let suiteName = "group.com.gucchii.kurashio"
    private static let key = "widgetSnapshot"

    /// 「ウィジェットを編集」で選べるセンサー1つぶんの値（#560。Web側の `WidgetSensor`）
    struct Sensor: Codable, Hashable {
        var id: Int
        var name: String
        var temperature: Double?
        var humidity: Double?
        /// CO2濃度（ppm）。測れないセンサー・#569より前のWeb版からは届かない
        var co2: Double?
        /// CO2の目安（`good` / `elevated` / `high`）。**判定はWeb側の `getCo2Level()` だけが持つ**ので、
        /// Swiftはしきい値を持たず、届いた段階に色を当てるだけにする（#569）
        var co2Level: String?
        /// 受信が止まっている（値は最後に受信した時点のもの）
        var stale: Bool
    }

    /// Largeに並べる電気の操作ボタン1つぶん（#546。Web側の `WidgetRemoteButton`）
    struct RemoteButton: Codable, Hashable {
        var id: String
        var label: String
        var groupName: String
    }

    /// 「ごみの日」ウィジェットに並べる品目1つぶん。`color` はアプリで設定した `#rrggbb`
    struct GarbageCategory: Codable, Hashable {
        var name: String
        var color: String
    }

    /// 「ごみの日」ウィジェットの収集日1日ぶん（Web側の `WidgetGarbageDay`）。
    /// **日数は持たない。** 端末の日付から数える（ダッシュボードを開かない日にも正しく進むように）
    struct GarbageDay: Codable, Hashable {
        /// "2026-08-26"
        var date: String
        var weekday: String
        var categories: [GarbageCategory]
    }

    /// エアコンの操作ウィジェットに並べる1台ぶん（Web側の `WidgetAircon`）。
    /// 状態はダッシュボードが持っている台（表示中の1台）だけ入り、他の台は nil。操作は状態に頼らず、
    /// 押した時点でWeb側が現在値を読み直して送る
    struct Aircon: Codable, Hashable {
        var id: Int
        var name: String
        var power: String?
        var mode: String?
        var roomTemperature: Double?
        var targetTemperature: Double?
    }

    struct Snapshot: Codable {
        /// センサーを選んでいないときに出す室温・湿度（Web側の `pickDefaultWidgetSensor()`）
        var roomTemperature: Double?
        var roomHumidity: Double?
        /// 上の値を取ったセンサーのID
        var defaultSensorId: Int?
        /// 選べるセンサーの一覧（ダッシュボードの並び順）。#560 より前のWeb版からは届かない
        var sensors: [Sensor]?
        /// 次に収集される品目名（複数なら「・」区切り）。予定が無ければ nil
        var garbageLabel: String?
        /// 上記の収集日までの日数（0=今日、1=明日）
        var garbageDaysUntil: Int?
        /// 「ごみの日」ウィジェット用の、今日以降の収集日（日付順・最大5件）。古いWeb版からは届かない
        var garbageUpcoming: [GarbageDay]?
        /// 今日の収集が終わる時刻（"08:30"）。これを過ぎたら今日の収集は済みとみなす
        var garbageCollectionTime: String?
        var todayKwh: Double?
        var todayCostYen: Int?
        /// 昨日の使用量（KEPCO差分の「その他」を除く）。記録が無い・#648より前のWeb版からは届かない
        var yesterdayKwh: Double?
        /// 今月の累計使用量（#648）
        var monthKwh: Double?
        /// 電気の値の基準日（JST・`2026-10-01`）。0時を過ぎて古い値のまま出さないために使う（#648）
        var energyDate: String?
        /// 電気の操作ボタン（ダッシュボードで非表示にしたものを除く）。#546 より前のWeb版からは届かない
        var remoteButtons: [RemoteButton]?
        /// エアコンの操作対象（操作できない構成・非表示のときは空）。#649 より前のWeb版からは届かない
        var aircons: [Aircon]?
    }

    /// ウィジェットに出す室温・湿度。`name` は選んだ（または既定の）センサーの名前で、
    /// `sensors` を持たない古いスナップショットでは nil
    struct RoomReading {
        var name: String?
        var temperature: Double?
        var humidity: Double?
        var co2: Double?
        var co2Level: String?
        var stale: Bool
    }

    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "WidgetSnapshot")

    /// 選んだセンサー（`sensorId`）の値。選んでいない・一覧から消えた（ダッシュボードで非表示にした）
    /// ときは、Web側が決めた既定のセンサーへ倒す
    static func reading(in snapshot: Snapshot, sensorId: Int?) -> RoomReading {
        let sensors = snapshot.sensors ?? []
        if let sensor = sensors.first(where: { $0.id == sensorId })
            ?? sensors.first(where: { $0.id == snapshot.defaultSensorId }) {
            return RoomReading(
                name: sensor.name,
                temperature: sensor.temperature,
                humidity: sensor.humidity,
                co2: sensor.co2,
                co2Level: sensor.co2Level,
                stale: sensor.stale
            )
        }
        return RoomReading(
            name: nil,
            temperature: snapshot.roomTemperature,
            humidity: snapshot.roomHumidity,
            co2: nil,
            co2Level: nil,
            stale: false
        )
    }

    /// 「2つ目のセンサー」の値（#569）。**`reading()` と違い、既定のセンサーへ倒さない。**
    /// 一覧から消えた（ダッシュボードで非表示にした）センサーで既定へ倒すと、1つ目と同じ値が
    /// 2段並ぶため、見つからなければ nil を返して呼ぶ側に2段目を出させない
    static func secondReading(in snapshot: Snapshot, sensorId: Int?) -> RoomReading? {
        guard let sensorId,
              let sensor = snapshot.sensors?.first(where: { $0.id == sensorId }) else { return nil }
        return RoomReading(
            name: sensor.name,
            temperature: sensor.temperature,
            humidity: sensor.humidity,
            co2: sensor.co2,
            co2Level: sensor.co2Level,
            stale: sensor.stale
        )
    }

    /// App Group が entitlements で有効になっていないと、`UserDefaults(suiteName:)` は nil を返さず
    /// **そのプロセス専用の保存先**を黙って返す（アプリが書いた値をWidgetが読めない）。
    /// 共有コンテナのURLが取れるかで、App Group が本当に効いているかを見分ける（#560）
    private static var defaults: UserDefaults? {
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) == nil {
            logger.error("App Group \(suiteName, privacy: .public) のコンテナが取れない。entitlements・Developer Portal の登録を確認すること")
            return nil
        }
        return UserDefaults(suiteName: suiteName)
    }

    /// Web側（`frontend/lib/native-app.ts` の `syncWidgetSnapshot()`）から届いた辞書を保存する。
    ///
    /// **届いた辞書をそのままJSONにして、読む側で `JSONDecoder` に通す形にしないこと**（#560）。
    /// WKWebView から届く数値は `NSNumber`（JSの `null` は `NSNull`）で、整数の項目
    /// （`todayCostYen` など）が `312.0` のように小数で書き出されると `Int` へ読めず、
    /// **1項目の食い違いでスナップショット全体が nil になり**、Widgetは「ダッシュボードを開いて
    /// ください」のままになる。ここで項目ごとに型を整えてから `Snapshot` として保存する
    static func save(_ raw: [String: Any]) {
        let snapshot = Snapshot(
            roomTemperature: double(raw["roomTemperature"]),
            roomHumidity: double(raw["roomHumidity"]),
            defaultSensorId: double(raw["defaultSensorId"]).map { Int($0.rounded()) },
            sensors: (raw["sensors"] as? [[String: Any]])?.compactMap(sensor),
            garbageLabel: raw["garbageLabel"] as? String,
            garbageDaysUntil: double(raw["garbageDaysUntil"]).map { Int($0.rounded()) },
            garbageUpcoming: (raw["garbageUpcoming"] as? [[String: Any]])?.compactMap(garbageDay),
            garbageCollectionTime: raw["garbageCollectionTime"] as? String,
            todayKwh: double(raw["todayKwh"]),
            todayCostYen: double(raw["todayCostYen"]).map { Int($0.rounded()) },
            yesterdayKwh: double(raw["yesterdayKwh"]),
            monthKwh: double(raw["monthKwh"]),
            energyDate: raw["energyDate"] as? String,
            remoteButtons: (raw["remoteButtons"] as? [[String: Any]])?.compactMap(remoteButton),
            aircons: (raw["aircons"] as? [[String: Any]])?.compactMap(aircon)
        )
        guard let defaults else { return }
        do {
            defaults.set(try JSONEncoder().encode(snapshot), forKey: key)
        } catch {
            logger.error("スナップショットを保存できない: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func load() -> Snapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        do {
            return try JSONDecoder().decode(Snapshot.self, from: data)
        } catch {
            logger.error("スナップショットを読めない: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func clear() {
        defaults?.removeObject(forKey: key)
    }

    // MARK: - アプリを閉じている間の更新（#683）

    /// 端末用トークンで取ったセンサーの値を、保存済みの一覧へ重ねる。**一覧にあるセンサーだけ**を更新し、
    /// 増やさない（表示するセンサーの選択・並びはWebが正）。取れなかったセンサーは前の値のまま
    static func merged(_ snapshot: Snapshot, with response: DeviceSensors.Response) -> Snapshot {
        var result = snapshot
        let fetched = Dictionary(response.sensors.map { ($0.deviceId, $0) }, uniquingKeysWith: { _, last in last })
        result.sensors = snapshot.sensors?.map { sensor in
            guard let latest = fetched[sensor.id] else { return sensor }
            var updated = sensor
            updated.name = latest.name
            updated.temperature = latest.temperature
            updated.humidity = latest.humidity
            updated.co2 = latest.co2
            updated.co2Level = latest.co2Level
            updated.stale = latest.stale
            return updated
        }
        // `sensors` を持たない古いスナップショットのための室温・湿度も、既定のセンサーに合わせる
        if let id = snapshot.defaultSensorId, let latest = fetched[id] {
            result.roomTemperature = latest.temperature
            result.roomHumidity = latest.humidity
        }
        return result
    }

    /// ウィジェットのTimelineから呼ぶ。トークンがあり、直近に取っていなければ取り直して保存し、
    /// 最新のスナップショットを返す。取れなかったとき・間隔内のときは保存済みの値をそのまま返す
    static func refreshed() async -> Snapshot? {
        guard let stored = load() else { return nil }
        guard let response = await DeviceSensors.fetchIfDue() else { return stored }
        let updated = merged(stored, with: response)
        if let defaults, let data = try? JSONEncoder().encode(updated) {
            defaults.set(data, forKey: key)
        }
        return updated
    }

    private static func remoteButton(_ raw: [String: Any]) -> RemoteButton? {
        guard let id = raw["id"] as? String, !id.isEmpty else { return nil }
        return RemoteButton(
            id: id,
            label: (raw["label"] as? String) ?? id,
            groupName: (raw["groupName"] as? String) ?? ""
        )
    }

    private static func garbageDay(_ raw: [String: Any]) -> GarbageDay? {
        guard let date = raw["date"] as? String, !date.isEmpty else { return nil }
        let categories = (raw["categories"] as? [[String: Any]] ?? []).compactMap { item -> GarbageCategory? in
            guard let name = item["name"] as? String, !name.isEmpty else { return nil }
            return GarbageCategory(name: name, color: (item["color"] as? String) ?? "")
        }
        return GarbageDay(date: date, weekday: (raw["weekday"] as? String) ?? "", categories: categories)
    }

    private static func aircon(_ raw: [String: Any]) -> Aircon? {
        guard let id = double(raw["id"]).map({ Int($0.rounded()) }) else { return nil }
        return Aircon(
            id: id,
            name: (raw["name"] as? String) ?? "エアコン \(id)",
            power: raw["power"] as? String,
            mode: raw["mode"] as? String,
            roomTemperature: double(raw["roomTemperature"]),
            targetTemperature: double(raw["targetTemperature"])
        )
    }

    private static func sensor(_ raw: [String: Any]) -> Sensor? {
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

// MARK: - ウィジェットのボタン押下（#546）

/// ウィジェットのボタン押下を、アプリ（WKWebViewのログイン済みセッション）へ受け渡す保存領域。
///
/// **`Snapshot` とは別のキーに置く。** `SharedWidgetSnapshot.save()` はダッシュボードの同期のたびに
/// `Snapshot` を丸ごと作り直して書くため、同居させると押下の結果や保留が次の同期で消える。
/// ウィジェットは認証を持たない（JWTを渡すとrefresh tokenの奪い合いでログアウトする・#537）。
/// 押されたら `pending` を書いてアプリを前面に出し、Webが送って結果（`last`）を書き戻す。
enum WidgetPressStore {
    private static let pendingKey = "widgetPendingPress"
    private static let lastKey = "widgetLastPress"
    /// これを過ぎた保留は捨てる。あとから古い操作が突然実行されるのを防ぐ
    static let pendingLifetime: TimeInterval = 60
    /// ウィジェットに結果を出しておく時間
    static let resultLifetime: TimeInterval = 30

    /// `key` は押下ごとに変わる（Webが二重送信を避けるのに使う）
    ///
    /// エアコンの操作（#649）のときは `acId` と `action`（`power_on` / `power_off` / `temp_up` / `temp_down`）が入り、
    /// `buttonId` は結果の照合用に `aircon:<acId>:<action>` とする。電気の操作では2つとも nil
    struct Pending: Codable {
        var key: String
        var buttonId: String
        var pressedAt: Date
        var acId: Int? = nil
        var action: String? = nil
    }

    enum Status: String, Codable {
        case sent, failed, unknown
    }

    struct Result: Codable {
        var buttonId: String
        var status: Status
        var at: Date
    }

    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "WidgetPress")

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: "group.com.gucchii.kurashio")
    }

    static func setPending(buttonId: String, acId: Int? = nil, action: String? = nil, now: Date = Date()) {
        let pending = Pending(key: UUID().uuidString, buttonId: buttonId, pressedAt: now, acId: acId, action: action)
        guard let data = try? JSONEncoder().encode(pending) else { return }
        defaults?.set(data, forKey: pendingKey)
    }

    /// 保留中の押下。期限切れは消して nil を返す
    static func pending(now: Date = Date()) -> Pending? {
        guard
            let data = defaults?.data(forKey: pendingKey),
            let pending = try? JSONDecoder().decode(Pending.self, from: data)
        else { return nil }
        if now.timeIntervalSince(pending.pressedAt) > pendingLifetime {
            defaults?.removeObject(forKey: pendingKey)
            return nil
        }
        return pending
    }

    /// Webから結果（ack）が届いたときだけ消す。届く前に消すと、リロードで途切れた押下を取りこぼす
    static func acknowledge(key: String, status: Status, now: Date = Date()) {
        guard let pending = pending(now: now), pending.key == key else { return }
        defaults?.removeObject(forKey: pendingKey)
        let result = Result(buttonId: pending.buttonId, status: status, at: now)
        if let data = try? JSONEncoder().encode(result) {
            defaults?.set(data, forKey: lastKey)
        } else {
            logger.error("押下の結果を保存できない")
        }
    }

    /// ウィジェットに出す直近の結果。`resultLifetime` を過ぎたら nil
    static func lastResult(now: Date = Date()) -> Result? {
        guard
            let data = defaults?.data(forKey: lastKey),
            let result = try? JSONDecoder().decode(Result.self, from: data),
            now.timeIntervalSince(result.at) < resultLifetime
        else { return nil }
        return result
    }

    static func clear() {
        defaults?.removeObject(forKey: pendingKey)
        defaults?.removeObject(forKey: lastKey)
    }
}
