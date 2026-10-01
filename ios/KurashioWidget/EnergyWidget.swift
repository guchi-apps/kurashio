import SwiftUI
import WidgetKit

/// 今日の消費電力だけを出すSmallウィジェット（#648）。室温の「KurashioWidget」とは別のkindで、
/// 設定は持たない。値はダッシュボードが書き写したスナップショットを読むだけで、通信はしない。
/// kind は `WebViewModel.reloadWidgetTimelines()` の `reloadAllTimelines()` で再評価される。
struct KurashioEnergyWidget: Widget {
    let kind: String = "KurashioEnergyWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: EnergyTimelineProvider()) { entry in
            EnergyWidgetView(entry: entry)
        }
        .configurationDisplayName("今日の電気")
        .description("今日の消費電力と電気代、昨日との比較、今月の累計を表示します。")
        .supportedFamilies([.systemSmall])
    }
}

struct EnergyEntry: TimelineEntry {
    let date: Date
    let snapshot: SharedWidgetSnapshot.Snapshot?
}

struct EnergyTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> EnergyEntry {
        EnergyEntry(date: Date(), snapshot: preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (EnergyEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : EnergyEntry(date: Date(), snapshot: SharedWidgetSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<EnergyEntry>) -> Void) {
        // 更新はアプリ側の `reloadAllTimelines()` で届く。0時を過ぎても前日の値を「今日」と
        // 出し続けないよう、翌日0時（JST）のエントリを積んでおく（表示側が日付の食い違いを見て切り替える）
        let now = Date()
        let snapshot = SharedWidgetSnapshot.load()
        var entries = [EnergyEntry(date: now, snapshot: snapshot)]
        if let midnight = EnergyDay.nextMidnight(after: now) {
            entries.append(EnergyEntry(date: midnight, snapshot: snapshot))
        }
        completion(Timeline(entries: entries, policy: .never))
    }

    private var preview: SharedWidgetSnapshot.Snapshot {
        SharedWidgetSnapshot.Snapshot(
            roomTemperature: nil, roomHumidity: nil, defaultSensorId: nil, sensors: nil,
            garbageLabel: nil, garbageDaysUntil: nil,
            todayKwh: 9.4, todayCostYen: 312, yesterdayKwh: 8.6, monthKwh: 142, energyDate: nil,
            remoteButtons: nil
        )
    }
}

/// 日付は端末のタイムゾーンではなくJSTで数える（Web側の `breakdown.today.date` がJSTのため）
enum EnergyDay {
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        return calendar
    }

    static func string(for date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func nextMidnight(after date: Date) -> Date? {
        calendar.nextDate(after: date, matching: DateComponents(hour: 0, minute: 0, second: 0), matchingPolicy: .nextTime)
    }
}

struct EnergyWidgetView: View {
    let entry: EnergyEntry

    var body: some View {
        if let snapshot = entry.snapshot {
            content(snapshot)
        } else {
            message("アプリでダッシュボードを開いてください")
        }
    }

    @ViewBuilder
    private func content(_ snapshot: SharedWidgetSnapshot.Snapshot) -> some View {
        if let kwh = snapshot.todayKwh {
            // `energyDate` が今日と違う＝0時を過ぎて、まだダッシュボードを開いていない。
            // 前日の値を「今日」と出さない（届かない古いWeb版は日付が無いのでそのまま出す）
            if let day = snapshot.energyDate, day != EnergyDay.string(for: entry.date) {
                message("ダッシュボードを開いて更新してください")
            } else {
                EnergyContent(kwh: kwh, snapshot: snapshot)
            }
        } else {
            message("今日の使用量はまだ届いていません")
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}

private struct EnergyContent: View {
    let kwh: Double
    let snapshot: SharedWidgetSnapshot.Snapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Circle().fill(Color.orange).frame(width: 7, height: 7)
                Text("今日の電気")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(String(format: "%.1f", kwh))
                    .font(.system(size: 34, weight: .bold))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text("kWh")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 4)

            HStack(spacing: 4) {
                if let cost = snapshot.todayCostYen {
                    Text("\(cost)円")
                        .font(.caption.bold())
                }
                Spacer(minLength: 0)
                if let month = snapshot.monthKwh {
                    Text("今月 \(Int(month.rounded())) kWh")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }

            Spacer(minLength: 4)

            if let yesterday = snapshot.yesterdayKwh {
                CompareBar(today: kwh, yesterday: yesterday)
                HStack {
                    Text("昨日 \(String(format: "%.1f", yesterday))")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text(diffText(kwh - yesterday))
                        .bold()
                        .foregroundStyle(kwh > yesterday ? Color.orange : Color.green)
                }
                .font(.caption2)
                .lineLimit(1)
                .padding(.top, 4)
            } else {
                Text("昨日の記録なし")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private func diffText(_ diff: Double) -> String {
        // 表示の丸め（小数1桁）で0になるものは符号を付けない
        let rounded = (diff * 10).rounded() / 10
        if rounded == 0 { return "±0.0" }
        return String(format: rounded > 0 ? "+%.1f" : "−%.1f", abs(rounded))
    }
}

/// 今日（色つき）と昨日の合計（目盛り）の比較。目盛りを越えたら昨日より多い。
/// 幅は大きい方に少し余白を足した値を100%とする
private struct CompareBar: View {
    let today: Double
    let yesterday: Double

    var body: some View {
        GeometryReader { geo in
            let scale = max(max(today, yesterday) * 1.1, 0.1)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.25))
                Capsule()
                    .fill(Color.orange)
                    .frame(width: geo.size.width * min(today / scale, 1))
                Rectangle()
                    .fill(Color.primary.opacity(0.55))
                    .frame(width: 2)
                    .offset(x: geo.size.width * min(yesterday / scale, 1) - 1)
            }
        }
        .frame(height: 6)
    }
}
