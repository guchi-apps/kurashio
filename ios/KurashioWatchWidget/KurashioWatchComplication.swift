import SwiftUI
import WidgetKit

/// 文字盤のコンプリケーション（#655）。円形は温度・湿度・CO2のどれか1つ、長方形・1行は3つ。
/// 値はWatchアプリがiPhoneから受け取って App Group へ書いたもので、ここでは通信しない。
struct KurashioWatchComplication: Widget {
    let kind: String = "KurashioWatchComplication"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectWatchSensorIntent.self, provider: WatchTimelineProvider()) { entry in
            WatchComplicationView(entry: entry)
        }
        .configurationDisplayName("kurashio")
        .description("温度・湿度・CO2濃度を表示します。")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct WatchEntry: TimelineEntry {
    let date: Date
    /// `nil` は値がまだ届いていない・ログアウト済み
    let sensor: WatchSnapshot.Sensor?
    let metric: WatchMetric
}

struct WatchTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WatchEntry {
        WatchEntry(
            date: Date(),
            sensor: WatchSnapshot.Sensor(
                id: 0, name: "リビング", temperature: 24.6, humidity: 52, co2: 720, co2Level: "good", stale: false, measuredAt: "2026-10-02T12:34:00"
            ),
            metric: .temperature
        )
    }

    func snapshot(for configuration: SelectWatchSensorIntent, in context: Context) async -> WatchEntry {
        context.isPreview ? placeholder(in: context) : entry(for: configuration)
    }

    func timeline(for configuration: SelectWatchSensorIntent, in context: Context) async -> Timeline<WatchEntry> {
        // 更新はiPhoneからの受信（Watchアプリが `reloadAllTimelines()` を呼ぶ）に加え、端末用トークン（#683）が
        // あれば約15分ごとに自分で取り直す（実際の実行間隔はOS任せ）。トークンが無いときは自分では要求しない
        let now = Date()
        _ = await WatchSnapshot.refreshed()
        let policy: TimelineReloadPolicy = DeviceSensors.nextRefreshDate(from: now).map { .after($0) } ?? .never
        return Timeline(entries: [entry(for: configuration)], policy: policy)
    }

    /// 文字盤の編集で最初に並ぶ候補。watchOS の `AppIntentTimelineProvider` は既定の実装が無く必須。
    /// センサーは選ばず（自動）、円形に出す値だけを変えた3つを返す
    func recommendations() -> [AppIntentRecommendation<SelectWatchSensorIntent>] {
        [
            (WatchMetric.temperature, "温度"),
            (WatchMetric.humidity, "湿度"),
            (WatchMetric.co2, "CO2濃度"),
        ].map { metric, title in
            let intent = SelectWatchSensorIntent()
            intent.circularMetric = metric
            return AppIntentRecommendation(intent: intent, description: LocalizedStringResource(stringLiteral: title))
        }
    }

    private func entry(for configuration: SelectWatchSensorIntent) -> WatchEntry {
        let sensor = WatchSnapshot.load().flatMap { WatchSnapshot.sensor(in: $0, id: configuration.sensor?.id) }
        return WatchEntry(date: Date(), sensor: sensor, metric: configuration.circularMetric)
    }
}

struct WatchComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            default: inline
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let sensor = entry.sensor {
                VStack(spacing: 0) {
                    Text(circularValue(sensor))
                        .font(.system(.body, design: .rounded, weight: .semibold))
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                        .foregroundStyle(entry.metric == .co2 ? Co2Color.color(sensor.co2Level) : .primary)
                    Text(circularCaption)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            } else {
                Image(systemName: "iphone.and.arrow.forward")
            }
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let sensor = entry.sensor {
                Text(rectangularTitle(sensor))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(format(temperature: sensor.temperature))  \(format(humidity: sensor.humidity))")
                    .font(.system(.headline, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 4) {
                    Circle().fill(Co2Color.color(sensor.co2Level)).frame(width: 7, height: 7)
                    Text("CO2 \(format(co2: sensor.co2))")
                        .font(.caption)
                        .lineLimit(1)
                }
            } else {
                Text("iPhoneのkurashioを開くと値が届きます")
                    .font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 1行目。名前に値の時刻を同居させて、行数は増やさない（#677）。受信停止のときは受信停止を優先する
    private func rectangularTitle(_ sensor: WatchSnapshot.Sensor) -> String {
        if sensor.stale { return "\(sensor.name)・受信停止" }
        if let clock = sensor.measuredClock { return "\(sensor.name) \(clock)" }
        return sensor.name
    }

    private var inline: some View {
        if let sensor = entry.sensor {
            return Text("\(format(temperature: sensor.temperature)) \(format(humidity: sensor.humidity)) CO2 \(format(co2: sensor.co2))")
        }
        return Text("kurashio")
    }

    private func circularValue(_ sensor: WatchSnapshot.Sensor) -> String {
        switch entry.metric {
        case .temperature: return format(temperature: sensor.temperature)
        case .humidity: return format(humidity: sensor.humidity)
        case .co2: return sensor.co2.map { "\(Int($0.rounded()))" } ?? "—"
        }
    }

    private var circularCaption: String {
        switch entry.metric {
        case .temperature: return "温度"
        case .humidity: return "湿度"
        case .co2: return "CO2"
        }
    }

    private func format(temperature value: Double?) -> String { value.map { String(format: "%.1f℃", $0) } ?? "—" }
    private func format(humidity value: Double?) -> String { value.map { "\(Int($0.rounded()))%" } ?? "—" }
    private func format(co2 value: Double?) -> String { value.map { "\(Int($0.rounded()))ppm" } ?? "—" }
}

/// CO2の目安の色。判定はWeb側（`getCo2Level()`）で、届いた段階に色を当てるだけ
enum Co2Color {
    static func color(_ level: String?) -> Color {
        switch level {
        case "high": return .red
        case "elevated": return .yellow
        case "good": return .green
        default: return .gray
        }
    }
}
