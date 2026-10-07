import AppIntents
import SwiftUI
import WidgetKit

struct KurashioWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: KurashioEntry

    var body: some View {
        if Self.isLockScreen(family) {
            LockScreenView(family: family, reading: entry.roomReading)
        } else if let snapshot = entry.snapshot, let reading = entry.roomReading {
            if family == .systemLarge {
                LargeContentView(
                    snapshot: snapshot, reading: reading, pressResult: entry.pressResult,
                    updatedText: MeasuredTimeLabel.text(for: [reading], now: entry.date)
                )
            } else if family == .systemMedium {
                let readings = entry.mediumReadings
                MediumContentView(readings: readings, updatedText: MeasuredTimeLabel.text(for: readings, now: entry.date))
            } else {
                if let second = entry.secondReading {
                    SmallDualContentView(
                        first: reading, second: second,
                        updatedText: MeasuredTimeLabel.text(for: [reading, second], now: entry.date)
                    )
                } else {
                    SmallContentView(reading: reading, updatedText: MeasuredTimeLabel.text(for: [reading], now: entry.date))
                }
            }
        } else {
            MessageView(text: "アプリでダッシュボードを開いてください")
        }
    }
}

extension KurashioWidgetView {
    static func isLockScreen(_ family: WidgetFamily) -> Bool {
        switch family {
        case .accessoryCircular, .accessoryRectangular, .accessoryInline: return true
        default: return false
        }
    }
}

/// ロック画面（#676）。単色（vibrant）で描かれるので色は使わず、受信停止も文字で示す。
/// センサーは1つ目（「センサー」）だけを使う。
private struct LockScreenView: View {
    let family: WidgetFamily
    let reading: SharedWidgetSnapshot.RoomReading?

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

    private var temperature: String {
        reading?.temperature.map { String(format: "%.1f℃", $0) } ?? "—"
    }

    private var humidity: String {
        reading?.humidity.map { "湿度 \(Int($0))%" } ?? "湿度 —"
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let reading {
                VStack(spacing: 0) {
                    Text(reading.temperature.map { String(format: "%.1f°", $0) } ?? "—")
                        .font(.system(.body, design: .rounded, weight: .semibold))
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text(reading.stale ? "停止" : "室温")
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
            if let reading {
                let place = reading.name ?? "いまの室温"
                Text(reading.stale ? "\(place)・受信停止" : place)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(temperature)
                    .font(.system(.title3, design: .rounded, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(humidity)
                    .font(.caption)
                    .lineLimit(1)
            } else {
                Text("アプリでダッシュボードを開いてください")
                    .font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inline: Text {
        guard let reading else { return Text("kurashio") }
        let stale = reading.stale ? "（受信停止）" : ""
        return Text("室温 \(temperature) · \(humidity)\(stale)")
    }
}

/// 値を測った時刻の小さな表示（#745）。複数のセンサーを並べるときは、いちばん古い時刻を出す
/// （「この時刻より新しい」と言えるため）。`measuredAt` はJSTの文字列で、端末のタイムゾーンでは解釈し直さない
enum MeasuredTimeLabel {
    static func text(for readings: [SharedWidgetSnapshot.RoomReading], now: Date) -> String? {
        let stamps = readings.compactMap { reading -> String? in
            guard let value = reading.measuredAt, value.count >= 16 else { return nil }
            let text = String(value.prefix(19)).replacingOccurrences(of: " ", with: "T")
            return text.dropFirst(10).first == "T" ? text : nil
        }
        guard let oldest = stamps.min() else { return nil }
        let day = String(oldest.prefix(10))
        let clock = String(oldest.dropFirst(11).prefix(5))
        if day == today(now: now) { return "\(clock) 取得" }
        let parts = day.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let date = Int(parts[2]) else { return "\(clock) 取得" }
        return "\(month)/\(date) \(clock) 取得"
    }

    private static func today(now: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: now)
    }
}

/// 最下部の右寄せ9pt。既存の文字サイズは変えず、余白に足す
private struct MeasuredTimeNote: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .trailing)
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
    var updatedText: String? = nil

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
            MeasuredTimeNote(text: updatedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// Small・2台表示（#569）: 上下2段に、名前と 温度・湿度・CO2 を1行ずつ並べる
private struct SmallDualContentView: View {
    let first: SharedWidgetSnapshot.RoomReading
    let second: SharedWidgetSnapshot.RoomReading
    var updatedText: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SensorBlock(reading: first)
            Divider().padding(.vertical, 4)
            SensorBlock(reading: second)
            Spacer(minLength: 0)
            MeasuredTimeNote(text: updatedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// Medium（329×155pt相当）: 最大4地点を2×2で並べる（#614）。1台は大きく、2台は左右、3〜4台は2×2
private struct MediumContentView: View {
    let readings: [SharedWidgetSnapshot.RoomReading]
    var updatedText: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            Group { content }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            MeasuredTimeNote(text: readings.count <= 1 ? nil : updatedText)
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    @ViewBuilder
    private var content: some View {
        Group {
            if readings.count <= 1, let only = readings.first {
                SmallContentView(reading: only, updatedText: updatedText)
            } else if readings.count == 2 {
                HStack(alignment: .center, spacing: 0) {
                    SensorBlock(reading: readings[0])
                    Divider().padding(.horizontal, 12)
                    SensorBlock(reading: readings[1])
                }
            } else {
                VStack(spacing: 0) {
                    row(readings.prefix(2))
                    Divider().padding(.vertical, 4)
                    row(readings.dropFirst(2))
                }
            }
        }
    }

    private func row(_ items: ArraySlice<SharedWidgetSnapshot.RoomReading>) -> some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, reading in
                if index > 0 { Divider().padding(.horizontal, 12) }
                SensorBlock(reading: reading)
            }
            // 3台のときは右下を空けて、左下のブロックの幅を上段と揃える
            if items.count == 1 {
                Divider().padding(.horizontal, 12).hidden()
                Color.clear.frame(maxWidth: .infinity)
            }
        }
    }
}

private struct SensorBlock: View {
    let reading: SharedWidgetSnapshot.RoomReading

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            // 止まっている段は行を増やさず、名前の行の末尾に添える（2台とも止まっても高さに収まる）
            HStack(spacing: 4) {
                Text(reading.name ?? "いまの室温")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if reading.stale {
                    Text("受信停止")
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            .font(.caption2)
            // 温度・湿度を1行、CO2を次の行に分けて、幅が足りず「…」で切れないようにする
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(reading.temperature.map { String(format: "%.1f℃", $0) } ?? "—")
                    .font(.system(size: 22, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(reading.humidity.map { "\(Int($0))%" } ?? "—")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let co2 = reading.co2 {
                HStack(spacing: 3) {
                    Co2Dot(level: reading.co2Level)
                    Text("CO2 \(Int(co2.rounded())) ppm")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
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
    var updatedText: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(reading.name.map { "センサー・\($0)" } ?? "センサー")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                MeasuredTimeNote(text: updatedText)
            }

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
