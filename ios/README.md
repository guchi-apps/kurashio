# kurashio iOSアプリ

kurashio（`https://myroom.gucchii.com/`）を iPhone のホーム画面から独立したアプリとして開くための、
SwiftUI + WKWebView の薄い殻です（#526）。**画面と機能はすべてWeb版が正本**で、このディレクトリには
「Web版を開く・Googleログインを往復させる・通信できないときに再試行させる」ことしか書いていません。

| 項目 | 値 |
|---|---|
| 表示名 | kurashio |
| Bundle ID | `com.gucchii.kurashio`（AIDE-ios の `com.gucchii.AIDEios` とは別） |
| 署名 | Automatic（有料の Apple Developer Program のチーム `6AA3WFTR94`。無料の個人チームではプッシュ通知を使えない・#560） |
| 対応 | iPhone（縦向き）・iPad（縦横4方向・ウィンドウは1つだけ）・iOS 18以上。ウィジェットは iPhone のみ（#642） |
| ログインの戻り先 | `kurashio://auth-callback` |

## Web版とiOS版で、更新が要る場所の違い

| 変えたもの | Web版（PWA・ブラウザ） | iOSアプリ |
|---|---|---|
| 画面・機能（`frontend/`・`backend/`） | main へマージ → 自動デプロイ | **何もしなくてよい。** 次に開いたとき（または10分ごとの更新チェック #277）にWeb版の新しいビルドが出る |
| アプリの殻（`ios/`） | 影響なし（`out/` 以外は配信されない） | main のリリースで **TestFlight へ自動配布**（配布物が変わったときだけ・#591）。iPhone の TestFlight アプリで更新する。開発ビルドは Mac mini から入れ直す |
| アイコン（`frontend/assets/kurashio-app-icon.png`） | `node scripts/generate-icons.mjs`（`frontend/`で実行） | 同じスクリプトで `ios/.../AppIcon.appiconset` も書き出される。**そのあとビルドし直す** |
| バージョン | `frontend/package.json`（changelog と揃える） | Xcode の `MARKETING_VERSION`。`frontend/package.json` と自動で同期される（下記「バージョンの同期」参照。#535） |

**Web版とiOS版のリリースは独立しています。** Web版を main へ出すたびにアプリを入れ直す必要はありません。

## iOS に関わる変更をしたときの手順（#568）

**まず「何を触ったか」で分ける。入れ直しが要るのは `ios/` の実質的な変更だけ。**

| 触ったもの | 入れ直し | 自動化されていること | 人がやること |
|---|---|---|---|
| `frontend/`・`backend/` のみ | 不要 | main へのマージで自動デプロイ。アプリは次に開いたとき（10分ごとの更新チェック #277）に反映 | なし |
| `frontend/lib/native-app.ts`・`widget-sensors.ts` など Swift と形を共有するファイル | 不要（ただし Swift 側と揃っているか確認） | CI が `check-consistency.mjs` で戻り先スキーム・ブリッジ名などを照合。develop→main のPRに確認コメント | 形（メッセージ・スナップショットの項目）を変えたなら Swift 側も直す |
| `ios/` の Swift・pbxproj・アイコン | **要る** | CI が共有 Swift の一致・pbxproj の整合を照合。develop→main のPRに「更新が必要」のコメント。**main のデプロイ後に TestFlight へ自動配布**（下の「TestFlight への自動配布」） | TestFlight アプリで更新（開発ビルドなら下の「入れ直し」を1コマンド実行） |
| 版番号（`MARKETING_VERSION`） | 不要（次に入れ直すときに反映） | リリースのバンプPRが `sync-version.mjs` で同期（#535） | なし |

**いつ入れ直すか: Web側が main へデプロイされた後に、`main` から。** 殻は本番URLを開くので、
Web側と対になる変更（新しいブリッジのメッセージなど）は Web が先に本番へ出ていないと噛み合わない。
`install-to-iphone.sh` は既定で `main` を取り込む（`IOS_BRANCH` で変えられる）。

