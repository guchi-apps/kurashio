import BackgroundTasks
import Foundation
import os

/// アプリを閉じている間に、センサーの最新値を取っておく（#735）。
///
/// 次にアプリを開いたとき、Web版は端末に残した前回のダッシュボードを先に出し（`frontend/lib/offline-cache.ts`）、
/// ここで取った値のうち**それより新しいもの**を重ねる。回線が遅い・つながらないときも、閉じている間に
/// 取れていた値までは出せる。
///
/// - **認証は端末用の読み取りトークン（`kdt_…`・#683）だけ。** `DeviceSensors.fetch()` をそのまま使い、
///   Supabaseのセッションには触れない。トークンが無ければ予約もしない
/// - 実行の時刻・回数は OS（BGTaskScheduler）が利用状況と電池の状態から決める。`earliestBeginDate` は
///   「これより前には起こさない」という下限でしかない。1回の仕事は GET 1本（数KB）
/// - **値は Web が取りにきたとき（`backgroundSensorsReady`）にだけ返す。** アプリから押し込まない
///   （復帰時の自動リロードと重なって取りこぼすため。ウィジェットの押下 #546 と同じ）
/// - 保存先はアプリ専用の `UserDefaults.standard`。ウィジェット・Watch は自分で取りにいくので共有しない
enum BackgroundRefresh {
    /// `Info.plist` の `BGTaskSchedulerPermittedIdentifiers` と揃えること
    static let taskIdentifier = "com.gucchii.kurashio.refresh"

    private static let storeKey = "backgroundSensors"
    private static let logger = Logger(subsystem: "com.gucchii.kurashio", category: "BackgroundRefresh")

    /// 起動処理（`didFinishLaunching`）が終わる前に呼ぶ。遅れると OS が起こしたときに受け手がいない。
    ///
    /// **`using: .main` を外さないこと。** このターゲットは既定で MainActor 隔離（`SWIFT_DEFAULT_ACTOR_ISOLATION`）で、
    /// ここで書いた閉包も MainActor のものと推論される。`nil`（OSの裏のキュー）で呼ばれると隔離の実行時検査で落ちる
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: .main) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
    }

    /// 次の取得を予約する。バックグラウンドへ移るとき・取得を終えたときに呼ぶ（予約は1件に置き換わる）
    static func schedule() {
        guard DeviceSensors.loadToken() != nil else {
            // ログアウト済み・トークン未発行。取りにいけないので起こしてもらわない
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: DeviceSensors.refreshInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // シミュレーター・「Appのバックグラウンド更新」がオフの端末では失敗する。アプリの動作には影響しない
            logger.error("バックグラウンド更新を予約できない: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let work = Task {
            let result = await DeviceSensors.fetch()
            switch result {
            case .ok(let response):
                save(response)
                task.setTaskCompleted(success: true)
            case .unauthorized, .noToken:
                // トークンは `DeviceSensors` が捨てた（または無い）。古い値も Web へ渡さない
                clear()
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
                task.setTaskCompleted(success: true)
            case .failed:
                task.setTaskCompleted(success: false)
            }
        }
        // 持ち時間（約30秒）を使い切ったとき。通信を止めると `.failed` で完了が呼ばれる。
        // どのスレッドから呼ばれるか決まっていないので、MainActor に縛られない `@Sendable` の閉包にする
        task.expirationHandler = { @Sendable in work.cancel() }
    }

    // MARK: - 保存と受け渡し

    private static func save(_ response: DeviceSensors.Response) {
        let sensors: [[String: Any]] = response.sensors.map { sensor in
            [
                "deviceId": sensor.deviceId,
                "measuredAt": sensor.measuredAt ?? NSNull(),
                "temperature": sensor.temperature ?? NSNull(),
                "humidity": sensor.humidity ?? NSNull(),
                "co2": sensor.co2 ?? NSNull(),
            ]
        }
        let payload: [String: Any] = ["fetchedAt": Date().timeIntervalSince1970, "sensors": sensors]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        UserDefaults.standard.set(data, forKey: storeKey)
    }

    /// Web の `myroom-native-background-sensors` に渡す JSON。取れていなければ空の一覧
    static func payloadJSON() -> String {
        if let data = UserDefaults.standard.data(forKey: storeKey),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return #"{"sensors":[]}"#
    }

    /// ログアウト時。前の利用者の値を残さない
    static func clear() {
        UserDefaults.standard.removeObject(forKey: storeKey)
    }
}
