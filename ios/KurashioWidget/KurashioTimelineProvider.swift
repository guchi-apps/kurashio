import WidgetKit

struct KurashioEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み
    let snapshot: SharedWidgetSnapshot.Snapshot?
    /// 「ウィジェットを編集」で選んだセンサーの `device_id`。nil は自動（#560）
    let sensorId: Int?
    /// Smallで並べる2つ目のセンサーの `device_id`。nil は1台表示（#569）
    let secondSensorId: Int?
    /// Mediumで並べる3つ目・4つ目のセンサーの `device_id`。nil は未選択
    var thirdSensorId: Int? = nil
    var fourthSensorId: Int? = nil
    /// 直近の電気の操作の結果。`WidgetPressStore.resultLifetime` を過ぎると外れる（#546）
    var pressResult: WidgetPressStore.Result?

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

    /// Mediumに並べる値（最大4件）。1つ目は既定へ倒れるが、2つ目以降は未選択・一覧から消えた・
    /// すでに出しているセンサーと同じものを詰めて落とす（同じ値が並ばないようにする）
    var mediumReadings: [SharedWidgetSnapshot.RoomReading] {
        guard let snapshot, let first = roomReading else { return [] }
        var shownIds: [Int] = []
        if let id = sensorId.flatMap({ id in snapshot.sensors?.contains(where: { $0.id == id }) == true ? id : nil })
            ?? snapshot.defaultSensorId {
            shownIds.append(id)
        }
        var readings = [first]
        for id in [secondSensorId, thirdSensorId, fourthSensorId] {
            guard let id, !shownIds.contains(id),
                  let reading = SharedWidgetSnapshot.secondReading(in: snapshot, sensorId: id) else { continue }
            shownIds.append(id)
            readings.append(reading)
        }
        return readings
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
        // アプリを閉じている間も、端末用トークン（#683）があれば約15分ごとにセンサーの値を取り直す。
        // 実際の実行間隔はOS任せ。トークンが無いとき（未ログイン・ログアウト後）は従来どおり自分では要求せず、
        // `WebViewModel.reloadWidgetTimelines()` がダッシュボードの表示のたびに再評価させる
        let now = Date()
        _ = await SharedWidgetSnapshot.refreshed()
        let policy: TimelineReloadPolicy = DeviceSensors.nextRefreshDate(from: now).map { .after($0) } ?? .never
        let current = entry(for: configuration, now: now)
        guard let result = current.pressResult else {
            return Timeline(entries: [current], policy: policy)
        }
        // 押した結果は一定時間だけ出して消す（状態は持たない・#106）。消すエントリを先に積んでおく
        var cleared = current
        cleared.pressResult = nil
        let expiry = result.at.addingTimeInterval(WidgetPressStore.resultLifetime)
        return Timeline(
            entries: [current, KurashioEntry(date: expiry, snapshot: cleared.snapshot, sensorId: cleared.sensorId, secondSensorId: cleared.secondSensorId, thirdSensorId: cleared.thirdSensorId, fourthSensorId: cleared.fourthSensorId)],
            policy: policy
        )
    }

    private func entry(for configuration: SelectSensorIntent, now: Date = Date()) -> KurashioEntry {
        KurashioEntry(
            date: now,
            snapshot: SharedWidgetSnapshot.load(),
            sensorId: configuration.sensor?.id,
            secondSensorId: configuration.secondSensor?.id,
            thirdSensorId: configuration.thirdSensor?.id,
            fourthSensorId: configuration.fourthSensor?.id,
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
            yesterdayKwh: 8.6,
            monthKwh: 142,
            energyDate: nil,
            remoteButtons: [
                .init(id: "a", label: "照明オン", groupName: "リビング"),
                .init(id: "b", label: "照明オフ", groupName: "リビング"),
            ]
        )
    }
}