### 入れ直し（1コマンド）

iPhone を Mac mini に USB で繋ぎ、ロックを解除しておく。**subpc から**:

```bash
ios/scripts/remote-install.sh        # Tailscale の guchimac-mini へSSHして下のスクリプトを実行
```

Mac mini の前にいるなら、Mac mini のチェックアウトで直接:

```bash
ios/scripts/install-to-iphone.sh     # main を取り込み → 整合チェック → ビルド → 入れ直し → 起動
```

- `MAC_HOST`（既定 `guchimac-mini`）・`MAC_REPO_DIR`（既定 `~/apps/myroom`）・`IOS_BRANCH`・`IOS_DEVICE`・
  `IOS_SKIP_PULL=1` を環境変数で上書きできる
- **`MAC_REPO_DIR` にチルダ（`~/x`）を付けて渡さない。** subpc 側のシェルが先に展開するため、Mac mini のパスにならない。
  絶対パスか、subpc で展開させない `MAC_REPO_DIR='$HOME/x'` のようにシングルクォートで囲んで渡す（Mac mini 側で展開される）
- **subpc から鍵で入れること（初回だけ）。** 端末の無い環境（手作業セッション・無人実行）はパスワードを打てない。
  subpc で `ssh-keygen -t ed25519`（鍵が無ければ）→ `ssh-copy-id guchimac-mini` を実行しておく
- **SSH 経由の署名はログインキーチェーンが開いていないと失敗する。** `remote-install.sh` は同じ `ssh -t` の中で
  ビルドの前に `security unlock-keychain` を実行するので、**Mac mini のログインパスワードを聞かれたら入力する**。
  別の接続で先に解除しても次の接続には引き継がれない（`errSecInternalComponent`）。Mac mini で直接
  `install-to-iphone.sh` を実行するときだけ、事前に一度 `security unlock-keychain ~/Library/Keychains/login.keychain-db` を実行する
- `remote-install.sh` は取り込み（`git fetch` / `merge --ff-only`）を先に SSH で済ませてからスクリプトを呼ぶ
  （Mac mini のチェックアウトが古くても起動できる）。入れ先は実機（`reality == physical`）かつ接続中（`tunnelState == connected`）の iPhone / iPad を自動選択する（2台以上繋がっていると止まるので `IOS_DEVICE=<名前か識別子>` で指定する）
- 作業ツリーに未コミットの変更があると中止する（誤って上書きしないため）
- **subpc からは実行結果を確かめられない**（Xcode が無い）。スクリプトを直したときは Mac mini で1回実行して確かめる
- 手作業のまま残るのは、初回の準備（Supabase・Xcode・デベロッパモード）と、約1年ごとの署名切れのときの入れ直しの起動だけ

## TestFlight への自動配布（#591）

**リリースで `ios/` の配布物が変わったときだけ、Web の本番反映のあとに TestFlight の内部テストグループへ
自動で配る。** 開発ビルドの入れ直し（下の「入れ直し」）に頼らず、iPhone の TestFlight アプリで更新できる。
自動では入らないので、更新は TestFlight アプリで自分で行う。

```
Deploy to Production 成功
  → ios-testflight-trigger.yml（薄い起動役。main の本体を dispatch）
    → ios-testflight.yml:  判定 → 署名・ビルド・アップロード → ビルド処理待ち・内部グループ配布 → 印（タグ）
```

