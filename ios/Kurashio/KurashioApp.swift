import SwiftUI

@main
struct KurashioApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView(appDelegate: appDelegate)
        }
    }
}

struct ContentView: View {
    let appDelegate: AppDelegate

    @StateObject private var model = WebViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // ステータスバーの部分はWebのヘッダーと同じ色で塗る。WebViewはステータスバーの
            // 下から始めるので、スクロールした内容が上端へ潜らない（PWAのぼかし #521 とは別の作り）
            Color("HeaderBand").ignoresSafeArea()

            WebViewContainer(webView: model.webView)
                .ignoresSafeArea(edges: .bottom)

            if let failure = model.failure {
                ConnectionErrorView(failure: failure, isRetrying: model.isRetrying, retry: model.retry)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.failure)
        .onAppear {
            appDelegate.webViewModel = model
            model.startIfNeeded()
            model.refreshNotificationAuthorizationStatus()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                // 閉じている間に最新の値を取っておく（#735）。実行の時刻・回数は OS が決める
                BackgroundRefresh.schedule()
                return
            }
            guard phase == .active else { return }
            // 別アプリへ行っているあいだに回線が戻っていることがある
            if model.failure != nil { model.retry() }
            // 別アプリ（設定アプリ）で通知の許可状態を変えて戻ってきたことがある（#527）
            model.refreshNotificationAuthorizationStatus()
            // ウィジェットのボタンで起こされた・戻ってきたとき、保留があればWebへ知らせる（#546）
            model.nudgePendingWidgetPress()
        }
    }
}
