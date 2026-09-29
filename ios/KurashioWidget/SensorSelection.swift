import AppIntents
import WidgetKit

/// 「ウィジェットを編集」で室温・湿度を出すセンサーを選ぶ設定（#560）。
///
/// 選択肢はネットワークから取らず、アプリが App Group へ書き写したダッシュボードの値
/// （`SharedWidgetSnapshot.Snapshot.sensors`）から作る。**ダッシュボードで表示中のセンサーだけ**が並び、
/// アプリでダッシュボードを一度も開いていなければ候補は空になる。
/// 選ばない（既定）ときは、Web側が決めたセンサー（並び順で最初の受信中のもの）を出す。
struct SelectSensorIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "表示するセンサー" }
    static var description: IntentDescription { "室温・湿度を表示するセンサーを選びます。" }

    /// nil は「自動」（ダッシュボードの並び順で最初の受信中のセンサー）
    @Parameter(title: "センサー")
    var sensor: SensorEntity?
}

struct SensorEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "センサー" }
    static var defaultQuery: SensorEntityQuery { SensorEntityQuery() }

    /// myroom の `device_id`
    let id: Int
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct SensorEntityQuery: EntityQuery {
    func entities(for identifiers: [Int]) async throws -> [SensorEntity] {
        let sensors = Self.sensors()
        return identifiers.map { id in
            // ダッシュボードで非表示にして一覧から消えても、選んだ設定は残す（表示は既定へ倒れる）
            sensors.first(where: { $0.id == id }) ?? SensorEntity(id: id, name: "デバイス \(id)")
        }
    }

    func suggestedEntities() async throws -> [SensorEntity] {
        Self.sensors()
    }

    private static func sensors() -> [SensorEntity] {
        (SharedWidgetSnapshot.load()?.sensors ?? []).map { SensorEntity(id: $0.id, name: $0.name) }
    }
}
