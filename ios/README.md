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
| バージョン | `frontend/package.json`（changelog と揃える） | Xcode の `MARKETING_VERSION`。`frontend/package.json` と自動で同期される（下記「バージョンの同期」参照。#535） |

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

### バージョンの同期（`MARKETING_VERSION`）

**`ios/Kurashio.xcodeproj/project.pbxproj` の `MARKETING_VERSION` は `frontend/package.json` の
`version` と常に一致させる**（#535）。手作業では揃え続けられないため、`release-develop-to-main.yml`
のバンプPR作成時に `node ios/scripts/sync-version.mjs` を自動実行しており、`develop` にマージされた
時点で両者は一致している。**Mac miniでのビルド前に手で同期する必要はない**（`git pull` すれば
最新の値が入っている）。

ローカルで値がずれていないかを確かめたい・手元だけで直したいときは、リポジトリルートから
`node ios/scripts/sync-version.mjs` を実行すれば `frontend/package.json` の値へ書き換えられる
（冪等なので、既に一致していれば何もしない）。

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

### プッシュ通知（APNs・#527）

**Web PushとiOSアプリの通知は別経路。** WKWebViewはService Workerを使えないため、iOSアプリはPWAのWeb Push
（`backend/push_notify.py`）を受け取れない。代わりにApple Push Notification service（APNs）を使う別経路
（`backend/apns_notify.py`・`backend/apns_subscriptions.py`）を持ち、ゴミの日・部屋の異常/復旧の通知イベント
（`backend/notify_events.py`）から両方へ同時に配信する。**アプリ内の通知設定（`/devices`の通知設定シート）は
Web版のプッシュ通知の設定とは独立**で、同じiPhoneでPWA（Safariに追加）とネイティブアプリの両方を有効にすると、
同じ通知が2回届くことがある（設定画面にその旨を表示している）。

1. **アプリ全体の許可要求**: 通知設定シートの「アプリの通知を受け取る」をONにしたときだけ、
   OSの許可ダイアログを出す（`WebViewModel.requestNotificationPermission()`）。起動・復帰のたびに
   `refreshNotificationAuthorizationStatus()`が状態を問い合わせ直すが、これは**読み取り専用**
   （`getNotificationSettings`）でダイアログは出さない
2. **デバイストークン**は`AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken`が受け取り、
   `WebViewModel`経由でWeb側（`myroom-native-notification-state`イベント）へ渡す。Web側
   （`frontend/lib/native-notifications.ts`）が「有効にする」フラグを見て`POST /api/apns/register`する
3. **通知タップ**は`AppDelegate`のUNUserNotificationCenterDelegateに集約し、ペイロードの`url`
   （現状すべて`"/"`）へ`WebViewModel.open(path:)`で遷移する。ログイン状態はWKWebViewのセッションが
   そのまま効くため、期限切れなら通常のログイン画面に倒れる
4. **ログアウト・無効化時の解除**は`frontend/lib/auth.ts`の`signOutThisApp()`と
   `disableNativeNotifications()`が`DELETE /api/apns/register`を呼ぶ

**Apple Developer Portal側の準備**（初回だけ）:

1. Certificates, Identifiers & Profiles → Identifiers → 対象App ID（`com.gucchii.kurashio`）で
   Push Notifications capability を有効化する
2. Certificates, Identifiers & Profiles → Keys で APNs用のKeyを作成し `.p8` をダウンロードする
   （1回きり）。Key IDを控える
3. Xcode → Signing & Capabilities → `+ Capability` → Push Notifications を追加する
   （`Kurashio.entitlements`の`aps-environment`はリポジトリに含めてあるので、Xcode上で
   capabilityを足すだけでよい）
4. サーバー側の値（`APNS_AUTH_KEY`・`APNS_KEY_ID`・`APNS_TEAM_ID`・`APNS_BUNDLE_ID`・
   `APNS_ENVIRONMENT`）の登録手順はリポジトリルートの`README.md`「本番環境へのデプロイ」を参照

**無料の個人チーム署名では`aps-environment`が常に`development`になる**（TestFlight/App Store配布
（対象外）をしない限り）。そのため`APNS_ENVIRONMENT`は`sandbox`のままでよく、APNsの
`api.sandbox.push.apple.com`だけに疎通する。

### Mac mini・iPhoneでの初回設定・テスト手順（#527）

1. 上記「準備（初回だけ）」でアプリをインストール済みであること
2. 通知設定シート（`/devices`右上のベル等、`components/notification-settings-sheet.tsx`）を開き、
   「アプリの通知を受け取る」をON。iOSの許可ダイアログが出たら「許可」を選ぶ
3. 同じ画面の「テスト通知を送信」を押し、iPhoneに通知（🔔 kurashio テスト通知）が届くことを確認する
4. ゴミの日・部屋の異常通知は、それぞれの設定を有効にした状態で実際の通知条件（収集前日/当日の
   設定時刻・室温や湿度が閾値を外れる）を待つか、サーバー側で`backend.garbage_notify` /
   `backend.sensor_monitor`をモックモード以外で手動実行して確認する