| 段階（ジョブ） | 何をする | 失敗したら |
|---|---|---|
| 判定 | 最後に配布し終えたコミット（タグ `ios-testflight/<ビルド番号>`）との差分を見る。**対象は `ios/Kurashio/`・`ios/KurashioWidget/`・`ios/Kurashio.xcodeproj/` のみ**（README・`ios/scripts/`・版番号の行だけの差分は不要）。印が無ければ初回として要配布 | main に無いコミット・判定エラー。要らなければ「スキップ（Webのみ）」と理由が run のサマリーに出る |
| 署名・ビルド・アップロード | macOS runner でクラウド署名（App Store Connect APIキー）→ アーカイブ → IPA → `altool` でアップロード。ビルド番号はアプリ本体・Widget とも同じ値 | 署名（プロビジョニング）・アーカイブ・アップロードのどのステップで落ちたかがログで分かる |
| ビルド処理待ち・内部グループ配布 | Apple の処理（最大40分）を待ち、内部グループへ割り当て、利用可能になるまで確認。最後に印を付ける | 処理失敗・輸出コンプライアンス・グループ未設定など。**印は付かない** |

- **古い sha を手動 dispatch すると、印（タグ `ios-testflight/<番号>`）が新しい番号のまま古いコミットを指す。**
  判定は最新の印を基準にするため、以後の判定が古い基準になる（多めに配るだけで取りこぼしはない）。通常の運用では起きない
- **Web と iOS は別の run。** Web が成功して iOS だけが失敗することがある（Signaly にも別通知が出る）。
  iOS の失敗を Web の成功として隠さない
- **版番号:** 表示バージョン（`MARKETING_VERSION`）は `frontend/package.json` と同期済み（#535）。
  ビルド番号は `run_number * 100 + run_attempt`（Actions が発行する値なので重複しない・Re-run all jobs でも新しい番号）。
  リポジトリ内の `CURRENT_PROJECT_VERSION`（1）は変えず、`xcodebuild` の引数で上書きする
- **取りこぼさない:** 印は配布し終えたときだけ進む。失敗した配布の変更も、複数リリースをまたいでも、
  次の判定が「配布済みとの差分」で見るので拾われる（リリースごとの差分ではない）
- **判定だけ確かめる:** Actions → iOS TestFlight → Run workflow で `dry_run` にチェック。手元なら
  `node ios/scripts/ios-changes.mjs`

### 失敗したとき・やり直すとき

1. run のサマリーとログで、どの段階かを確かめる（原因は `::error::` に出る）
2. 原因（下表）を直したら、**同じ run の「Re-run failed jobs」**、または Run workflow で**同じ `sha`** を指定して再実行する。
   アップロード済みのビルド番号は二重に上げない（`build-exists` で確認）。印が進んでいないので、何度やり直しても安全
3. Apple の処理が40分を超えたときは終了コード2（待ちきれず）。しばらく待って Re-run failed jobs で続きから確かめられる

| 症状 | 原因と対処 |
|---|---|
| `ASC_KEY_ID が未登録です` | 下の初期設定をしていない |
| `App Store Connect APIの認証に失敗しました（HTTP 401/403）` | **キーの失効**（下記）または権限不足（「App管理」以上） |
| `Communication with Apple failed` / プロファイル作成失敗 | 同じキー・チームで App ID・App Group（Widget）が作れない。初回は Xcode で一度 Archive して App ID・App Group・配布用証明書を作っておく |
| `内部グループを1つに決められません` | 内部グループが複数。repository variable `TESTFLIGHT_GROUP` に名前を入れる |
| `MISSING_EXPORT_COMPLIANCE` | `ITSAppUsesNonExemptEncryption`（下の「暗号化非該当フラグ」）を確認 |
| `MARKETING_VERSION がずれています` | `node ios/scripts/sync-version.mjs` を実行して develop へ反映 |

### 初期設定（初回だけ・本人の操作）

1. App Store Connect → ユーザとアクセス → 統合 → **チームキー**で、アクセス権「App管理」のAPIキーを発行する
   （`.p8` は**一度しかダウンロードできない**）。Key ID と Issuer ID を控える
