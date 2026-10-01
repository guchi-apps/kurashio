import SwiftUI
import WidgetKit

/// 「ごみの日」専用ウィジェット（#647）。Small・Mediumで次の収集と今後の予定を出す。
/// 通信はせず、ダッシュボードが書き写した `SharedWidgetSnapshot` を読むだけ。
struct GarbageWidget: Widget {
    /// **この文字列は `WebViewModel.reloadWidgetTimelines()` が `reloadAllTimelines()` で
    /// 再描画させる対象。** kind を指定して再読み込みする形に戻すなら両方を揃えること
    let kind: String = "KurashioGarbageWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GarbageTimelineProvider()) { entry in
            GarbageWidgetView(entry: entry)
        }
        .configurationDisplayName("ごみの日")
        .description("次のごみの収集日と品目、これからの予定を表示します。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

/// 表示する1日ぶん。`daysUntil` は表示する時点（エントリの日時）で数えた値
struct GarbageDisplayDay: Hashable {
    var day: SharedWidgetSnapshot.GarbageDay
    var daysUntil: Int
}

struct GarbageEntry: TimelineEntry {
    let date: Date
    /// `nil` はダッシュボードをまだ一度も開いていない・ログアウト済み・ごみの日が未設定の古いWeb版
    let upcoming: [GarbageDisplayDay]?
}

/// 日付の計算は常に日本時間。端末のタイムゾーンで数えると、旅行中に収集日がずれて見える
enum GarbageCalendar {
    static let timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
    static let defaultCollectionTime = (hour: 8, minute: 30)

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static var dayFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    static func parse(_ text: String) -> Date? {
        dayFormatter.date(from: text)
    }

    /// "08:30" → (8, 30)。読めなければ既定（Web側が値を渡さない古い版のため）
    static func collectionTime(_ text: String?) -> (hour: Int, minute: Int) {
        let parts = text?.split(separator: ":").compactMap { Int($0) } ?? []
        guard parts.count >= 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else {
            return defaultCollectionTime
        }
        return (parts[0], parts[1])
    }

    /// `now` の時点で表示する収集日（今日の収集は、収集時刻を過ぎたら外す）。
    /// 先頭が「次の収集」。過去の日はスナップショットが古いときに紛れるので落とす
    static func upcoming(
        from days: [SharedWidgetSnapshot.GarbageDay],
        collectionTime: String?,
        at now: Date
    ) -> [GarbageDisplayDay] {
        let calendar = self.calendar
        let today = calendar.startOfDay(for: now)
        let time = self.collectionTime(collectionTime)
        let todayEnd = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: today) ?? today
        return days.compactMap { day -> GarbageDisplayDay? in
            guard !day.categories.isEmpty,
                  let date = parse(day.date),
                  let count = calendar.dateComponents([.day], from: today, to: date).day,
                  count >= 0 else { return nil }
            if count == 0 && now >= todayEnd { return nil }
            return GarbageDisplayDay(day: day, daysUntil: count)
        }
    }

    /// 表示が変わる時刻（`now` より後）。日付が変わる0時と、各収集日の収集時刻
    static func boundaries(
        from days: [SharedWidgetSnapshot.GarbageDay],
        collectionTime: String?,
        after now: Date,
        horizonDays: Int = 7
    ) -> [Date] {
        let calendar = self.calendar
        let time = self.collectionTime(collectionTime)
        let today = calendar.startOfDay(for: now)
        var result: Set<Date> = []
        for offset in 1...horizonDays {
            if let midnight = calendar.date(byAdding: .day, value: offset, to: today) { result.insert(midnight) }
        }
        for day in days {
            guard let date = parse(day.date),
                  let end = calendar.date(bySettingHour: time.hour, minute: time.minute, second: 0, of: date)
            else { continue }
            result.insert(end)
        }
        return result.filter { $0 > now }.sorted()
    }
}

struct GarbageTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> GarbageEntry {
        GarbageEntry(date: Date(), upcoming: Self.preview(now: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (GarbageEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry(now: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GarbageEntry>) -> Void) {
        let now = Date()
        guard let snapshot = SharedWidgetSnapshot.load(), let days = snapshot.garbageUpcoming else {
            completion(Timeline(entries: [GarbageEntry(date: now, upcoming: nil)], policy: .never))
            return
        }
        // 日付が変わる0時と各収集日の収集時刻にエントリを積み、ダッシュボードを開かない日も進める。
        // 最後のエントリのあとは再取得して、スナップショットが更新されていれば拾う
        let times = [now] + GarbageCalendar.boundaries(from: days, collectionTime: snapshot.garbageCollectionTime, after: now)
        let entries = times.prefix(24).map {
            GarbageEntry(date: $0, upcoming: GarbageCalendar.upcoming(from: days, collectionTime: snapshot.garbageCollectionTime, at: $0))
        }
        completion(Timeline(entries: Array(entries), policy: .atEnd))
    }

    private func entry(now: Date) -> GarbageEntry {
        guard let snapshot = SharedWidgetSnapshot.load(), let days = snapshot.garbageUpcoming else {
            return GarbageEntry(date: now, upcoming: nil)
        }
        return GarbageEntry(
            date: now,
            upcoming: GarbageCalendar.upcoming(from: days, collectionTime: snapshot.garbageCollectionTime, at: now)
        )
    }

    private static func preview(now: Date) -> [GarbageDisplayDay] {
        let calendar = GarbageCalendar.calendar
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = GarbageCalendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let weekdays = ["日", "月", "火", "水", "木", "金", "土"]
        let sample: [(Int, [(String, String)])] = [
            (1, [("燃えるごみ", "#e67e22")]),
            (3, [("不燃ごみ", "#7f8c8d")]),
            (5, [("燃えるごみ", "#e67e22")]),
            (7, [("資源", "#1abc9c")]),
        ]
        return sample.compactMap { offset, categories in
            guard let date = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now)) else { return nil }
            let weekday = weekdays[calendar.component(.weekday, from: date) - 1]
            return GarbageDisplayDay(
                day: .init(
                    date: formatter.string(from: date),
                    weekday: weekday,
                    categories: categories.map { .init(name: $0.0, color: $0.1) }
                ),
                daysUntil: offset
            )
        }
    }
}
