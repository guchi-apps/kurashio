import SwiftUI
import WidgetKit

struct GarbageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GarbageEntry

    var body: some View {
        if let upcoming = entry.upcoming {
            if let next = upcoming.first {
                if family == .systemMedium {
                    MediumGarbageView(next: next, rest: Array(upcoming.dropFirst().prefix(3)))
                } else {
                    SmallGarbageView(next: next)
                }
            } else {
                GarbageMessageView(text: "次の収集予定はありません")
            }
        } else {
            GarbageMessageView(text: "アプリでダッシュボードを開いてください")
        }
    }
}

private struct GarbageMessageView: View {
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

/// "8/26(水)"。日付の文字列は端末のタイムゾーンで解釈し直さない
private func dateText(_ day: SharedWidgetSnapshot.GarbageDay) -> String {
    let parts = day.date.split(separator: "-")
    guard parts.count == 3, let month = Int(parts[1]), let date = Int(parts[2]) else { return day.date }
    return "\(month)/\(date)(\(day.weekday))"
}

/// 今日・明日は言葉で、それ以降は「あと3日」
private func countdownText(_ daysUntil: Int) -> (text: String, unit: String?) {
    switch daysUntil {
    case ...0: return ("今日", nil)
    case 1: return ("明日", nil)
    default: return ("あと\(daysUntil)", "日")
    }
}

private func color(hex: String) -> Color {
    let trimmed = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard trimmed.count == 6, let value = UInt32(trimmed, radix: 16) else { return .gray }
    return Color(
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255
    )
}

private struct CategoryChips: View {
    let categories: [SharedWidgetSnapshot.GarbageCategory]

    var body: some View {
        // 品目が増えても高さに収まるよう、幅に合わせて折り返す
        ViewThatFits(in: .vertical) {
            chips(categories)
            chips(Array(categories.prefix(2)))
        }
    }

    private func chips(_ items: [SharedWidgetSnapshot.GarbageCategory]) -> some View {
        HStack(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, category in
                Text(category.name)
                    .font(.caption2.bold())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(color(hex: category.color))
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
        }
    }
}

private struct CountdownText: View {
    let daysUntil: Int
    var size: CGFloat = 34

    var body: some View {
        let countdown = countdownText(daysUntil)
        HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text(countdown.text)
                .font(.system(size: size, weight: .heavy))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let unit = countdown.unit {
                Text(unit).font(.system(size: size * 0.4, weight: .bold))
            }
        }
        // 当日は橙で強調する（ダッシュボードのカードと同じ扱い）
        .foregroundStyle(daysUntil <= 0 ? Color.orange : Color.primary)
    }
}

/// Small（155×155pt相当）: 次の収集を大きく
private struct SmallGarbageView: View {
    let next: GarbageDisplayDay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("ごみの日").font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(dateText(next.day)).font(.caption2).foregroundStyle(.secondary)
            }
            .lineLimit(1)
            CountdownText(daysUntil: next.daysUntil)
            CategoryChips(categories: next.day.categories)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

/// Medium（329×155pt相当）: 左に次の収集、右に今後3件
private struct MediumGarbageView: View {
    let next: GarbageDisplayDay
    let rest: [GarbageDisplayDay]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("ごみの日").font(.caption2).foregroundStyle(.secondary)
                CountdownText(daysUntil: next.daysUntil, size: 32)
                CategoryChips(categories: next.day.categories)
                Text(dateText(next.day)).font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .frame(width: 130, alignment: .leading)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("このあと").font(.caption2).foregroundStyle(.secondary)
                ForEach(Array(rest.enumerated()), id: \.offset) { _, item in
                    HStack(spacing: 6) {
                        Text(dateText(item.day))
                            .font(.caption.bold())
                            .frame(width: 62, alignment: .leading)
                        Text(item.day.categories.map(\.name).joined(separator: "・"))
                            .font(.caption)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}
