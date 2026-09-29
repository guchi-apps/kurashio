import AppIntents
import SwiftUI
import WidgetKit

struct KurashioWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: KurashioEntry

    var body: some View {
        if let snapshot = entry.snapshot, let reading = entry.roomReading {
            if family == .systemLarge {
                LargeContentView(snapshot: snapshot, reading: reading, pressResult: entry.pressResult)
            } else {
                if let second = entry.secondReading {
                    SmallDualContentView(first: reading, second: second)
                } else {
                    SmallContentView(reading: reading)
                }
            }
        } else {
            MessageView(text: "アプリでダッシュボードを開いてください")
        }
    }
}

private struct MessageView: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// Small（155×155pt相当）: 室温・湿度の2項目だけに絞る
private struct SmallContentView: View {
    let reading: SharedWidgetSnapshot.RoomReading

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(reading.name.map { "\($0)の室温" } ?? "いまの室温")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Text(reading.temperature.map { String(format: "%.1f℃", $0) } ?? "—")
                .font(.system(size: 34, weight: .bold))
                .minimumScaleFactor(0.6)

            if let humidity = reading.humidity {
                Text("湿度 \(Int(humidity))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // CO2を測れないセンサーでは行ごと出さない（#569）
            if let co2 = reading.co2 {
                HStack(spacing: 4) {
                    Co2Dot(level: reading.co2Level)
                    Text("CO2 \(Int(co2.rounded())) ppm")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            StaleNote(stale: reading.stale)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// Small・2台表示（#569）: 上下2段に、名前と 温度・湿度・CO2 を1行ずつ並べる
private struct SmallDualContentView: View {
    let first: SharedWidgetSnapshot.RoomReading
    let second: SharedWidgetSnapshot.RoomReading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SensorBlock(reading: first)
            Divider().padding(.vertical, 4)
            SensorBlock(reading: second)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding()
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

private struct SensorBlock: View {
    let reading: SharedWidgetSnapshot.RoomReading

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(reading.name ?? "いまの室温")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(reading.temperature.map { String(format: "%.1f℃", $0) } ?? "—")
                    .font(.system(size: 20, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(reading.humidity.map { "\(Int($0))%" } ?? "—")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let co2 = reading.co2 {
                    HStack(spacing: 2) {
                        Co2Dot(level: reading.co2Level)
                        Text("\(Int(co2.rounded()))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .lineLimit(1)
            // 止まっている段にだけ添える
            StaleNote(stale: reading.stale)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// CO2の目安の色点。段階の判定はWeb側（`getCo2Level()`）が済ませて `co2Level` で届く。
/// ここでは色を当てるだけで、ppmのしきい値は持たない（#569）
private struct Co2Dot: View {
    let level: String?

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
    }

    private var color: Color {
        switch level {
        case "high": return .red
        case "elevated": return .yellow
        case "good": return .green
        default: return .gray
        }
    }
}

/// Large（329×345pt相当）: 室温・湿度・次のゴミ収集・今日の電気量の4項目
private struct LargeContentView: View {
    let snapshot: SharedWidgetSnapshot.Snapshot
    let reading: SharedWidgetSnapshot.RoomReading
    let pressResult: WidgetPressStore.Result?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(reading.name.map { "kurashio・\($0)" } ?? "kurashio")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            HStack(spacing: 20) {
                MetricColumn(label: "室温", value: reading.temperature.map { String(format: "%.1f℃", $0) } ?? "—")
                MetricColumn(label: "湿度", value: reading.humidity.map { "\(Int($0))%" } ?? "—")
            }

            StaleNote(stale: reading.stale)

            Divider()

            GarbageRow(label: snapshot.garbageLabel, daysUntil: snapshot.garbageDaysUntil)

            EnergyRow(kwh: snapshot.todayKwh, costYen: snapshot.todayCostYen)

            RemoteButtonsGrid(buttons: snapshot.remoteButtons ?? [], result: pressResult)

            Spacer(minLength: 0)
        }
        .padding()
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// 選んだセンサーの受信が止まっているとき、値が「いま」のものではないことを添える
private struct StaleNote: View {
    let stale: Bool

    var body: some View {
        if stale {
            Text("受信が止まっています")
                .font(.caption2)
                .foregroundStyle(.orange)
        }
    }
}

private struct MetricColumn: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 28, weight: .bold))
                .minimumScaleFactor(0.7)
        }
    }
}

private struct GarbageRow: View {
    let label: String?
    let daysUntil: Int?

    var body: some View {
        if let label {
            HStack(spacing: 8) {
                Text(label)
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.blue.opacity(0.85))
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                Text(daysText)
                    .font(.subheadline.bold())
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
        } else {
            Text("次の収集予定はありません")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var daysText: String {
        switch daysUntil {
        case .some(0): return "今日が収集日"
        case .some(1): return "明日が収集日"
        case .some(let n) where n > 1: return "\(n)日後が収集日"
        default: return "収集日"
        }
    }
}

/// 電気の操作ボタン（#546）。押すとアプリが前面に出て、ログイン済みのWebセッションが送る
/// （ウィジェットは認証を持たない）。状態は持たず、押した結果だけを一定時間ボタンに出す
private struct RemoteButtonsGrid: View {
    let buttons: [SharedWidgetSnapshot.RemoteButton]
    let result: WidgetPressStore.Result?

    var body: some View {
        if !buttons.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(buttons.prefix(4), id: \.id) { button in
                    Button(intent: PressRemoteButtonIntent(buttonId: button.id)) {
                        HStack(spacing: 4) {
                            Text(title(for: button))
                                .font(.caption.bold())
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Spacer(minLength: 0)
                            if let mark = mark(for: button) {
                                Text(mark.text)
                                    .font(.caption2.bold())
                                    .foregroundStyle(mark.color)
                            }
                        }
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, minHeight: 30)
                        .background(Color.accentColor.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func title(for button: SharedWidgetSnapshot.RemoteButton) -> String {
        button.groupName.isEmpty ? button.label : "\(button.groupName) \(button.label)"
    }

    private func mark(for button: SharedWidgetSnapshot.RemoteButton) -> (text: String, color: Color)? {
        guard let result, result.buttonId == button.id else { return nil }
        switch result.status {
        case .sent: return ("送信", .green)
        case .failed: return ("失敗", .red)
        case .unknown: return ("不明", .orange)
        }
    }
}

private struct EnergyRow: View {
    let kwh: Double?
    let costYen: Int?

    var body: some View {
        if let kwh {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("今日の電気")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(String(format: "%.1f", kwh))
                    .font(.title3.bold())
                Text("kWh")
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let costYen {
                    Text("\(costYen)円")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(Color.orange.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}
