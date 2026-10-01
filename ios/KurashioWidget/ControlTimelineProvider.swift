import WidgetKit

/// 操作ウィジェット（電気・エアコン。#649）の表示用エントリ。設定（センサー選択）を持たない
struct ControlEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み
    let snapshot: SharedWidgetSnapshot.Snapshot?
    /// 直近の操作の結果。`WidgetPressStore.resultLifetime` を過ぎると外れる（#546）
    var pressResult: WidgetPressStore.Result?
}

/// 電気の操作・エアコンの操作の2つのウィジェットが共有するプロバイダ。
/// `KurashioTimelineProvider` と同じく、ネットワークには出ず、App Group の値を読むだけ
struct ControlTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ControlEntry {
        ControlEntry(date: Date(), snapshot: Self.previewSnapshot, pressResult: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ControlEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ControlEntry>) -> Void) {
        let current = entry()
        guard let result = current.pressResult else {
            completion(Timeline(entries: [current], policy: .never))
            return
        }
        // 結果は一定時間だけ出して消す（状態は持たない・#106）。消すエントリを先に積んでおく
        let expiry = result.at.addingTimeInterval(WidgetPressStore.resultLifetime)
        let cleared = ControlEntry(date: expiry, snapshot: current.snapshot, pressResult: nil)
        completion(Timeline(entries: [current, cleared], policy: .never))
    }

    private func entry(now: Date = Date()) -> ControlEntry {
        ControlEntry(date: now, snapshot: SharedWidgetSnapshot.load(), pressResult: WidgetPressStore.lastResult(now: now))
    }

    private static var previewSnapshot: SharedWidgetSnapshot.Snapshot {
        SharedWidgetSnapshot.Snapshot(
            roomTemperature: nil,
            roomHumidity: nil,
            defaultSensorId: nil,
            sensors: nil,
            garbageLabel: nil,
            garbageDaysUntil: nil,
            todayKwh: nil,
            todayCostYen: nil,
            remoteButtons: [
                .init(id: "a", label: "照明オン", groupName: "リビング"),
                .init(id: "b", label: "照明オフ", groupName: "リビング"),
                .init(id: "c", label: "照明オン", groupName: "寝室"),
                .init(id: "d", label: "照明オフ", groupName: "寝室"),
            ],
            aircons: [
                .init(id: 1, name: "リビング", power: "ON", mode: "COOLING", roomTemperature: 27.8, targetTemperature: 26.0),
            ]
        )
    }
}

/// 結果の印（送信・失敗・不明）。電気もエアコンも `buttonId` で照合する
enum ControlResultMark {
    static func mark(for buttonId: String, in result: WidgetPressStore.Result?) -> (text: String, isFailure: Bool, isUnknown: Bool)? {
        guard let result, result.buttonId == buttonId else { return nil }
        switch result.status {
        case .sent: return ("送信", false, false)
        case .failed: return ("失敗", true, false)
        case .unknown: return ("不明", false, true)
        }
    }
}
