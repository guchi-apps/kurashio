import SwiftUI
import WidgetKit

/// iPhoneホーム画面用ウィジェット（#537）。室温・ゴミの日・今日の電気量を表示する。
/// 電気の操作（ボタン押下）はインタラクティブWidgetの実装が別途必要になるため、
/// このウィジェットのスコープには含めていない（フォローアップIssueへ切り出し済み）。
struct KurashioWidget: Widget {
    let kind: String = "KurashioWidget"

    var body: some WidgetConfiguration {
        // 室温・湿度を出すセンサーを「ウィジェットを編集」で選べるよう、設定付きにしている（#560）
        AppIntentConfiguration(kind: kind, intent: SelectSensorIntent.self, provider: KurashioTimelineProvider()) { entry in
            KurashioWidgetView(entry: entry)
        }
        .configurationDisplayName("kurashio")
        .description("室温・ゴミの日・今日の電気量を表示します。")
        .supportedFamilies([.systemSmall, .systemLarge])
    }
}