2. 1Password の `apps/MyRoom` に `asc-key-id`・`asc-issuer-id`・`asc-key-p8`（`.p8` の中身を **base64 の1行**にした値。
   改行を含む値は入れない）を登録し、`sync-secrets.yml` で GitHub の repository secret へ同期する
   （`.github/secrets-manifest.tsv` の `ASC_*`）。リポジトリには一切置かない。実行環境はランナーの一時領域で、ジョブの最後に削除する
3. App Store Connect で kurashio の App と、自分だけの**内部テストグループ**を作る（`#548` で作成済み）。
   グループが複数あるときだけ repository variable `TESTFLIGHT_GROUP` に名前を入れる
4. 動作確認: 上の `dry_run` → 手動 dispatch（`dry_run` を外す）。**subpc に Xcode は無いので、署名・ビルドは
   最初の実 run で初めて確かめられる**（このワークフローは Mac 側での実機確認前提）

**CI の Xcode は Mac mini と同じ 27 系にそろえる**（#606）。`project.pbxproj` は Xcode 27 で保存すると
`objectVersion = 110` になり、`macos-26` の既定（Xcode 26.6）は「新しすぎるプロジェクト形式」で開けず
終了コード74で落ちる。そのため build ジョブは `runs-on: xcode-27`（プレビュー。既定 Xcode 27.0）で動かし、
前提の確認で Xcode 27 未満なら明示的に落とす。Xcode 27 が GA して `macos-27` 等に移るときは `runs-on` を直す。

### キーの失効・期限切れ

APIキーは自動では期限切れにならないが、App Store Connect で**取り消す・権限を下げると 401/403** になる。
その場合は上の1〜2をやり直す（新しいキーを発行して1Passwordの値を差し替え、同期）。通知先は Signaly
（CI・デプロイと同じチャンネル。種別「iOS配布（TestFlight）」）。**チームのライセンス更新（年1回）**が切れると署名自体が
できなくなるので、Apple Developer Program の更新も本人の操作。

### 対象外・既知の制約

- TestFlight 版は `aps-environment` が production になるが、バックエンドが端末トークンごとに APNs の
  送信先を振り分ける（#593。下の「署名は Apple Developer Program が前提」）ため、プッシュ通知も届く
- App Store 一般公開・外部テスターへの配布はしない。IssueDeck のリリース画面への表示は issue-deck 側の
  別 Issue（この run のサマリー・タグ `ios-testflight/*`・Actions の結果が連携元）

## iPad 対応（#642）

アプリ本体は iPhone・iPad の両対応（`TARGETED_DEVICE_FAMILY = "1,2"`）。iPad 専用のレイアウトは Web 側
（幅768px以上で多列）が担う。**注意点**:

- **iPad の向きは4方向すべて宣言する。** `UIRequiresFullScreen` を付けない iPad 対応アプリは足りないと
  App Store Connect が ITMS-90474 でアップロードを断る（`check-consistency.mjs` が照合する）
- **ウィンドウは1つに限る。** 通知のタップ・端末トークンの受け先（`appDelegate.webViewModel`）が1つしか
  持てないため。`INFOPLIST_KEY_UIApplicationSupportsMultipleScenes` という設定キーは無いので、
  `ios/Kurashio/Info.plist` に `UIApplicationSupportsMultipleScenes = false` を書き、
  `INFOPLIST_KEY_UIApplicationSceneManifest_Generation = NO` にしている。複数ウィンドウに対応するなら
  受け先の持ち方を変える別作業になる
- 確認（Mac mini）: ビルドした `.app` の `plutil -p Info.plist` で `UIApplicationSupportsMultipleScenes` が
  `false` であること、iPad 実機で「新規ウィンドウ」が出ないこと

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

### ビルドとインストール（手で行う場合）

**普段は上の「入れ直し（1コマンド）」でよい。** 以下は Xcode で直接確かめたいとき（デバッグなど）の手順。

```bash
cd ~/apps/myroom        # Mac mini 上のチェックアウト
git pull
open ios/Kurashio.xcodeproj
```