5. 通知をタップし、アプリが起動してダッシュボードが開くことを確認する（ロック画面からのタップは
   端末のパスコード/Face ID解除を経る。ログアウト状態ならログイン画面が開く）
6. 設定シートでOFFにしたあと「テスト通知を送信」が押せなくなり、以後届かないことを確認する
7. iOSの設定 → 通知 → kurashio で許可をオフにし、アプリに戻って設定シートを開くと
   「OSの通知が拒否されています」と出て「設定アプリを開く」から戻せることを確認する
8. ログアウトし、ログアウト前に有効だった端末へテスト通知（サーバー側から`POST /api/apns/test`相当）を
   送っても届かないことを確認する（登録解除の確認）

### その他

- 外部サイトへのリンク・`target="_blank"` は Safari 等で開く（Web版の画面だけをアプリの中で開く）
- `window.confirm()`（記録の削除など）はアプリ側でダイアログを出す。実装しないと常に「キャンセル」になる

## ホーム画面ウィジェット（`KurashioWidget`・#537）

室温・ゴミの日・今日の電気量を表示する、iOS標準のホーム画面ウィジェット（Small/Large）。
**電気の操作（ボタン押下）は含まない**（インタラクティブWidget用のAppIntent実装が別途必要なため、
フォローアップIssueへ切り出した）。

### 表示用データだけをApp Group経由で共有する（JWTは渡さない）

WKWebView が持つ Supabase セッションは、Swift 側から本来アクセスできない（前述のGoogleログインの節）。
Widget はメインアプリの外（別プロセス）で動くため、当初はセッション（JWT）そのものをApp Group共有の
Keychainへ書き写し、Widget側でバックエンドAPIを直接叩く設計を検討したが、**計画レビューの指摘で撤回した**。
アプリ内のPKCEクライアントの節にあるとおり、**2つのクライアントが同じrefresh tokenを更新し合うと
ログアウトされる**（Supabaseの既定挙動）。Widgetが独自にrefresh tokenを使ってトークン更新すると、
WKWebView側のセッションを巻き込んでこの問題を再現してしまう。

代わりに、**ダッシュボードが表示している値そのもの**（室温・湿度・次のゴミ収集・今日の電気量）を
App Group共有のUserDefaultsへ書き写す方式にした。

1. `frontend/lib/native-app.ts` の `syncWidgetSnapshot()` が、ダッシュボード（`/`）が開かれている
   あいだ、表示中の値をブリッジ（`kurashioAuth`）へ `{type: "widgetSnapshot", snapshot: {...}}` として
   送る（`components/native-widget-snapshot-sync.tsx` がダッシュボードでだけ呼ぶ）。ログアウト時は
   `{type: "widgetSnapshotCleared"}` を送る
2. `WebViewModel.swift` がこれを受け、`SharedWidgetSnapshot.swift`（App Group共有のUserDefaults）へ
   書き写す
3. Widget の `KurashioTimelineProvider` はこれを読むだけで、**ネットワーク通信・トークンの
   リフレッシュは一切行わない**

トレードオフとして、**Widgetのデータはダッシュボードを開いたときにしか更新されない**
（バックグラウンドでの自動更新は行わない）。認証の仕組みを増やさずに済むことを優先した。

**`SharedWidgetSnapshot.swift` はメインApp・Widget Extensionの両方のフォルダに同じ内容を置いている。**
Xcode16のファイルシステム同期グループ（`PBXFileSystemSynchronizedRootGroup`）は1ファイルが
1つのtargetにしか属せないため、共有コードを物理的に複製する形にした。変更するときは
`ios/Kurashio/SharedWidgetSnapshot.swift` と `ios/KurashioWidget/SharedWidgetSnapshot.swift` の
両方を揃えること。

### App Group の登録が必要（初回だけ）

**Widgetが動くには、Apple Developer PortalでのApp Group（`group.com.gucchii.kurashio`）登録と、
Xcodeでの両target（`Kurashio`・`KurashioWidgetExtension`）へのApp Groups Capability追加が要る。**
`entitlements` ファイル自体はリポジトリに含めたが、Developer Portal側の登録はコードだけでは
完結しない。手順は起票済みの手作業Issueを参照。

### project.pbxproj はXcodeでの確認が前提

**`KurashioWidgetExtension` ターゲットは、Xcodeを使わずテキスト編集で `project.pbxproj` へ
直接追加した。** 新規target・依存関係・Embed Foundation Extensionsのビルドフェーズを、
相互参照するID（24桁hex）を手作業で生成して組んでいる。括弧の対応・ID参照の整合性は
スクリプトで機械的に確認したが、**Xcodeでの実際のビルドは未確認。** Mac miniで開いて
初回ビルドがうまくいかない場合、Xcodeが提案する自動修正（署名・Capabilities周り）を
受け入れて直してよい。
