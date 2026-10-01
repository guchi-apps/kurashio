import AppIntents
import SwiftUI
import WidgetKit

/// 電気の操作ウィジェット（Small・Medium。#649）。ダッシュボードで表示中のボタンを並べる。
/// 押すとアプリが前面に出て、ログイン済みのWebセッションが送る（#546と同じ）
struct KurashioRemoteWidget: Widget {
    let kind: String = "KurashioRemoteWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ControlTimelineProvider()) { entry in
            RemoteWidgetView(entry: entry)
        }
        .configurationDisplayName("電気の操作")
        .description("登録した電気のボタンを押せます。押すとアプリが開いて送信します。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct RemoteWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ControlEntry

    var body: some View {
        let buttons = entry.snapshot?.remoteButtons ?? []
        Group {
            if entry.snapshot == nil {
                Text("アプリでダッシュボードを開いてください")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if buttons.isEmpty {
                Text("表示する電気のボタンがありません")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                content(buttons: buttons)
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }

    @ViewBuilder
    private func content(buttons: [SharedWidgetSnapshot.RemoteButton]) -> some View {
        let isSmall = family == .systemSmall
        let shown = Array(buttons.prefix(isSmall ? 2 : 6))
        VStack(alignment: .leading, spacing: 6) {
            Text("電気の操作")
                .font(.caption2)
                .foregroundStyle(.secondary)
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: isSmall ? 1 : 3),
                spacing: 6
            ) {
                ForEach(shown, id: \.id) { button in
                    Button(intent: PressRemoteButtonIntent(buttonId: button.id)) {
                        VStack(alignment: .leading, spacing: 1) {
                            if !button.groupName.isEmpty {
                                Text(button.groupName)
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            HStack(spacing: 4) {
                                Text(button.label)
                                    .font(.caption.bold())
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.7)
                                if let mark = ControlResultMark.mark(for: button.id, in: entry.pressResult) {
                                    Text(mark.text)
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(mark.isFailure ? .red : (mark.isUnknown ? .orange : .green))
                                }
                            }
                        }
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                        .background(Color.accentColor.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxHeight: .infinity)
        }
    }
}
