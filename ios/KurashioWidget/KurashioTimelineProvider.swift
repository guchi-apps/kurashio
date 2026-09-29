import WidgetKit

struct KurashioEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み
    let snapshot: SharedWidgetSnapshot.Snapshot?
    /// 「ウィジェットを編集」で選んだセンサーの `device_id`。nil は自動（#560）
    let sensorId: Int?
    /// 直近の電気の操作の結果。`WidgetPressStore.resultLifetime` を過ぎると外れる（#546）
    var pressResult: WidgetPressStore.Result?

    /// 室温・湿度の欄に出す値（選んだセンサー → 既定のセンサーの順に探す）
    var roomReading: SharedWidgetSnapshot.RoomReading? {
        snapshot.map { SharedWidgetSnapshot.reading(in: $0, sensorId: sensorId) }
    }
}

struct KurashioTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> KurashioEntry {
        KurashioEntry(date: Date(), snapshot: previewSnapshot, sensorId: nil)
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
        let now = Date()
        let current = entry(for: configuration, now: now)
        guard let result = current.pressResult else {
            return Timeline(entries: [current], policy: .never)
        }
        // 押した結果は一定時間だけ出して消す（状態は持たない・#106）。消すエントリを先に積んでおく
        var cleared = current
        cleared.pressResult = nil
        let expiry = result.at.addingTimeInterval(WidgetPressStore.resultLifetime)
        return Timeline(
            entries: [current, KurashioEntry(date: expiry, snapshot: cleared.snapshot, sensorId: cleared.sensorId)],
            policy: .never
        )
    }

    private func entry(for configuration: SelectSensorIntent, now: Date = Date()) -> KurashioEntry {
        KurashioEntry(
            date: now,
            snapshot: SharedWidgetSnapshot.load(),
            sensorId: configuration.sensor?.id,
            pressResult: WidgetPressStore.lastResult(now: now)
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
            todayCostYen: 312,
            remoteButtons: [
                .init(id: "a", label: "照明オン", groupName: "リビング"),
                .init(id: "b", label: "照明オフ", groupName: "リビング"),
            ]
        )
    }
}