1. 上部のスキームが `Kurashio`、実行先が自分の iPhone になっていることを確かめる
2. ⌘R（Product → Run）。初回は Signing & Capabilities の Team が Apple Developer Program のチーム
   （Personal Team ではない方）になっているかを確かめる
3. 初回だけ、iPhone の 設定 → 一般 → VPNとデバイス管理 で自分の開発者証明書を「信頼」する

**Apple Developer Program で署名した開発ビルドは約1年で起動できなくなります**（無料の個人チームなら7日）。
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

### 暗号化非該当フラグ（#571）

**本体アプリは `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO`（Debug/Release 両方）を持つ。**
`Info.plist` の `ITSAppUsesNonExemptEncryption = false` と同じで、TestFlight にビルドを上げるたびに
出る輸出規制（暗号化）の質問が出なくなる。本体は `GENERATE_INFOPLIST_FILE = YES` なので
Info.plist ファイルは作らず、ビルド設定から生成している。

- 前提は「OS標準の暗号化（WKWebView の HTTPS など）だけを使い、独自の暗号を実装していない」こと。
  独自の暗号処理を入れたら見直す
- ウィジェット拡張には付けていない（質問はアプリ本体のバンドルに対するもの）
- Xcode が無い環境で足したため未確認。Mac mini でアーカイブしたあと、生成された Info.plist に
  `ITSAppUsesNonExemptEncryption` が `false` で入っていることを確かめる

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
3. Xcode → Signing & Capabilities で Push Notifications が表示されていることを確かめる
   （`Kurashio.entitlements` に `aps-environment` を含めてあるので、capability を足し直す必要はない）
4. サーバー側の値（`APNS_AUTH_KEY`・`APNS_KEY_ID`・`APNS_TEAM_ID`・`APNS_BUNDLE_ID`・
   `APNS_ENVIRONMENT`）の登録手順はリポジトリルートの`README.md`「本番環境へのデプロイ」を参照

#### 署名は Apple Developer Program が前提（#560）

**無料の個人チーム（Personal Team）は Push Notifications capability に対応していない。**
`aps-environment` を含む entitlements を個人チームで署名しようとすると「Personal development teams ...
do not support the Push Notifications capability」となり、プロビジョニングプロファイルを作れずビルドが止まる。
このアプリはプッシュ通知（#527）を使うため、**署名は有料の Apple Developer Program のチームで行う**
（`Kurashio.entitlements` から `aps-environment` を外して個人チームへ戻す形は採っていない）。
`project.pbxproj` の `DEVELOPMENT_TEAM` と、サーバー側の `APNS_TEAM_ID` はこのチームの Team ID に揃える。

Xcode の開発ビルドは `aps-environment` が `development`（APNsは sandbox）、TestFlight 配布版は
`production` になる。**バックエンドは端末トークンごとに送信先を振り分ける**（#593）:
`BadDeviceToken` が返ったら反対側の環境で再送し、通ったほうを `data/apns_tokens.json` に記録して次回から
そちらへ送る。両方で `BadDeviceToken` のときだけトークンを削除する。`APNS_ENVIRONMENT` は環境が未判定の
トークンを最初に試す側でしかない（初回だけ送信が2回になることがある）。

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

室温・ゴミの日・今日の電気量を表示する、iOS標準のホーム画面ウィジェット（Small/Medium/Large）。
**Largeには電気の操作ボタンも並ぶ**（#546。下の「電気の操作ボタン」の節）。

**ごみの日だけを出す別ウィジェット（`GarbageWidget`・kind `KurashioGarbageWidget`・Small/Medium・#647）**
も同じバンドルに入っている。スナップショットの `garbageUpcoming`（今日以降の収集日・最大5件）と
`garbageCollectionTime` から描く。**日数は保存せず端末の日付（JST）で数え**、0時と各収集日の収集時刻に
タイムラインのエントリを積むので、ダッシュボードを開かない日も表示が進む。アプリ側の再読み込みは
`reloadAllTimelines()` なので、ウィジェットを増やしても `WebViewModel.swift` を直す必要はない。

