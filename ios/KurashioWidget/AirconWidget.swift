import AppIntents
import SwiftUI
import WidgetKit

/// エアコンの操作ウィジェット（Small 1台・Medium 2台。#649）。電源のオン・オフと設定温度の±0.5℃。
/// 押すとアプリが前面に出て、ログイン済みのWebセッションが送る。**温度の増減は、押した時点で
/// Web側がエアコンの現在値を読み直して計算する**（ウィジェットの表示値は古いことがある）
struct KurashioAirconWidget: Widget {
    let kind: String = "KurashioAirconWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ControlTimelineProvider()) { entry in
            AirconWidgetView(entry: entry)
        }
        .configurationDisplayName("エアコンの操作")
        .description("エアコンの電源と設定温度を変えられます。押すとアプリが開いて送信します。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct AirconWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ControlEntry

    var body: some View {
        let units = entry.snapshot?.aircons ?? []
        Group {
            if entry.snapshot == nil {
                message("アプリでダッシュボードを開いてください")
            } else if units.isEmpty {
                message("操作できるエアコンがありません")
            } else if family == .systemSmall {
                AirconUnitView(unit: units[0], result: entry.pressResult, compact: true)
            } else {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(Array(units.prefix(2).enumerated()), id: \.element.id) { index, unit in
                        if index > 0 { Divider().padding(.horizontal, 10) }
                        AirconUnitView(unit: unit, result: entry.pressResult, compact: false)
                    }
                    if units.count == 1 { Color.clear.frame(maxWidth: .infinity) }
                }
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct AirconUnitView: View {
    let unit: SharedWidgetSnapshot.Aircon
    let result: WidgetPressStore.Result?
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(unit.name)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(unit.targetTemperature.map { String(format: "%.1f℃", $0) } ?? "—")
                    .font(.system(size: compact ? 24 : 22, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                if let room = unit.roomTemperature {
                    Text(String(format: "室温 %.1f", room))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            HStack(spacing: 5) {
                actionButton("−", action: "temp_down")
                actionButton("＋", action: "temp_up")
            }
            HStack(spacing: 5) {
                actionButton("オン", action: "power_on", small: true)
                actionButton("オフ", action: "power_off", small: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionButton(_ title: String, action: String, small: Bool = false) -> some View {
        let buttonId = "aircon:\(unit.id):\(action)"
        let mark = ControlResultMark.mark(for: buttonId, in: result)
        return Button(intent: PressAirconIntent(acId: unit.id, action: action)) {
            Text(mark?.text ?? title)
                .font(small ? .caption2.bold() : .subheadline.bold())
                .foregroundStyle(mark.map { $0.isFailure ? Color.red : ($0.isUnknown ? Color.orange : Color.green) } ?? Color.primary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.accentColor.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}
