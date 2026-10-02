import Foundation
import os

/// アプリを閉じている間に、ウィジェット・Apple Watch がセンサーの値を自分で取りにいくための部品（#683）。
///
/// **認証は端末用の読み取りトークン（`kdt_…`）だけ。** Supabaseのセッション（JWT）は渡さない
/// （refresh token を奪い合ってログアウトするため・#537）。トークンは `GET /api/device/sensors` しか読めず、
/// ログイン済みのWebが発行してブリッジで渡す（方式は #681・`ios/README.md`「アプリを閉じている間の自動更新」）。
///
/// - iPhoneアプリ・ウィジェットは App Group `group.com.gucchii.kurashio` へ保存する。**Watchは別端末なので**、
///   iPhoneが WatchConnectivity で送り、Watchアプリが自分の App Group へ保存する（コンプリケーションが読む）
/// - CO2の段階（`co2Level`）はバックエンドが判定して返す。**Swiftはしきい値を持たない**
/// - 値は「ダッシュボードが表示しているセンサー」だけを更新する（`SharedWidgetSnapshot.merged`・`WatchSnapshot.merged`）。
///   表示するセンサーの選択・並び順はWebが正で、ここでは増やさない
///
/// **このファイルは `ios/Kurashio/`・`ios/KurashioWidget/`・`ios/KurashioWatch/`・`ios/KurashioWatchWidget/` の
/// 4か所に同じ内容を置いている**（ファイルシステム同期グループは1ファイルが1つのtargetにしか属せない）。
/// 変更するときは4つとも揃えること（`ios/scripts/check-consistency.mjs` が照合する）。
enum DeviceSensors {
    /// 取得の間隔の目安。実際の実行はOS任せ（Timeline の `.after`・Watch のバックグラウンド更新）
    static let refreshInterval: TimeInterval = 15 * 60
    /// 同じ端末の中で、これより短い間隔では取り直さない。ウィジェットは種類ごとにTimelineが走り、
    /// ダッシュボードの同期でも再評価されるため、毎回取りにいくと無駄にサーバーを叩く
    static let minimumFetchGap: TimeInterval = 60

    /// `AppConfig.baseURL`（`https://myroom.gucchii.com/`）と同じ。このファイルはアプリ以外の
    /// targetにも置くので `AppConfig` を参照できない（`check-consistency.mjs` が一致を照合する）
    static let endpoint = URL(string: "https://myroom.gucchii.com/api/device/sensors")!

    private static let suiteName = "group.com.gucchii.kurashio"
    private static let tokenKey = "deviceToken"
    private static let fetchedAtKey = "deviceSensorsFetchedAt"
    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "DeviceSensors")

    // MARK: - 応答（`GET /api/device/sensors`）

    struct Sensor: Decodable {
        var deviceId: Int
        var name: String
        var measuredAt: String?
        var stale: Bool
        var temperature: Double?
        var humidity: Double?
        var co2: Double?
        var co2Level: String?
    }

    struct Response: Decodable {
        var staleThresholdMinutes: Int?
        var sensors: [Sensor]
    }

    enum FetchResult {
        case ok(Response)
        /// トークンが無い（まだ渡されていない・ログアウト済み）
        case noToken
        /// 401。失効済み・存在しないトークン。保存は捨てた（アプリを開くとWebが発行し直す）
        case unauthorized
        /// 通信できない・サーバーのエラー・読めない応答。次の機会に取り直す
        case failed
    }

    // MARK: - トークンの保存

    /// App Group が entitlements で有効になっていないと `UserDefaults(suiteName:)` は共有できない保存先を
    /// 黙って返す。共有コンテナが取れるかで本当に効いているかを見分ける（`SharedWidgetSnapshot` と同じ）
    private static var defaults: UserDefaults? {
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) == nil {
            logger.error("App Group \(suiteName, privacy: .public) のコンテナが取れない。entitlements・Developer Portal の登録を確認すること")
            return nil
        }
        return UserDefaults(suiteName: suiteName)
    }

    static func loadToken() -> String? {
        guard let token = defaults?.string(forKey: tokenKey), isValid(token: token) else { return nil }
        return token
    }

    /// 読み取り専用トークン（`kdt_` で始まる）だけを受ける。それ以外（JWTなど）は保存しない
    static func saveToken(_ token: String) {
        guard isValid(token: token) else {
            logger.error("端末用トークンの形ではないので保存しない")
            return
        }
        defaults?.set(token, forKey: tokenKey)
    }

    static func clearToken() {
        defaults?.removeObject(forKey: tokenKey)
        defaults?.removeObject(forKey: fetchedAtKey)
    }

    static func isValid(token: String) -> Bool {
        token.hasPrefix("kdt_") && token.count > 8
    }

    // MARK: - 取得

    /// 取りにいく間隔を空けたいとき用。前回の成功から `minimumFetchGap` 未満なら true
    private static func fetchedRecently(now: Date) -> Bool {
        guard let last = defaults?.object(forKey: fetchedAtKey) as? Double else { return false }
        return now.timeIntervalSince1970 - last < minimumFetchGap
    }

    /// 取り直す必要があるときだけ取る。直近に成功していたら nil（保存済みの値をそのまま使う）
    static func fetchIfDue(now: Date = Date()) async -> Response? {
        guard loadToken() != nil, !fetchedRecently(now: now) else { return nil }
        if case .ok(let response) = await fetch(now: now) { return response }
        return nil
    }

    static func fetch(now: Date = Date()) async -> FetchResult {
        guard let token = loadToken() else { return .noToken }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed }
            if http.statusCode == 401 {
                // 失効したトークンを持ち続けない。アプリを開くと、Webが持っていないと知って発行し直す
                clearToken()
                return .unauthorized
            }
            guard http.statusCode == 200 else { return .failed }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            defaults?.set(now.timeIntervalSince1970, forKey: fetchedAtKey)
            return .ok(decoded)
        } catch {
            logger.error("センサーを取得できない: \(error.localizedDescription, privacy: .public)")
            return .failed
        }
    }

    /// 次に取りにいく時刻（Timeline の `.after` に渡す）。トークンが無いときは nil（自分では要求しない）
    static func nextRefreshDate(from now: Date = Date()) -> Date? {
        loadToken() == nil ? nil : now.addingTimeInterval(refreshInterval)
    }
}
