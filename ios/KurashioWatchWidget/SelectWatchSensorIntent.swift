import AppIntents
import WidgetKit

/// 文字盤の編集でセンサーと、円形に出す値を選ぶ設定（#655）。
/// 選択肢はネットワークから取らず、Watchアプリが App Group へ書いた値から作る。
struct SelectWatchSensorIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "表示するセンサー" }
    static var description: IntentDescription { "温度・湿度・CO2濃度を表示するセンサーと、円形に出す値を選びます。" }

    /// nil は「自動」（ダッシュボードで最初に受信中のセンサー）
    @Parameter(title: "センサー")
    var sensor: WatchSensorEntity?

    @Parameter(title: "円形に出す値", default: .temperature)
    var circularMetric: WatchMetric
}

enum WatchMetric: String, AppEnum {
    case temperature
    case humidity
    case co2

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "値" }
    static var caseDisplayRepresentations: [WatchMetric: DisplayRepresentation] {
        [
            .temperature: "温度",
            .humidity: "湿度",
            .co2: "CO2濃度",
        ]
    }
}

struct WatchSensorEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "センサー" }
    static var defaultQuery: WatchSensorEntityQuery { WatchSensorEntityQuery() }

    /// myroom の `device_id`
    let id: Int
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct WatchSensorEntityQuery: EntityQuery {
    func entities(for identifiers: [Int]) async throws -> [WatchSensorEntity] {
        let sensors = Self.sensors()
        return identifiers.map { id in
            // ダッシュボードで非表示にして一覧から消えても、選んだ設定は残す（表示は既定へ倒れる）
            sensors.first(where: { $0.id == id }) ?? WatchSensorEntity(id: id, name: "デバイス \(id)")
        }
    }

    func suggestedEntities() async throws -> [WatchSensorEntity] {
        Self.sensors()
    }

    private static func sensors() -> [WatchSensorEntity] {
        (WatchSnapshot.load()?.sensors ?? []).map { WatchSensorEntity(id: $0.id, name: $0.name) }
    }
}