### 「今日の電気」ウィジェット（`KurashioEnergyWidget`・#648）

上とは別のウィジェット（kind は `KurashioEnergyWidget`・Smallのみ・設定なし）。今日のkWh・電気代・
昨日との比較（バーと差）・今月の累計を出す。実装は `EnergyWidget.swift`、Web側の値の組み立ては
`frontend/lib/widget-energy.ts`。

- **昨日の値は `daily` から KEPCO差分の「その他」を引いて出す。** `daily` にだけ「その他」が足し込まれ、
  今日・今月は機器の実測だけなので、そのまま比べると基準がずれる
- **`energyDate`（JSTの基準日）が端末の今日と違えば「ダッシュボードを開いて更新してください」を出す。**
  更新はダッシュボードを開いたときだけなので、0時を過ぎると前日の値を「今日」と出してしまうため。
  翌0時のエントリをタイムラインに積んで切り替える
- **再読み込みは `reloadAllTimelines()`。** kind を1つだけ指定すると、もう一方のウィジェットが更新されない
- スナップショットに項目を足したら `SharedWidgetSnapshot.save()` の項目ごとの読み替えにも足す
  （足さないと値が届いても常に nil になる）

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

### 室温・湿度を出すセンサーはウィジェット側で選ぶ（#560）

ホーム画面のウィジェットを長押し →「ウィジェットを編集」→「センサー」で選ぶ（`SensorSelection.swift` の
`SelectSensorIntent`）。選択肢は**ダッシュボードで表示中のセンサーのカード**で、Web側
（`frontend/lib/widget-sensors.ts` の `buildWidgetSensors()`）がスナップショットの `sensors` に並び順どおり入れて
送っている。ネットワークからは取らないので、アプリでダッシュボードを一度も開いていなければ候補は空。

- **選ばないとき（自動）は、並び順で最初の受信中のセンサー**（`pickDefaultWidgetSensor()`）。以前はデバイスID 1 に
  固定しており、ID 1 のセンサーを止めて非表示にすると、ダッシュボードがそのIDを取得しないため室温が「—」になった
- 選んだセンサーをダッシュボードで非表示にすると一覧から消え、表示は自動へ倒れる（選んだ設定そのものは残る）
- 受信が止まっているセンサーは値に「受信が止まっています」を添える
- **Smallは CO2 も出し、「2つ目のセンサー」を選ぶと2台を上下2段で並べる**（#569）。2つ目が未選択・一覧から
  消えた・1つ目と同じときは1台表示へ倒す（2つ目は `reading()` の既定フォールバックを使わず
  `secondReading()` で探す。使うと消えたセンサーの段に既定の値が出て同じ値が2段並ぶ）
- **Medium は最大4台を並べる**（#614）。「2〜4つ目のセンサー」を選んだ順に、1台は大きく・2台は左右・
  3〜4台は2×2で出す。3つ目・4つ目は Medium だけで使い、Small・Large では無視する。未選択・一覧から消えた・
  すでに出しているセンサーと同じものは詰めて落とす（`KurashioEntry.mediumReadings`。同じ値が並ばないため）。
  Web側・`SharedWidgetSnapshot.swift` は変えていない（`sensors` にすでに全センサーが入っている）
- **CO2の段階（緑・黄・赤）の判定はWeb側の `getCo2Level()` だけが持つ。** `WidgetSensor.co2Level` で届いた
  段階にSwiftが色を当てるだけで、ppmのしきい値はSwiftに書かない
- **保存するときに項目ごとに型を整える**（`SharedWidgetSnapshot.save()`）。WKWebView から届いた辞書をそのまま
  JSONにして読む側で `JSONDecoder` に通すと、整数の項目が小数で書き出されただけで全体が読めず、
  「アプリでダッシュボードを開いてください」のままになる
