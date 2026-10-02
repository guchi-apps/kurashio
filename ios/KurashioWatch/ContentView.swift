import SwiftUI

/// 1台ずつの画面をデジタルクラウンで切り替える。右上のボタンから一覧を開ける。
struct ContentView: View {
    @EnvironmentObject private var connection: WatchConnection
    @State private var selection: Int?
    @State private var showsList = false

    var body: some View {
        NavigationStack {
            if let payload = connection.payload, !payload.sensors.isEmpty {
                TabView(selection: $selection) {
                    ForEach(payload.sensors) { sensor in
                        SensorPage(sensor: sensor, staleAfterMinutes: payload.staleAfterMinutes)
                            .tag(Optional(sensor.id))
                    }
                }
                .tabViewStyle(.verticalPage)
                .onAppear {
                    if selection == nil { selection = WatchSnapshot.sensor(in: payload, id: nil)?.id }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showsList = true
                        } label: {
                            Image(systemName: "list.bullet")
                        }
                        .accessibilityLabel("センサー一覧")
                    }
                }
                .navigationDestination(isPresented: $showsList) {
                    SensorListView(payload: payload) { id in
                        selection = id
                        showsList = false
                    }
                }
            } else {
                EmptyStateView()
            }
        }
    }
}

/// センサー1台の画面。温度を最も大きく、湿度とCO2を下に出す
struct SensorPage: View {
    let sensor: WatchSnapshot.Sensor
    let staleAfterMinutes: Int?

    var body: some View {
        // 開いたままでも「n分前」が進み、基準を超えたら古い値の見た目へ切り替わる（#677）
        TimelineView(.everyMinute) { context in
            page(isOld: sensor.isOld(at: context.date, staleAfterMinutes: staleAfterMinutes), now: context.date)
        }
    }

    private func page(isOld: Bool, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(sensor.name)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if isOld {
                    Text("受信停止")
                        .font(.caption2)
                        .foregroundStyle(.yellow)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            Text(WatchFormat.temperature(sensor.temperature))
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(.orange)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 8) {
                MetricTile(label: "湿度", value: WatchFormat.humidity(sensor.humidity), tint: .cyan)
                MetricTile(label: "CO2", value: WatchFormat.co2(sensor.co2), tint: Co2Style.color(sensor.co2Level))
            }
            if sensor.co2 != nil {
                HStack(spacing: 6) {
                    Circle().fill(Co2Style.color(sensor.co2Level)).frame(width: 10, height: 10)
                    Text(Co2Style.label(sensor.co2Level))
                        .font(.footnote)
                    Spacer(minLength: 0)
                    Text("ppm").font(.caption2).foregroundStyle(.secondary)
                }
            }
            timestamp(isOld: isOld, now: now)
        }
        .opacity(isOld ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    /// 画面の下端。「12:34 時点」と「2分前」。時刻が届いていない（古いアプリから）ときは何も出さない
    @ViewBuilder
    private func timestamp(isOld: Bool, now: Date) -> some View {
        if let clock = sensor.measuredClock {
            HStack {
                Text("\(clock) 時点")
                Spacer(minLength: 0)
                if let age = sensor.ageMinutes(at: now) {
                    Text(WatchFormat.age(minutes: age))
                }
            }
            .font(.caption2)
            .foregroundStyle(isOld ? Color.yellow : Color.secondary)
            .lineLimit(1)
            .monospacedDigit()
        }
    }
}

private struct MetricTile: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.system(.title3, design: .monospaced, weight: .medium))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// すべてのセンサーを1行ずつ並べた一覧。タップでそのセンサーの画面へ
struct SensorListView: View {
    let payload: WatchSnapshot.Payload
    let onSelect: (Int) -> Void

    var body: some View {
        List(payload.sensors) { sensor in
            Button {
                onSelect(sensor.id)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(sensor.name).font(.footnote).lineLimit(1)
                        Spacer(minLength: 0)
                        // 一覧は狭いので時刻だけ。基準を超えた値は黄色（一覧は再描画しないので受信時点の判定）
                        if let clock = sensor.measuredClock {
                            Text(clock)
                                .font(.caption2)
                                .monospacedDigit()
                                .foregroundStyle(sensor.isOld(at: Date(), staleAfterMinutes: payload.staleAfterMinutes) ? Color.yellow : Color.secondary)
                        }
                    }
                    HStack(spacing: 8) {
                        Text(WatchFormat.temperature(sensor.temperature))
                        Text(WatchFormat.humidity(sensor.humidity))
                        HStack(spacing: 3) {
                            Circle().fill(Co2Style.color(sensor.co2Level)).frame(width: 8, height: 8)
                            Text(WatchFormat.co2(sensor.co2))
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("センサー")
    }
}

/// 値がまだ届いていない・ログアウト済みのとき
struct EmptyStateView: View {
    var body: some View {
        Text("iPhone の kurashio を開いてダッシュボードを表示すると、値が届きます。")
            .font(.footnote)
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .padding()
    }
}

enum WatchFormat {
    static func temperature(_ value: Double?) -> String { value.map { String(format: "%.1f℃", $0) } ?? "—" }
    static func humidity(_ value: Double?) -> String { value.map { "\(Int($0.rounded()))%" } ?? "—" }
    static func co2(_ value: Double?) -> String { value.map { "\(Int($0.rounded()))" } ?? "—" }

    /// 経過分を「2分前」「1時間前」「2日前」にする。1分未満は「たった今」
    static func age(minutes: Int) -> String {
        switch minutes {
        case ..<1: return "たった今"
        case 1..<60: return "\(minutes)分前"
        case 60..<(60 * 24): return "\(minutes / 60)時間前"
        default: return "\(minutes / (60 * 24))日前"
        }
    }
}

/// CO2の目安の色と文言。段階の判定はWeb側（`getCo2Level()`）が済ませて `co2Level` で届く。
/// ここでは当てるだけで、ppmのしきい値は持たない（文言はWeb側の `CO2_LEVEL_LABELS` と同じ）
enum Co2Style {
    static func color(_ level: String?) -> Color {
        switch level {
        case "high": return .red
        case "elevated": return .yellow
        case "good": return .green
        default: return .gray
        }
    }

    static func label(_ level: String?) -> String {
        switch level {
        case "high": return "CO2 換気を"
        case "elevated": return "CO2 やや高め"
        case "good": return "CO2 良好"
        default: return "CO2"
        }
    }
}
