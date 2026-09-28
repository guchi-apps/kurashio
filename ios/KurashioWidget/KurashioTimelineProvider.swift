import WidgetKit

struct KurashioEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み
    let snapshot: SharedWidgetSnapshot.Snapshot?
}

struct KurashioTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> KurashioEntry {
        KurashioEntry(date: Date(), snapshot: previewSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (KurashioEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        completion(KurashioEntry(date: Date(), snapshot: SharedWidgetSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KurashioEntry>) -> Void) {
        let entry = KurashioEntry(date: Date(), snapshot: SharedWidgetSnapshot.load())
        // データの更新はネットワークではなくApp Group越しの書き込みで届く。Widget自身は
        // 積極的にリロードを要求せず、`WebViewModel.reloadWidgetTimelines()` が
        // ダッシュボードの表示のたびに明示的に再評価させる
        completion(Timeline(entries: [entry], policy: .never))
    }

    private var previewSnapshot: SharedWidgetSnapshot.Snapshot {
        SharedWidgetSnapshot.Snapshot(
            roomTemperature: 24.6,
            roomHumidity: 58,
            garbageLabel: "燃えるゴミ",
            garbageDaysUntil: 1,
            todayKwh: 9.4,
            todayCostYen: 312
        )
    }
}
