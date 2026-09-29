import WidgetKit

struct KurashioEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み
    let snapshot: SharedWidgetSnapshot.Snapshot?
    /// 「ウィジェットを編集」で選んだセンサーの `device_id`。nil は自動（#560）
    let sensorId: Int?
    /// Smallで並べる2つ目のセンサーの `device_id`。nil は1台表示（#569）
    let secondSensorId: Int?

    /// 室温・湿度の欄に出す値（選んだセンサー → 既定のセンサーの順に探す）
    var roomReading: SharedWidgetSnapshot.RoomReading? {
        snapshot.map { SharedWidgetSnapshot.reading(in: $0, sensorId: sensorId) }
    }

    /// 2段目に出す値。未選択・一覧から消えた・1つ目と同じセンサーのときは nil（1台表示）
    var secondReading: SharedWidgetSnapshot.RoomReading? {
        guard let snapshot, let second = SharedWidgetSnapshot.secondReading(in: snapshot, sensorId: secondSensorId) else {
            return nil
        }
        // 1つ目が「自動」でも、実際に出しているセンサーと同じなら並べない
        let firstId = sensorId.flatMap { id in snapshot.sensors?.contains(where: { $0.id == id }) == true ? id : nil }
            ?? snapshot.defaultSensorId
        return secondSensorId == firstId ? nil : second
    }
}

struct KurashioTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> KurashioEntry {
        KurashioEntry(date: Date(), snapshot: previewSnapshot, sensorId: nil, secondSensorId: nil)
    }

    func snapshot(for configuration: SelectSensorIntent, in context: Context) async -> KurashioEntry {
        if context.isPreview {
            return placeholder(in: context)
        }
        return entry(for: configuration)
    }

    func timeline(for configuration: SelectSensorIntent, in context: Context) async -> Timeline<KurashioEntry> {
        // データの更新はネットワークではなくApp Group越しの書き込みで届く。Widget自身は
        // 積極的にリロードを要求せず、`WebViewModel.reloadWidgetTimelines()` が
        // ダッシュボードの表示のたびに明示的に再評価させる
        Timeline(entries: [entry(for: configuration)], policy: .never)
    }

    private func entry(for configuration: SelectSensorIntent) -> KurashioEntry {
        KurashioEntry(
            date: Date(),
            snapshot: SharedWidgetSnapshot.load(),
            sensorId: configuration.sensor?.id,
            secondSensorId: configuration.secondSensor?.id
        )
    }

    private var previewSnapshot: SharedWidgetSnapshot.Snapshot {
        SharedWidgetSnapshot.Snapshot(
            roomTemperature: 24.6,
            roomHumidity: 58,
            defaultSensorId: nil,
            sensors: nil,
            garbageLabel: "燃えるゴミ",
            garbageDaysUntil: 1,
            todayKwh: 9.4,
            todayCostYen: 312
        )
    }
}
