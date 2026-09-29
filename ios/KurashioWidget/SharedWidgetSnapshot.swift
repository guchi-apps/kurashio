import Foundation
import os

/// メインアプリとWidget Extensionが共有する、ホーム画面ウィジェット表示用の値（#537）。
///
/// Widget（別プロセス）がバックエンドAPIを直接叩く設計だと、認証（Supabase JWT）をApp Group越しに
/// 渡す必要があり、Widget側が独自にrefresh tokenを更新するとWKWebView側のクライアントと衝突して
/// ログアウトを引き起こす（`ios/README.md`「表示用データだけをApp Group経由で共有する」節）。
/// そのため**JWTは渡さず、ダッシュボードが表示している値そのもの**をApp Group共有の
/// UserDefaultsへ書き写す。Widgetはこれを読むだけで、ネットワーク通信は一切行わない。
///
/// **このファイルはメインApp・Widget Extensionの両方のフォルダに同じ内容を置いている。**
/// Xcode16のファイルシステム同期グループ（`PBXFileSystemSynchronizedRootGroup`）は1ファイルが
/// 1つのtargetにしか属せないため、共有コードは物理的に複製している。変更するときは
/// `ios/Kurashio/SharedWidgetSnapshot.swift` と `ios/KurashioWidget/SharedWidgetSnapshot.swift` の
/// 両方を揃えること。
enum SharedWidgetSnapshot {
    private static let suiteName = "group.com.gucchii.kurashio"
    private static let key = "widgetSnapshot"

    struct Snapshot: Codable {
        var roomTemperature: Double?
        var roomHumidity: Double?
        /// 次に収集される品目名（複数なら「・」区切り）。予定が無ければ nil
        var garbageLabel: String?
        /// 上記の収集日までの日数（0=今日、1=明日）
        var garbageDaysUntil: Int?
        var todayKwh: Double?
        var todayCostYen: Int?
    }

    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "WidgetSnapshot")

    /// App Group が entitlements で有効になっていないと、`UserDefaults(suiteName:)` は nil を返さず
    /// **そのプロセス専用の保存先**を黙って返す（アプリが書いた値をWidgetが読めない）。
    /// 共有コンテナのURLが取れるかで、App Group が本当に効いているかを見分ける（#560）
    private static var defaults: UserDefaults? {
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) == nil {
            logger.error("App Group \(suiteName, privacy: .public) のコンテナが取れない。entitlements・Developer Portal の登録を確認すること")
            return nil
        }
        return UserDefaults(suiteName: suiteName)
    }

    /// Web側（`frontend/lib/native-app.ts` の `syncWidgetSnapshot()`）から届いた辞書を保存する。
    ///
    /// **届いた辞書をそのままJSONにして、読む側で `JSONDecoder` に通す形にしないこと**（#560）。
    /// WKWebView から届く数値は `NSNumber`（JSの `null` は `NSNull`）で、整数の項目
    /// （`todayCostYen` など）が `312.0` のように小数で書き出されると `Int` へ読めず、
    /// **1項目の食い違いでスナップショット全体が nil になり**、Widgetは「ダッシュボードを開いて
    /// ください」のままになる。ここで項目ごとに型を整えてから `Snapshot` として保存する
    static func save(_ raw: [String: Any]) {
        let snapshot = Snapshot(
            roomTemperature: double(raw["roomTemperature"]),
            roomHumidity: double(raw["roomHumidity"]),
            garbageLabel: raw["garbageLabel"] as? String,
            garbageDaysUntil: double(raw["garbageDaysUntil"]).map { Int($0.rounded()) },
            todayKwh: double(raw["todayKwh"]),
            todayCostYen: double(raw["todayCostYen"]).map { Int($0.rounded()) }
        )
        guard let defaults else { return }
        do {
            defaults.set(try JSONEncoder().encode(snapshot), forKey: key)
        } catch {
            logger.error("スナップショットを保存できない: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func load() -> Snapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        do {
            return try JSONDecoder().decode(Snapshot.self, from: data)
        } catch {
            logger.error("スナップショットを読めない: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    static func clear() {
        defaults?.removeObject(forKey: key)
    }

    private static func double(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }
}