- 受け取ったアプリはそのたびにWidgetの再読み込みを求める（1日あたりの上限あり）ため、Web側
  （`NativeWidgetSnapshotSync`）は中身が前回と同じなら送らない

**`SharedWidgetSnapshot.swift` はメインApp・Widget Extensionの両方のフォルダに同じ内容を置いている。**
Xcode16のファイルシステム同期グループ（`PBXFileSystemSynchronizedRootGroup`）は1ファイルが
1つのtargetにしか属せないため、共有コードを物理的に複製する形にした。変更するときは
`ios/Kurashio/SharedWidgetSnapshot.swift` と `ios/KurashioWidget/SharedWidgetSnapshot.swift` の
両方を揃えること。

### 電気の操作ボタン（Large・#546）

**ウィジェットは送信しない。認証を持たないので、アプリ（WKWebView）のログイン済みセッションで送る。**
JWT・固定トークンをウィジェットへ渡す案は採っていない（別プロセスの refresh token 更新がログアウトを起こす・#537。
専用トークンはバックエンドの「書き込みを2種類に絞る」方針とも衝突する）。代わりに、押すたびにアプリが前面に出る。

1. Largeに、ダッシュボードで表示中のボタン（先頭4件）を「グループ名 ボタン名」で並べる（`remoteButtons`。
   Web側 `lib/widget-remote-buttons.ts`）。`Button(intent: PressRemoteButtonIntent(...))`
2. `PressRemoteButtonIntent`（`openAppWhenRun`）が押下（キー・ボタンID・時刻）を `WidgetPressStore` の
   `pending` へ書き、アプリを前面に出す
3. Web の `NativeWidgetPressReceiver`（ルートレイアウト）が、`widgetReady` でアプリから保留を取り、
   `sendRemoteButton()` で送る。**どの画面でも受ける**（遷移させると未保存の入力が消えるため）
4. 結果はアプリ内のトーストと、`widgetPressResult` の ack 経由でウィジェットのボタン（約30秒）に出す

- **保留の中身をアプリから Web へ押し込まない。** 起動済みのときの合図（`myroom-native-widget-press-available`）は
  中身が無く、Web が `widgetReady` で取りにいく（復帰時の自動リロードと競合して、取りこぼす・二重に送るため）
- **最大1回だけ送る。** Web は送る前に押下キーを localStorage へ記録し（`lib/widget-press.ts`）、記録済みは
  再送しない（結果は「不明」）。アプリは ack が届くまで保留を消さない。**60秒を過ぎた保留は捨てる**
- `pending`・`last` は `Snapshot` と**別のキー**。`save()` が `Snapshot` を丸ごと書き直すので、同居させると
  次の同期で消える
- **`PressButtonIntent.swift` も両フォルダに同じ内容を置く**（`openAppWhenRun` の `perform()` はアプリの
  プロセスで動くため、アプリ側でもコンパイルが要る）。変更は両方揃える
- Swift は subpc でビルドできない。Mac mini と実機で、コールドスタート・起動済み・未ログイン・機内モードを確かめること

### 電気・エアコンの操作ウィジェット（Small・Medium・#649）

`kurashio` ウィジェットとは別に、操作専用の2つ（`KurashioRemoteWidget`・`KurashioAirconWidget`）を
ウィジェットギャラリーから置ける。設定項目は持たず、プロバイダは `ControlTimelineProvider` を共有する。

- **電気の操作**: Smallは先頭2件、Mediumは先頭6件（ダッシュボードで表示中のボタン）。押下は #546 と同じ
  `PressRemoteButtonIntent`
- **エアコンの操作**: Small・Mediumとも**ダッシュボードで表示中の1台**（Mediumは左に状態・右にボタン）。電源の「オン」「オフ」と設定温度の「−」「＋」（0.5℃）。
  `PressAirconIntent`（`acId` と `action` = `power_on` / `power_off` / `temp_up` / `temp_down`）
