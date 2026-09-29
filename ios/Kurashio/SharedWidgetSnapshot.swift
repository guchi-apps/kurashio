import Foundation

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

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: suiteName)
    }

    /// Web側（`frontend/lib/native-app.ts` の `syncWidgetSnapshot()`）から届いた辞書をそのまま保存する
    static func save(_ raw: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { return }
        defaults?.set(data, forKey: key)
    }

    static func load() -> Snapshot? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func clear() {
        defaults?.removeObject(forKey: key)
    }
}
