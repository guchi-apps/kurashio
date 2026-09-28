# kurashio iOSアプリ

kurashio（`https://myroom.gucchii.com/`）を iPhone のホーム画面から独立したアプリとして開くための、
SwiftUI + WKWebView の薄い殻です（#526）。**画面と機能はすべてWeb版が正本**で、このディレクトリには
「Web版を開く・Googleログインを往復させる・通信できないときに再試行させる」ことしか書いていません。

| 項目 | 値 |
|---|---|
| 表示名 | kurashio |
| Bundle ID | `com.gucchii.kurashio`（AIDE-ios の `com.gucchii.AIDEios` とは別） |
| 署名 | Automatic（個人チーム `6AA3WFTR94`） |
| 対応 | iPhone・縦向き・iOS 18以上 |
| ログインの戻り先 | `kurashio://auth-callback` |

## Web版とiOS版で、更新が要る場所の違い

| 変えたもの | Web版（PWA・ブラウザ） | iOSアプリ |
|---|---|---|
| 画面・機能（`frontend/`・`backend/`） | main へマージ → 自動デプロイ | **何もしなくてよい。** 次に開いたとき（または10分ごとの更新チェック #277）にWeb版の新しいビルドが出る |
| アプリの殻（`ios/`） | 影響なし（`out/` 以外は配信されない） | Mac mini でビルドし直して iPhone へ入れ直す |
| アイコン（`frontend/assets/kurashio-app-icon.png`） | `node scripts/generate-icons.mjs`（`frontend/`で実行） | 同じスクリプトで `ios/.../AppIcon.appiconset` も書き出される。**そのあとビルドし直す** |
| バージョン | `frontend/package.json`（changelog と揃える） | Xcode の `MARKETING_VERSION`（`ios/` を変えたときだけ上げる） |

**Web版とiOS版のリリースは独立しています。** Web版を main へ出すたびにアプリを入れ直す必要はありません。

## Mac mini でのビルド・iPhone へのインストール

初回だけ「準備」を行い、2回目以降は「ビルドとインストール」だけで済みます。

### 準備（初回だけ）

1. **Supabase の許可リダイレクトURLに `kurashio://auth-callback` を足す。**
   Supabase ダッシュボード → Authentication → URL Configuration → Redirect URLs。
   共有プロジェクトですが、足すだけなので他アプリには影響しません。**無いと、Googleの認証後に
   Web版のURLへ戻されてしまい、アプリに帰ってきません**（認証シートが閉じずに Web版のkurashioが表示される）
2. Mac mini に Xcode（AIDE-ios と同じく Xcode 26 以降。プロジェクトの形式が新しいため）を入れ、
   Xcode → Settings → Accounts に自分の Apple ID を追加する
3. iPhone を Mac mini に USB で繋ぎ、iPhone の 設定 → プライバシーとセキュリティ → **デベロッパモード** を
   オンにする（再起動を求められる）

### ビルドとインストール

```bash
cd ~/apps/myroom        # Mac mini 上のチェックアウト
git pull
open ios/Kurashio.xcodeproj
```

1. 上部のスキームが `Kurashio`、実行先が自分の iPhone になっていることを確かめる
2. ⌘R（Product → Run）。初回は Signing & Capabilities の Team が個人チームになっているかを確かめる
3. 初回だけ、iPhone の 設定 → 一般 → VPNとデバイス管理 で自分の開発者証明書を「信頼」する

**無料の個人チームで署名したアプリは7日で起動できなくなります**（有料の Apple Developer Program なら1年）。
起動しなくなったら、同じ手順でもう一度 ⌘R すれば直ります（ログイン状態は残ります）。

### 開発サーバーへ向けるとき

`Kurashio/AppConfig.swift` の `baseURL` だけを変えます。**LAN IP の `http://` のままでは Google ログインが
戻れない**ため、sslip.io などでホスト名にし、そのURLも Supabase の許可リダイレクトURL（Site URL 側）に
入っている必要があります（`sslip-io-lan-dev` の手順）。戻すのを忘れてコミットしないこと。

## 仕組み

### Googleログイン（認証シートとの往復）

Google は埋め込みブラウザ（WKWebView）でのログインを `disallowed_useragent` で拒むため、
**認証画面だけを iOS 標準の認証シート（`ASWebAuthenticationSession`）で開きます。**

1. Web のログインボタンが、アプリの中だけ PKCE の Supabase クライアントで認可URLを作る
   （`frontend/lib/native-app.ts`）。`code_verifier` は WebView の localStorage に残る
2. ブリッジ `window.webkit.messageHandlers.kurashioAuth` でURLだけをアプリへ渡す
3. アプリが認証シートを開き、Google → Supabase → `kurashio://auth-callback?code=…` で戻る
4. アプリが WebView で `/auth/callback?code=…` を開き、**交換・許可の確認（`/api/auth/me`）・ログイン通知は
   Web版と同じコールバック**が行う

アクセストークン・リフレッシュトークンは URL にもアプリ（Swift）にも出ません。`code` は一度きりで、
WebView の中にある `code_verifier` が無ければ交換できません。

- セッションは WKWebView の既定データストアに残るので、アプリを終了・再起動してもログインしたまま
- ログアウトは Web版と同じ `signOutThisApp()`（`scope: "local"`・#426）で、他アプリ・他端末は巻き込まない
- 認証シートを閉じた（キャンセル）ときは、ログインボタンを押せる状態へ戻すだけ

### 通信できないとき

WKWebView では Service Worker が使えないため、オフラインでキャッシュの画面は出ません。代わりに
アプリ側（`ConnectionErrorView.swift`）が理由と「再読み込み」を出します。

- 端末がオフライン → 「インターネットに接続できません」。回線が戻ると自動で読み込み直す
- サーバーが 5xx を返す・応答しない → 「kurashioのサーバーに接続できません（エラー 502）」
- Safari へは誘導しない

### 上端（ステータスバー）

WebView はステータスバーの**下から**始め、ステータスバーの部分はアプリがヘッダーと同じ色
（`HeaderBand`・`globals.css` の `--header-band`）で塗ります。内容がステータスバーの下へ潜らないため、
PWA で出ている上端のぼかし（#478・#521）とは別の作りです。Web側の `--pwa-header-safe-gap` は
`display-mode: standalone` のときだけ効くので、アプリの中では 0 のままです。

### その他

- 外部サイトへのリンク・`target="_blank"` は Safari 等で開く（Web版の画面だけをアプリの中で開く）
- `window.confirm()`（記録の削除など）はアプリ側でダイアログを出す。実装しないと常に「キャンセル」になる
- Web Push は受け取れない（通知設定にその旨を出す）。ネイティブの通知は別Issue