- 送り方は電気の操作と同じ（ウィジェットは認証を持たず、アプリが前面に出て Web のセッションが
  `POST /api/aircon/units/{ac_id}/control` を送る）。押下の保留（`WidgetPressStore.Pending`）に
  `acId`・`action` を足しただけで、保留の受け渡し・最大1回・60秒の期限は共通
- **温度の＋−は、押した時点で `GET /api/aircon/units/{ac_id}/state` を読み直して計算する。** ウィジェットの
  表示値はダッシュボードを開いたときのもので古いことがあるため、表示値からの差分は送らない
- **電源は状態に頼らず「オン」「オフ」の2ボタン**にしている（表示が古いと入切が逆になるため）
- スナップショットの `aircons` は、操作できる構成（白くまくんの設定済み・オンライン）のときだけ入り、
  **ダッシュボードが状態を持つ表示中の1台だけ**（2台目のために取得を増やさない）。操作できないときは
  「操作できるエアコンがありません」を出す
- **自動運転の設定温度は温度ではなくシフト量。** ウィジェットは `mode` が AUTO のとき「自動 +1.0」と出し、
  ＋−は Web 側の `stepAirconTemperature()`（AUTOは±5.0の範囲）で計算する
- Webの反映は `frontend/lib/widget-aircon.ts`（スナップショットの組み立て・操作の型）と
  `components/native-widget-press-receiver.tsx`（送信）。`WebViewModel` は結果の ack ですべてのウィジェットを再読み込みする
- Swift は subpc でビルドできない。Mac mini・実機で、ウィジェットギャラリーに2つが並ぶこと、
  押下でアプリが開いてトーストが出ること、結果の印が約30秒出ることを確かめる

### App Group の登録が必要（初回だけ）

**Widgetが動くには、Apple Developer PortalでのApp Group（`group.com.gucchii.kurashio`）登録と、
Xcodeでの両target（`Kurashio`・`KurashioWidgetExtension`）へのApp Groups Capability追加が要る。**
`entitlements` ファイル自体はリポジトリに含めたが、Developer Portal側の登録はコードだけでは
完結しない。手順は起票済みの手作業Issueを参照。

### ウィジェットの Info.plist（#560）

**`NSExtension` 辞書は `KurashioWidget/Info.plist` に直接書いている。** ターゲットは
`GENERATE_INFOPLIST_FILE = YES` のままで、生成分（表示名など）と `INFOPLIST_FILE` の中身が合成される。
`INFOPLIST_KEY_NSExtensionPointIdentifier` は `INFOPLIST_KEY_` で生成できるキーではなく**黙って無視される**ため、
それだけだとインストール時に `AppexBundleMissingNSExtensionDict` で失敗する。

`KurashioWidget/` はファイルシステム同期グループなので、置いた `Info.plist` がそのままだと
Copy Bundle Resources に入り `Multiple commands produce ... Info.plist` になる。`project.pbxproj` の
`PBXFileSystemSynchronizedBuildFileExceptionSet` で `Info.plist` をターゲットのメンバーから外している
（Xcode の File Inspector で Target Membership のチェックが外れて見えるのが正しい状態）。

### project.pbxproj はXcodeでの確認が前提

**`KurashioWidgetExtension` ターゲットは、Xcodeを使わずテキスト編集で `project.pbxproj` へ
直接追加した。** 新規target・依存関係・Embed Foundation Extensionsのビルドフェーズを、
相互参照するID（24桁hex）を手作業で生成して組んでいる。括弧の対応・ID参照の整合性は
スクリプトで機械的に確認したが、**Xcodeでの実際のビルドは未確認。** Mac miniで開いて
初回ビルドがうまくいかない場合、Xcodeが提案する自動修正（署名・Capabilities周り）を
受け入れて直してよい。
