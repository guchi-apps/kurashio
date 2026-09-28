import SwiftUI

@main
struct KurashioApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
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
        .onAppear { model.startIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            // 別アプリへ行っているあいだに回線が戻っていることがある
            if phase == .active, model.failure != nil { model.retry() }
        }
    }
}
