import SwiftUI
import WidgetKit

/// iPhoneホーム画面用ウィジェット（#537）。室温・ゴミの日・今日の電気量を表示する。
/// Largeには電気の操作ボタンも並ぶ（#546）。押すとアプリが前面に出て、Webのセッションで送る。
struct KurashioWidget: Widget {
    let kind: String = "KurashioWidget"

    var body: some WidgetConfiguration {
        // 室温・湿度を出すセンサーを「ウィジェットを編集」で選べるよう、設定付きにしている（#560）
        AppIntentConfiguration(kind: kind, intent: SelectSensorIntent.self, provider: KurashioTimelineProvider()) { entry in
            KurashioWidgetView(entry: entry)
        }
        .configurationDisplayName("kurashio")
        .description("室温・湿度・CO2・ゴミの日・今日の電気量を表示し、Mediumでは最大4か所を並べ、Largeでは電気の操作もできます。ロック画面には室温と湿度を表示します。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
