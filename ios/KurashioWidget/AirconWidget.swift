import AppIntents
import SwiftUI
import WidgetKit

/// エアコンの操作ウィジェット（Small・Medium。ダッシュボードで表示中の1台。#649）。電源のオン・オフと設定温度の±0.5℃。
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
                // 操作できない構成（白くまくんの設定が未完了）・オフライン・非表示のとき
                message("操作できるエアコンがありません")
            } else {
                AirconUnitView(unit: units[0], result: entry.pressResult, wide: family == .systemMedium)
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
    /// Medium: 左に状態、右に4つのボタン。Small: 縦に積む
    let wide: Bool

    /// 自動運転の「設定温度」は温度ではなくシフト量（-5.0〜+5.0）。℃として出すと誤解を招く
    private var isAuto: Bool { unit.mode?.uppercased() == "AUTO" }

    private var targetText: String {
        guard let target = unit.targetTemperature else { return "—" }
        return isAuto ? String(format: "自動 %+.1f", target) : String(format: "%.1f℃", target)
    }

    var body: some View {
        if wide {
            HStack(alignment: .center, spacing: 12) {
                info
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        actionButton("−", action: "temp_down")
                        actionButton("＋", action: "temp_up")
                    }
                    HStack(spacing: 6) {
                        actionButton("オン", action: "power_on", small: true)
                        actionButton("オフ", action: "power_off", small: true)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        } else {
            VStack(alignment: .leading, spacing: 5) {
                info
                HStack(spacing: 5) {
                    actionButton("−", action: "temp_down")
                    actionButton("＋", action: "temp_up")
                }
                HStack(spacing: 5) {
                    actionButton("オン", action: "power_on", small: true)
                    actionButton("オフ", action: "power_off", small: true)
                }
            }
        }
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(unit.name)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(targetText)
                .font(.system(size: wide ? 30 : 24, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let room = unit.roomTemperature {
                Text(String(format: "室温 %.1f℃", room))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
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
