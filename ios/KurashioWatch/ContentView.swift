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
                        SensorPage(sensor: sensor)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(sensor.name)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if sensor.stale {
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
        }
        .opacity(sensor.stale ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
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
                    Text(sensor.name).font(.footnote).lineLimit(1)
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
