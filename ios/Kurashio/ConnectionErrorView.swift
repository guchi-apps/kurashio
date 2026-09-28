import SwiftUI

/// 読み込めなかった理由。オフラインとサーバー側の障害で文言と対処を分ける
enum LoadFailure: Equatable {
    /// 端末がネットワークに繋がっていない
    case offline
    /// 繋がっているがサーバーが応答しない・5xxを返した（`status` は応答が無ければ nil）
    case server(status: Int?)
}

/// 読み込めなかったときにWeb画面の上へ重ねる画面。Safariへは誘導せず、アプリの中で再試行させる
struct ConnectionErrorView: View {
    let failure: LoadFailure
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbolName)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(symbolColor)
                .frame(width: 64, height: 64)
                .background(symbolColor.opacity(0.14), in: Circle())

            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)

            Text(reason)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: retry) {
                HStack(spacing: 8) {
                    if isRetrying { ProgressView().tint(.white) }
                    Text(isRetrying ? "読み込んでいます" : "再読み込み")
                }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 28)
                .frame(minHeight: 46)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(isRetrying)
            .padding(.top, 6)

            if failure == .offline {
                Text("接続が戻ると自動で読み込み直します")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("HeaderBand"))
    }

    private var symbolName: String {
        switch failure {
        case .offline: "wifi.slash"
        case .server: "exclamationmark.icloud"
        }
    }

    private var symbolColor: Color {
        switch failure {
        case .offline: .secondary
        case .server: .orange
        }
    }

    private var title: String {
        switch failure {
        case .offline: "インターネットに接続できません"
        case .server: "kurashioのサーバーに接続できません"
        }
    }

    private var reason: String {
        switch failure {
        case .offline:
            "この端末がオフラインのようです。Wi-Fiかモバイル通信を確かめてから、もう一度読み込んでください。"
        case .server(let status?):
            "サーバーが応答していません（エラー \(status)）。更新作業中の可能性があります。少し待ってからもう一度読み込んでください。"
        case .server(nil):
            "サーバーが応答していません。更新作業中の可能性があります。少し待ってからもう一度読み込んでください。"
        }
    }
}

#Preview("オフライン") {
    ConnectionErrorView(failure: .offline, isRetrying: false, retry: {})
}

#Preview("サーバー障害") {
    ConnectionErrorView(failure: .server(status: 502), isRetrying: false, retry: {})
}
