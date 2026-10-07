# myroom 固有ルール

このリポジトリで作業する Claude Code エージェント向けのルールを記載する。

**GitHub Actions 上での実行は、このリポジトリをチェックアウトしたワークツリーしか参照できない。**
したがって無人実行でも守られる必要があるルールは、このファイルに明文化しておく必要がある。

## このリポジトリの作り

**Python バックエンド + Node フロントエンドの2層構成。** どこでコマンドを打つかが層ごとに違う。

| 層 | 場所 | 依存 |
|---|---|---|
| バックエンド | **リポジトリルート** | `requirements.txt` / `requirements-dev.txt`（pip） |
| フロントエンド | **`frontend/`** | `frontend/package.json` / `frontend/package-lock.json`（npm） |

**ルートの `package.json` はバージョン管理用のscriptだけで、依存を持たない。**
`package-lock.json` も空のスタブ（`"packages": {}`）。**ここで `npm ci` しても何も入らない。**

### 検証コマンド

**`cd frontend` を忘れるとフロントエンドのコマンドは動かない。**

| 目的 | コマンド | 実行場所 |
|---|---|---|
| バックエンドのテスト | `pytest tests/ -q`（環境変数 `DB_MOCK=true`） | ルート |
| バックエンドの依存 | `pip install -r requirements-dev.txt` | ルート |
| フロントエンドの型チェック | `npm run typecheck` | **`frontend/`** |
| フロントエンドのテスト | `npm run test`（vitest） | **`frontend/`** |
| フロントエンドのビルド | `npm run build` | **`frontend/`** |
| フロントエンドのLint | `npm run lint` | **`frontend/`** |
| フロントエンドの依存 | `npm ci` | **`frontend/`** |

**リポジトリ直下の `venv/` は触らないこと。** `.gitignore` に `venv/` と書かれているが、
**このディレクトリは既に Git 管理下にある**（6,400ファイル超）。`.gitignore` は追跡済みの
ファイルには効かないため、作り直すと数千ファイルの差分がコミット候補に並ぶ。しかも中身の
`python3` は存在しない `~/.pyenv/versions/3.9.4` を指す壊れた symlink で、**素の worktree では
そのまま実行できない。** バックエンドのテストを回すときは、リポジトリの外
（セッションのスクラッチパッドなど）に別の venv を作って
`pip install -r requirements-dev.txt` してから `pytest` を実行する。

**新しく作った worktree では、まず `cd frontend && npm ci` から始めること。**
issue-deck のランチャーが「依存インストール済み」と伝えてくる場合でも、それが見ているのは
リポジトリルートで、ルートには実質の依存が無い（`package-lock.json` は空のスタブ）。
`frontend/node_modules` は空のままなので、`npm run test` は
`Cannot find module 'vitest/config'` で落ちる。**なお、ルートで `npm install` 系を実行すると
空のスタブだった `package-lock.json` に `packages` が書き足されて差分が出る。**
コミットに含めないこと。

**バックエンドを触るなら、Python環境も自分で作ること。** サブPCには `pytest` も `pip` も
素では入っていない（`python3 -m pip` すら無い）。**リポジトリルートに `venv/` があっても信用しない。**
`.gitignore` 済みで中身は各ホストの残骸であり、実際に存在しない pyenv（`/home/guchi/.pyenv/versions/3.9.4`）を
指したまま壊れていることがある。`venv/bin/python` はシンボリックリンクとして見えるのに
`No such file or directory` で落ちる。作り直すなら worktree の外（スクラッチ領域）に置く。

```bash
python3 -m venv /tmp/<任意>/pyenv
/tmp/<任意>/pyenv/bin/pip install -r requirements-dev.txt
DB_MOCK=true /tmp/<任意>/pyenv/bin/python -m pytest tests/ -q
```

CI（`.github/workflows/ci.yml`）は `backend`（Python 3.11）と `frontend`（Node 20）の
2ジョブに分かれている。**触った層のコマンドだけ実行すればよい。**

**`npm run lint` は CI で実行していない。** frontend ジョブが回すのは typecheck / test / build の3つだけ。
手元で lint を実行すると `react-hooks/refs`・「effect内の同期setState」のエラーが既存ファイル
（`use-chart-history.ts`・`device-detail-panel.tsx`・`outdoor-detail-panel.tsx` など）で十数件出るが、
**これは develop 時点からある。** 自分の変更が原因とは限らないので、件数を増やしていないかだけ見ればよい。

**アイコンをデータに応じて動的に選ぶ実装は`react-hooks/refs`系の`error`（"Cannot create components
during render"）を新たに踏みやすい。** `const Icon = pickIcon(...)`のように選んだコンポーネントを
変数へ入れてから`<Icon .../>`とJSXタグにする書き方は、"レンダー中にコンポーネントを生成している"と
静的解析され`error`になる（#308の天気アイコン選択で発生）。**`switch`で各アイコンを`<Sun .../>`の
ように直接JSXとして返す形にすれば起きない**（変数を経由しないため）。同じ理由で、この変換元の
関数（`pickIcon`自体）はコンポーネントではなく素の値を返す関数として残し、JSXを返す側だけ分ける
とよい（`frontend/lib/weather-icon.tsx`の`getWeatherIcon()`と`WeatherIcon`の分け方）。

`npm run dev` は `frontend/` で `next dev --port 5173`。**worktree ごとのポートは
envファイルに入っていない。** 別ポートで立てるなら
`cd frontend && npx next dev --port <ポート>` のようにその場で渡す
（ルートには `dev` script が無く、`npm run dev` は `Missing script: "dev"` で落ちる）。

**テストで `disabled` を確かめるときは `disabled=""` で照合する。** フロントのテストは
`renderToStaticMarkup` の文字列を見ているが、Tailwind の `disabled:opacity-30` のような
バリアントが `class` に入るため、`toContain("disabled")` は押せるボタンにも通ってしまう
（#269）。

**`npm run build` は `frontend/public/sw.js` を書き換える。** postbuild の
`scripts/sync-sw-cache.mjs` が `CACHE_NAME` を `package.json` の version に合わせるため、
検証目的でビルドしただけでも差分が出る。**リリース作業以外では、この差分をコミットに含めないこと。**

## アプリの自動更新（`version.json`）

**動いているアプリが新しいビルドに気付くための正は `out/version.json`。** 同じ postbuild の
`scripts/sync-sw-cache.mjs` が `frontend/package.json` の version を書き出し、
`components/app-update-checker.tsx` が10分ごとと画面復帰時に `cache: "no-store"` で読む（#277）。
バックグラウンドから戻ったときは読み込み画面を出してそのままリロードし、開きっぱなしのときは
バナーを出して押されるのを待つ。

- **`/version.json` を Service Worker のキャッシュ対象に入れないこと。** `public/sw.js` の
  `fetch` ハンドラで `/api/` と同じように素通しさせている。一度でもキャッシュに載ると古い値を
  返し続け、**アプリは永久に更新へ気付けない**（症状は「ビルドしてデプロイしたのに画面が変わらない」）
- **`public/version.json` は作らないこと。** バージョンごとの差分がリポジトリに出るうえ、
  開発サーバーでは常に自分と同じ値が返るので意味が無い。書き出すのは `out/` だけでよい
- **配信漏れは404にならない。** `backend/main.py` の `serve_frontend` は見つからないパスに
  `index.html` を200で返すため、`version.json` が無いと「HTMLが返り `res.json()` が失敗し、
  握り潰されて自動更新が黙って止まる」。そのため `sync-sw-cache.mjs` は `out/` があるのに
  書けなければ**落とし**、取得側は `content-type` がJSONかを確かめて `console.warn` を出す
- **未保存の編集を抱える画面では、復帰時の自動リロードを止める。** このアプリの設定シートは
  閉じるまで保存しないので、`lib/unsaved-edits.ts` の `useUnsavedEdits()` を呼んで印を立てる
  （掃除の設定・電気の操作の設定・`/devices`）。**新しく「保存ボタンを押すまで書かない」画面を
  足したら、そこでも呼ぶこと。** 忘れると、編集中に別アプリへ行って戻っただけで入力が消える
- 静的書き出しなのでバックエンドに `/api/app-version` のようなエンドポイントは要らない

### デプロイ直後の「Application error」（#450）

**rsync は同じ階層のファイルをサブディレクトリの中身より先に送る。** 1回の rsync で送ると
`out/index.html`・`out/version.json` が `out/_next/` のチャンクより先に届き、その数秒に開くと
（更新検知の自動リロードも含む）まだ無いチャンクが404になって、描画中に `Failed to load chunk ...`
が投げられる。`app/global-error.tsx` が無かったため、Next.js 既定の英語の白い画面が出ていた。

- `deploy.yml` は **`frontend/out/_next/` を先に送ってから全体を送る。** 1回にまとめ直さないこと。
  rsync に `--delete` は付けていないので、古いチャンクは残り、開きっぱなしの古い画面も壊れない
- `app/global-error.tsx` はチャンクの失敗なら1回だけ自動で読み込み直す（`lib/chunk-reload.ts`。
  60秒以内の2回目は読み込み直さず、再読み込みボタンを出す）。それ以外の例外もボタンの画面に倒す
- Service Worker の画面遷移の控えは**成功した応答だけ・URLごと**に残す（以前は再起動中の 502/503 も
  `/` へ上書きしていた）

## 認証状態と起動時の画面

**`output: "export"` の静的書き出しなので、クライアントコンポーネントの `useState` 初期値は
そのまま `out/index.html` に焼き込まれる。** `lib/use-auth.ts` の `isAuthenticated` を
`false`（未ログイン）で始めると、書き出されたHTMLにログイン画面が入り、`getSession()` が
解決するまでの数百msだけログイン済みのユーザーにもログイン画面が見える（#250）。
**判定中は `null` にして、`resolveAuthGate()` で読み込み画面に倒すこと。**

確認は `npm run build` 後に `grep -o "Googleでログイン" out/index.html` が空になることで足りる
（開発サーバーの `curl http://localhost:13250/` でも同じHTMLが返る）。

**ログアウト・401時のセッション破棄は `lib/auth.ts` の `signOutThisApp()` を通す**（#426）。
Supabase は共有プロジェクトで、`signOut()` を引数なしで呼ぶと既定 scope の `global` になり、
**同じユーザーの他アプリ・他端末の refresh token まで失効する**（このアプリでログアウトしただけで
他アプリがログイン画面へ戻る）。`signOutThisApp()` は `{ scope: "local" }` を渡してこのアプリの
セッションだけを破棄する。`supabase.auth.signOut` を直接呼ばないこと（`lib/auth.test.ts` が
ソースを走査して、`lib/auth.ts` 以外の呼び出しを落とす）。アカウント削除の操作は無いので、
全セッションを終了する経路は持っていない。

起動直後の画面（読み込み中・ログイン）は `components/app-entry-screen.tsx` の
`AppEntryScreen` にアイコン・アプリ名・説明文の配置を固定し、下段のブロックだけを差し替える。
片方だけ余白を変えると、切り替わった瞬間に要素が飛び跳ねる。

## ログインの判定（共有Supabase・`backend/auth.py`）

**Supabase は他アプリと共有のプロジェクト**で、同じアカウントに GitHub（IssueDeck）・Google などの
複数のプロバイダーが紐付く。#616 の「許可リストのメールを名乗るだけでは通さない」を保ったまま、
次の判定で通している（#724）。

- **`app_metadata.provider` を根拠にしない。** 最初にアカウントを作ったときのプロバイダーのまま
  変わらないため、GitHub で先に作られたアカウントが Google でログインしても `github` になり、
  正当なログインが403になった（#724 の "not a verified Google login"）。**`user_metadata` も見ない**
  （利用者が `updateUser()` で書き換えられる）
- **根拠は Auth サーバー（`GET /auth/v1/user`）が返す identities。** トークンのメールと一致し、
  `identity_data.email_verified` が `true` の Google の identity があること、かつトークンの `amr` に
  `oauth` があることを求める。Supabase のアクセストークンには「このセッションをどのプロバイダーで
  作ったか」が載らないので、同じアカウントの GitHub のセッションとは区別できない（確認済みメールで
  同じアカウントに結び付いたものに限られる）。応答はトークンのハッシュごとに5分だけ覚える
- **kid の無い JWT を HS256 と決めつけない。トークン自身の `alg` で検証方法を選ばない。** kid が
  あれば JWKS（ES256/RS256）で手元検証し、無ければ Auth サーバーに判定させてから iss・aud・exp・sub を
  突き合わせる。手元に HS256 の鍵（旧JWTシークレット）は置かない。2026-10 時点で共有プロジェクトの
  JWKS は ES256 の1本だが、Auth サーバーは HS256 の署名もまだ検証している（`bad_jwt` の文言で確認）
- **Auth サーバーの 4xx（429 を除く）は「このトークンは通らない」＝401、5xx・429・通信不達は503。**
  不正なトークンには 401 ではなく **403（`bad_jwt`）** が返る。503 はアカウントのせいにしない
- **ログに JWT・メールを出さない。** 拒否時は `alg`・kid の有無・発行元が一致するか・`role`
  （`anon` なら APIキーを Bearer に載せている）・期限切れかと、identities のプロバイダー一覧だけを
  残す（`_describe_unverified()`）。メールは `_mask_email()` で伏せる
- フロントは **401・403 のどちらでも** このアプリのセッションだけ破棄してログイン画面へ戻す
  （`lib/api.ts`。403 を返すのは認証だけ）。`/auth/callback` の判定は `lib/auth-callback.ts` で、
  通信が例外になっても「ログインしています」のまま止めない

### 許可はStatusHubの判定API（#718）

**誰が通れるかの正本は StatusHub の共通アクセス設定。** `backend/access.py` が `POST /api/access/v1/decision` を
引く（アプリID `myroom`・トークンは issue-deck の共有トークン `MYROOM_ACCESS_APP_TOKEN`）。`auth.get_current_user` は
Supabaseのトークン・Googleのidentity確認のあとに、**確認済みの `sub`・メール・`emailVerified: true` だけ**を送る。

- **`ALLOWED_GOOGLE_EMAILS` を判定にもフォールバックにも使わない。** 判定APIが使えないときに旧リストで通すと、
  StatusHubで取り消した利用者が通る。トークンが無い・一度も判定できていない場合は全員拒否になる
- 結果は `ttlSeconds`（30秒）だけ使い回し、取得失敗時は直前の判定を `maxStaleSeconds`（5分）まで使う。超えたら拒否
- `lifespan` のハートビート（4分ごと）が適用中の版を申告し、管理画面で「反映済み」になる。DB_MOCK では回さない
- 旧設定（`deploy.yml`・`secrets-manifest.tsv`・1Passwordの `allowed-google-emails`）は、本番の移行検証と復旧確認の後に整理する

## iOSアプリ（`ios/`）とのつなぎ目

**`ios/` は Web版を WKWebView で開くだけの殻**（#526）。ビルド手順・Web版との更新対象の違いは
`ios/README.md`。subpc には Xcode が無いので、Swift の変更はビルドを確かめられないまま渡る
（Mac mini と実機で確認する）。
**iOS に関わる変更をしたときの判別・入れ直しの手順は `ios/README.md` の「iOS に関わる変更をしたときの手順」が正**（#568）。
要点だけ: 入れ直しが要るのは `ios/` の実質的な変更のみ（`frontend/`・`backend/` は何もしなくてよい）、入れ直しは
**Web側が main へデプロイされた後に `main` から**、`ios/scripts/remote-install.sh`（subpc から）で1コマンド。
CI の `frontend` ジョブが `ios/scripts/check-consistency.mjs` を毎回実行し、共有 Swift（`SharedWidgetSnapshot.swift` の2か所・`WatchSnapshot.swift` の3か所）・
`MARKETING_VERSION`・ログイン戻り先スキーム・ブリッジ名・pbxproj のIDのずれを止める。**照合する値を増やすときはこのスクリプトへ足す**。
develop→main のPRには `.github/workflows/ios-rebuild-notice.yml` が「入れ直しが必要」を自動でコメントする（`MARKETING_VERSION` の行だけの差分は除外）。

**TestFlight への配布は `ios-testflight.yml` が自動で行う**（#591）。`Deploy to Production` 成功後に
`ios-testflight-trigger.yml`（`workflow_run`＝develop 版YAMLで動くので薄い起動役だけ）が本体を
**`workflow_dispatch`（main 版）で起動**する。判定・配布・失敗時の再実行・初期設定は `ios/README.md`
「TestFlight への自動配布」が正。要点だけ: 判定は `ios/scripts/ios-changes.mjs`（配布物は
`ios/Kurashio/`・`ios/KurashioWidget/`・`ios/KurashioWatch/`・`ios/KurashioWatchWidget/`・`ios/Kurashio.xcodeproj/` のみ。README・`ios/scripts/`・版番号の行は除く）で、
`ios-rebuild-notice.yml` も同じ関数を呼ぶ（**判定を2か所に書かない**）。**印（タグ `ios-testflight/<番号>`）は
内部グループへの配布が済んだあとにだけ付ける。** 途中で失敗しても印が進まないので変更を取りこぼさない。
IPA は公開リポジトリの artifact に載せない（署名・アップロードは同じジョブ）。TestFlight 版は
`aps-environment=production` だが、バックエンドが端末トークンごとに APNs の送信先を振り分けるので通知も届く（#593）。

**起動直後は端末に残した前回のデータを先に出し、裏で取り直す**（#735）。スナップショット
（`lib/offline-cache.ts`）は表示設定・暮らしのカードも持ち、`applyDashboardSnapshot(snapshot, "preview")` で
ログイン判定のあとに適用する（**判定中の読み込み画面・ログイン画面は置き換えない**・#250）。前回のデータを
出している間（`showingCachedData`）は、エアコンの操作・ウィジェットへの同期・スナップショットの保存し直しを
止める。**3Dプリンターの状態はスナップショットに入れない**（進捗が古いと終わった印刷を印刷中と見せる）。
ログアウト（`signOutThisApp()`）でスナップショットを消す。iOSアプリが閉じている間に取ったセンサー値
（`ios/Kurashio/BackgroundRefresh.swift`）は Web からの pull（`backgroundSensorsReady`）だけで受け取る。
詳細は `ios/README.md`「起動直後の前回データと、閉じている間の取得」。

Web側の分岐は `frontend/lib/native-app.ts` の `isNativeApp()`
（ブリッジ `window.webkit.messageHandlers.kurashioAuth` の有無）に集め、**Web・PWA の挙動は変えない。**

- **Googleログインはアプリ内だけ PKCE。共有クライアント（`lib/supabase-client.ts`）の flowType を
  変えないこと。** implicit のまま `/auth/callback` の通知（#240）が動いている。アプリ内の PKCE
  クライアントは `code_verifier` だけを共有クライアントと同じキーで localStorage に置き、
  **セッションは持たない**（2つのクライアントが同じ refresh token を更新し合うとログアウトされる）
- **戻った `code` の交換は既存の `/auth/callback` に任せる。** アプリは WebView で
  `/auth/callback?code=…` を開くだけで、許可チェック（`/api/auth/me`）と通知を1か所に保つ。
  共有（implicit）クライアントは `?code` を自動処理しようとして失敗するが、`code_verifier` を
  消さないので、そのあとのページ側の `exchangeCodeForSession` は通る（auth-js 2.110 で確認）
- 戻り先 `kurashio://auth-callback` は Supabase の許可リダイレクトURLへの登録が要る。
  Swift の `AppConfig.authCallbackScheme` と `NATIVE_AUTH_REDIRECT` を揃えること
- WKWebView では Service Worker・Web Push が使えない。`window.confirm()` はアプリ側で実装している
  （無いと常に false になり、記録の削除が効かない）
- **ウィジェットの電気の操作ボタンは、ウィジェットから送らない**（#546）。JWT・固定トークンを渡さず、
  `PressRemoteButtonIntent`（`openAppWhenRun`）がアプリを前面に出し、WebのセッションでWeb側
  （`NativeWidgetPressReceiver`）が `POST /api/remote/buttons/{id}/send` を送る。**バックエンドに
  ウィジェット専用の認証経路は足さない**（内部APIの書き込みは2種類まで）。受け渡しは Web の pull だけ
  （アプリから中身を押し込むと自動リロードと競合する）で、押下キーの記録で最大1回に絞る。
  詳細は `ios/README.md`「電気の操作ボタン」

## 設定への入口

**設定を開くボタンは `components/ui/settings-icon-button.tsx` に統一する**（#277）。
文字ラベルは出さず、`label` が `aria-label` と `title` の両方に入る。**位置だけが意味を分ける。**

- ヘッダー右上（`tone="header"`・枠付き）＝ アプリ全体の設定。再読み込み・ログアウト・
  バージョンは `components/app-settings-sheet.tsx` に入っており、**ページ末尾にフッターは無い**
- セクション見出し・カード見出し（既定の `tone="inline"`）＝ その場の設定

新しく設定の入口を足すときは、独自にボタンを組まずこのコンポーネントを使う。

**セクションの設定は、そのセクションの見出しから開く**（#283）。`/devices`（いまの環境の設定）は
センサー・屋外・エアコンだけを扱い、**暮らしの設定は置かない。** 暮らしのカードの並び順と表示は
ダッシュボードの「暮らし」の見出しにある設定アイコン（`components/life-settings-sheet.tsx`）から
変える。同じ設定を2か所に置くと片方が古くなるので、入口は1つに保つこと。

**カードを全部隠せるセクションでは、見出しと設定アイコンを残す。** 節ごと消すと、隠したあとで
戻す入口が画面から無くなる（暮らしは空のときだけ「表示するカードがありません」を出す）。

暮らしの並び順は `app_settings` の `life_card_order`（キーの配列）で、**どのカードが存在するかの正は
`lib/dashboard-sections.ts` の `LIFE_CARDS`。** バックエンドには既定の並びを持たせず、知らないキーを
落として足りないキーを末尾へ足すのは `lib/life-card-order.ts` が行う。カードを1枚増やしたときに
「並べ替え済みの人にだけ出ない」を避けるための分担なので、両側に一覧を持たせないこと。

## 個別デバイスの詳細パネルに新しくグラフを足すとき

**ダッシュボード全体の`effectiveLineVisibility`をそのまま個別デバイスの詳細パネルへ渡さない**
（#351）。これは推移グラフの凡例クリックや`/devices`の表示設定で「このデバイスのこの指標は
隠す」という**グローバルな**非表示状態を持っており、そのデバイスを非表示にしている利用者が
そのカードを開いても、詳細パネルのグラフに線が1本も出ない。「そのカードを開いたのだから、
その線は必ず出す」を守るには、パネル内で対象デバイスのキー（`deviceMetricVisibilityKey()`
など）だけを`true`へ上書きしたオブジェクトを作り、それを`EnvironmentChart`へ渡す。
`OutdoorDetailPanel`の`lineVisibility`（outdoorキーを常に`true`にする、67-94行目近く）が
最初の実装で、エアコンの詳細パネル（`aircon-detail-panel.tsx`）もこの形にならった。
呼び出し側もグローバル非表示を反映しない`defaultLineVisibility`を渡すこと
（`effectiveLineVisibility`ではなく）。

**強制表示の上書きは「開いた時点の初期値」にとどめ、凡例の操作より優先させない**（#357）。
上の上書きを`useMemo`で毎レンダー当て直すと、凡例の目のアイコンを押しても
`onLineVisibilityChange`でグローバル設定が変わるだけで、パネル内の値は必ず`true`へ戻る。
**アイコンの絵柄も変わらず、押しても何も起きないように見える。** `lib/use-panel-line-visibility.ts`の
`usePanelLineVisibility()`を使い、`（グローバル設定 → 強制表示 → パネル内の操作）`の順で重ねること。
パネル内の操作は**開いているあいだだけ**覚え、グローバル設定へは書かない（書くと、開き直すたびに
強制表示へ戻るのにダッシュボードのグラフからは線が消えたままになる）。エアコンの詳細パネルと
`OutdoorDetailPanel`が同じ形。

## 推移グラフの凡例（`chartSeriesRows`）

**凡例の行を出す条件と、ラインを描く条件を別々に組み立てないこと**（#358）。
`components/environment-chart.tsx` の凡例は `legendOrder`（＝ダッシュボードの並び順）を回して
作るが、行を足す条件だけが `deviceIds`（`getVisibleChartDeviceIds()`）に依存していると、
**線は描かれるのに凡例に出ない**という状態ができる。凡例から消せないラインが残るため、
利用者からは「勝手に増えた線」に見える。

- **エアコンの室温と設定温度は別の指標。** `/devices` の「ダッシュボードに表示（室温）」を
  オフにすると `hidden_devices` に `device:9001` が入り、`getVisibleChartDeviceIds()` が
  `AIRCON_CHART_DEVICE_ID` を落とす。設定温度の行を室温の行と同じ `if` の中に置いていたため、
  **室温だけ隠したはずが設定温度の凡例まで消えた**（線は描かれたまま）。設定温度の行は
  `showAirconTargetLine`（＝線を描く条件）だけを見て出す
- **屋外の行は基準地点の1行だけ。** ラインは基準地点の1本（#308・#321）なのに、`legendOrder`
  には**地点ごとの項目**が並ぶ。`item.type === "outdoor"` に当たるたびに行を足すと、地点を2つ
  登録した時点で同じ名前・同じ値の行が2つ出る。どの項目の位置に出すかは
  `outdoorPrimaryLocationId`（基準地点のID）で決め、他の屋外の項目では行を足さない

**カードの表示・非表示を切り替える関数は、判定に使うキーをそのまま足し引きする。**
`lib/visible-devices.ts` の `setTargetVisible()` はエアコンだけ例外で、判定
（`isTargetVisible()` → `isAirconAnyVisible()`）が見ているのは室温・設定温度の2つのキーなのに、
`orderItemKey()` が返す `"aircon"` を足し引きしていた。保存済みの `"aircon"` は読み込み時に
`normalizeHiddenDeviceKeys()` が2つのキーへ読み替えるため、**非表示にして開き直したあとに
表示へ戻してもカードが戻らない**（消しているキーが残っていない）。

## 部屋の3Dビュー（`/room`）

**センサー・エアコン・掃除タスクは、どれも「部屋のどこにあるか」を持っていない**（持っているのは
`id` と表示名だけ）。3D上の場所と結び付ける対応表は `app_settings` の `room_layout` キー1つに
入れてあり、**マイグレーションは1行も足していない**（#399）。**どのゾーンが存在するかの正は
`frontend/lib/room-layout.ts` の `ROOM_ZONE_DEFS`** で、`backend/ui_settings.py` の
`_normalize_room_layout()` は形だけを整えて素通しする（`life_card_order` と同じ分担・#283）。
知らないキーを落として足りないキーを補うのはフロントの `normalizeRoomLayout()` の仕事。

- **three.js は `next/dynamic` の `ssr: false` でしか読まない。** `output: "export"` なので
  サーバー側では描けず、素で import するとダッシュボードの初期バンドルに three が載る。
  分離できているかは**ビルド後に `out/index.html` が参照するチャンク一覧を見れば分かる**
  （`grep -l WebGLRenderer out/_next/static/chunks/*.js` で出たファイルが、その一覧に
  入っていなければよい）
- **`<Canvas>` はエラー境界で包む。** WebGL が使えない・無効にされた端末では `<Canvas>` が
  例外を投げ、境界が無いと**ページごと真っ白になって一覧まで読めなくなる**
  （`components/room-view.tsx` の `RoomSceneBoundary`）
- **3Dの中に文字を描かず、`@react-three/drei` の `<Html>` でDOMとして重ねる。** 3Dのテキストは
  視点を回すと裏返って読めなくなり、テーマごとの色・フォントも画面の他の場所と揃わない
- **新しいページを足したら `/devices` と同じ認証ゲートを通すこと。** `resolveAuthGate()` で
  読み込み画面・ログイン画面へ倒さないと、静的書き出しの `out/<page>/index.html` に
  **ログイン後の画面がそのまま焼き込まれる**（#250 と同じ理屈）
- 間取りは実物の2LDK（#406）を**図面から起こした寸法データ**で、`lib/room-layout.ts` が持ち、
  `components/room-scene.tsx` が描いている（glTF/GLB は使っていない）。図面を直すときに触るのは
  この2つだけで済むよう、**外から渡すのはゾーンのキーと値だけ**にしてある
- **ゾーンのキーは間取りを変えても据え置く**（`ldk`・`bedroom`・`bath`・`entrance` は仮の1LDK
  時代のまま）。保存済みの紐付けはキーで引くため、キーを変えると設定シートで付け直しになる。
  表示名だけ `name` で変える
- **`ROOM_AIRCON_MOUNTS` からキーを消さないこと。** 既定の紐付けを変えても効くのは未保存の人だけで、
  保存済みの人には旧ゾーンに `ac_id` が残る。位置が無いと一覧には「冷房 26℃」と出るのに3Dには
  本体もピンも出なくなる。実物に無い場所でも位置は残し、付け替えは設定シートに任せる
- **壁の開口（`gaps`）は `buildRoomWallParts()` が昇順に並べ直す。** 図面から起こした順のまま
  書けるようにするためで、並び順に頼ると開口が黙って塞がり別の場所に穴が空く
- **エアコンは本体・風・ピンを同じ `rotation-y` つきの `<group>` に入れる。** 壁の向きに合わせて
  本体だけ回すと、風が壁の外へ流れてピンが本体の裏に出る
- **照明の器具と光の円錐はゾーンの短辺から大きさを決める。** トイレ・洗面所のような1畳前後の場所に
  LDKと同じ固定サイズで置くと、器具が天井を埋め、円錐が隣の部屋まではみ出す
- **バルコニーもゾーン**で、屋外のセンサーを紐付けられる。ただし設定シートに並ぶのは
  `GET /api/devices` の一覧（`sensor_readings` に届いた `device_id` と名前表）だけなので、
  天気API（`outdoor_config.py`）の値は紐付けられない

## 照明の点灯履歴（アレクサ・アプリ・壁スイッチのどれでも拾う）

**アレクサの操作履歴を読む公式APIは存在しない**（#368）。Alexa Smart Home Skill API は
「自作のクラウドがAlexaへ状態を報告する」向きの設計で、逆に「Alexaが記録した操作履歴を
第三者が読む」口は無い。IFTTT の Alexa トリガーも2023年10月に廃止済み。非公式の内部API
（`alexa-remote2` 等）はCAPTCHA・OTPで認証が壊れやすく、常時稼働のアプリには向かない。

そのため履歴は「操作の結果として残ったもの」から復元する。**経路が2つあり、場所ごとに
`app_settings` の `light_sources` で選ぶ**（`{"kind": "illuminance"}` か
`{"kind": "remo", "appliance_key": "d-…"}`）。判定は `backend/light_history.py` の純関数。

- **Nature Remo の状態。** `GET /1/appliances` の応答で、**`type` が `LIGHT` の機器だけが
  `light.state.power` を持つ。** 生の赤外線（`type: IR`・`signals` に「オン」「オフ」が並ぶ形）
  はクラウド側に状態が残らないので、この経路は使えない。`/devices` の候補一覧
  （`GET /api/light-sources`）が `LIGHT` だけを返すのはこのため
- **照度センサー。** `sensor_readings.illuminance` と `light_thresholds`（#258）から区間を
  組み立てる。**過去に遡れるのはこちらだけ**（Nature Remo 側は記録を始めた日から先しか無い）

**「電気の操作」カードの設計（状態を持たない・#106）は変えていない。** 状態を読むのは履歴の
ためだけで、ボタンは今までどおり押したら飛ぶだけ。ポーリングは
`backend/main.py` の `lifespan` に相乗りさせた5分間隔（レート制限は30回/5分）で、
**紐付けが1つも無ければ Nature Remo を叩かない。**

- **`light_events` は変化したときだけ1行足す。** `energy_readings` のようなスナップショットの
  積み上げにすると1機器あたり年10万行になるうえ、要るのは変わった瞬間だけ
- **照度から作った区間だけ、短い揺れをならす**（`SMOOTHING_MINUTES`）。1点だけしきい値を
  跨いだときに点灯・消灯が2件増えるのを防ぐ。**Nature Remo の記録には当てない**——1件1件が
  操作の結果なので、5分の点灯も本物
- **記録が空いた区間は繋がない**（`MAX_GAP_MINUTES`）。バックエンドが止まっていた時間を
  「点いていた」と数えると合計が実態から外れる
- **日中（6:00〜18:00）に収まる区間には `daylight` の印を付ける。** 照度からの判定は日射でも
  成立してしまうので、消せない代わりに気づけるようにする。Nature Remo の記録には付けない

### 帯はグラフと同じ時間軸へ重ねる

`components/environment-chart.tsx` の `LightBand` は、**プロット領域と同じ余白（`PLOT_INSET`）を
取り、`currentDomain` で位置を決める。** ここを揃えないと帯とグラフが横にずれる。期間の
切り替えも横スクロールも `currentDomain` が変わるだけなので、帯は自動で追従する。
一覧（`components/light-history-section.tsx`）にも同じ範囲を渡すこと——グラフを動かしたときに
一覧だけ取り残されると、目の前の帯と行が食い違う。

**取得する窓は `historyData` の先頭・末尾から作る。** `useChartHistory` が読み込んだ範囲と
揃えないと、グラフの端で帯だけが途切れる。

**「日中」を帯の中の割合（`left: 25%` / `width: 50%` のような固定値）で描かないこと**（#371）。
`currentDomain` は `lib/chart-utils.ts` の `computeChartDomain()` が返す
`dataMaxTime + rightPadding + domainOffset` 起点の**ローリングウィンドウ**で、日付の境界にも
6:00 にも整列しない。週・月では1本の帯に何日ぶんも乗るため「中央50%が日中」という表現自体が
成立せず、日表示でも現在時刻が0時ちょうどでない限り実際の 6:00〜18:00 とはずれる。
**印を付ける相手は時間軸ではなく区間そのもの**で、どの区間が日中に収まるかはバックエンドが
`daylight` として返している（`buildBandPieces()` の `piece.daylight`）。`LightBand` はこれを
縞の塗り（`DAYLIGHT_FILL`）で描き分け、一覧の「日射の可能性」バッジと同じ区間を指す。

**`light_events` を引くときは下限も絞る**（#371）。状態が変わったときだけ1行足す追記専用の
テーブルなので、窓の先頭ですでに点いていたかを知るには手前の記録が要るが、必要なのは
**直前の1件だけ**。`backend/main.py` の `_light_history_events()` は「窓のあいだの全件＋手前の
1件」を引く（下限なしで全件を読むと、運用が長くなるほど読む行が増え続ける）。

### モックの照度は「夜は暗く、点けたときだけ明るい」

**`sin` を時間帯で区切らずに使わないこと。** 周期関数なので、昼の直射を表す式をそのまま
全時刻へ当てると深夜と夕方にも山が立ち、「点いていないのに点灯」の区間がモックに紛れ込む
（`database._mock_illuminance()` で実際に踏んだ）。以前のモックは夜でも 200 lx あり、
照明の判定が常に「点灯」になって開発サーバーでは履歴を確かめられなかった。

## 読み込み表示（スケルトン）

**シート・パネルの読み込み表示は、実データと同じ骨格・同じ高さで作る**（#329）。このアプリの
ボトムシート（`components/power-detail-panel.tsx`など）は高さが中身で決まるため、3本線だけの
簡素なスケルトンを出すと**シートが画面の下端まで縮み、データ到着でまた最大高へ戻る**。
利用者にはこの上下動が「ちらつき」として見える。

- 消費電力の詳細では`components/power-skeleton.tsx`にタイル・棒グラフ・一覧行の骨格を置き、
  日別（デバイス選択後）と時間ごとの両方で使い回している。**行数は取得前に分からないので、
  親がすでに持っている件数（`breakdown.daily.length`）を借りて高さを近づける**
- **骨格は`.skeleton-delayed`（`app/globals.css`）で150ms遅らせてフェードインさせる。**
  枠は最初から置くので高さは確保されたまま、取得がすぐ終わるときは骨格そのものが見えない。
  **点滅（`animate-pulse`）と同じ要素に付けないこと**——どちらも`animation`を使うため片方が消える
- **取り直しの失敗でエラー表示へ倒さない。** すでに取れている内容があるなら出し続ける
  （`error && !summary`で判定）。取得済みの内容をシートを開いているあいだ覚えておくと、
  別の対象を見てから戻ったときに読み込み表示そのものを挟まずに済む

## 設定の数値入力欄

**`type="number"` の入力欄を「変更のたびに保存」でつながないこと**（#348）。通知設定の室温・湿度の
閾値がこの形になっており、**数字がまともに打てなかった。** 原因は3つ重なっている。

- **`disabled={saving}` が入力中に効く。** 1文字打つたびに保存が走って入力欄が `disabled` になり、
  ブラウザがフォーカスを外す。**2文字目以降が入らない**のはこれ
- **`Number(event.target.value)` は空欄を `0` にする。** 全部消して打ち直そうとした瞬間に `0` が
  保存され、`"-"` や `"18."` のような入力途中の文字列は `NaN` になる
- **中途半端な値がバックエンドの正規化に当たる。** `ui_settings.py` の
  `_normalize_room_anomaly_thresholds()` は `min >= max` を**既定値（16/30）へ丸ごと落とす**ため、
  上限を `25` にしようとして `2` まで打った時点で両方が既定へ戻る

**下書きは文字列で持ち、確定は `onBlur`（と Enter）だけにする。** `drafts[key] ?? String(保存済みの値)`
を `value` に出す形にすれば、下書きを effect で詰め直さずに済む（`react-hooks/set-state-in-effect`
を増やさない）。確定時に数値へ変換し、読めない文字列は保存せず保存済みの値へ戻す。
**入力欄からは `disabled={saving}` を外す**（確定はフォーカスを抜けた後なので入力を邪魔しない）。
`min >= max` のような組み合わせの不正はフロントで弾いてメッセージを出す——バックエンドに任せると
「既定値へ戻る」という結果だけが返り、理由が画面に出ない。

## iOS PWAの上端（ステータスバーの下のぼかし）

**iOS 26以降のPWAは、ステータスバーの下へ潜った内容を上端でぼかし、ページの下地の色で色付けする。**
下地が本文の灰色で、下の内容がカードや文字だと、薄緑のヘッダーの上に灰色のモザイク状グラデーションが
出る（#462・#478）。効果そのものは消せないので、**ぼかす対象と色付けを常にヘッダー色の単色にする**
（単色はぼかしても単色なので見えない）。`app/layout.tsx` と `app/globals.css` の次の組み合わせで成立して
おり、どれか1つを外すと再発する。

- **`viewportFit: "cover"` と `statusBarStyle: "black-translucent"`**（#462）。上端までアプリ側で描く
- **安全領域の高さぶんの `position: fixed` の帯**（#478）。#462 の `pt-[env(safe-area-inset-top)]` の余白は
  本文と一緒にスクロールするため、スクロールするとカードが潜ってモザイクになる。帯はモーダルの暗幕
  （`z-50`）より下の `z-40`
- **`html` と `body` の背景をヘッダー色（`--header-band`）にする。** 本文の灰色は内側の div が塗る。
  `global-error.tsx` の body は globals.css の既定（本文色）のまま
- **`theme-color` とマニフェストの `theme_color` も `--header-band` と同じ値。** 色を変えるときは
  `globals.css` と3か所を揃える（`app/layout.test.tsx` が照合する）

**iOSはステータスバーの設定をホーム画面へ追加した時点で読む。** 実機で確かめるときは、ホーム画面から
削除して追加し直すこと（そのままだと古い設定の見た目が残り、直っていないように見える）。

**iOS 27以降は上記だけでは足りず、単色の帯（#478）の上にさらにぼかしが重なることがある（#482）。**
WebKitは「上端に固定ヘッダーが実在するか」をレンダリング結果ではなくCSSの静的な見た目だけで判定し、
無いと判断すると自動でぼかしを重ねるためで、`opacity: 0`・`display: none` の要素は判定から除外される
（[参考記事](https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17)）。#478の帯は可視の単色塗りなので
そのまま `background-clip: text` を付けると背景が消えて#478の効果自体が壊れる。そのため**別の要素**として、
`position: fixed; top: 0` で高さ10pxを超え、テキストを持たない `background-clip: text` の要素
（見た目には何も描画されない）を追加し、WebKitに「実在する固定ヘッダーがある」と誤認させて自動ぼかしの
発生自体を止める。高さは記事が示す下限に合わせた固定値（`11px`）で、`env(safe-area-inset-top)` に連動させる
必要はない。

**ダッシュボードのヘッダーは、画面の上端（y=0）から始まる `position: fixed` の1枚にしている（#513）。**
上の帯（#478・#482）だけではiOSのぼかしが止まらず、ステータスバーの下へ約40ptのぼかしが伸びて、
安全領域の下から始まる `sticky` のヘッダー（#488）の上半分（ロゴ・アイコン）がぼけていた。
ヘッダー自身が `pt-[env(safe-area-inset-top)]` で安全領域ごと塗り、上端に接した不透明な固定ヘッダーとして
WebKitに見つけさせる。**重なり順は `z-[45]`**で、上の帯と #482 の要素（z-40）より上・モーダルの暗幕（z-50）より下。
上端の最前面をヘッダーにして、iOSが上端で拾う要素が帯やダミーにならないようにしている（#482 の要素は他の画面のために残した）。fixed で流れから外れるため、直後に `lib/use-element-height.ts` で実測した高さの余白を
置いている。**`sticky top-[env(safe-area-inset-top)]` に戻さないこと**（`app/layout.test.tsx` が照合する）。
ぼかしは実機（ホーム画面へ追加し直したPWA）でしか確かめられない。`statusBarStyle` を `default` に戻す案は、
外部の実測（amir20/dozzle#5222）でぼかしが減らなかったため採っていない。

**iOS 27では、上記（#478/#482/#513/#517）をすべて実装した状態でも、ステータスバー下のぼかしは消えない
（#521）。** 他プロジェクトの実機実測（amir20/dozzle#5222・Yeraze/meshmonitor#5286）でも、
`black-translucent`をやめる・単色背景にする・固定ヘッダー検出トリックを使うのいずれも効果がないか
未検証で、2026年9月時点でWeb開発コミュニティ全体として確実な回避策が無い。dozzle#5222の実機測定では
「ぼかしの帯は安全領域下端から一定距離（約40〜45pt）に固定して出る」ことが分かっているため、**#521では
「ぼかしを消す」のではなく「その範囲にヘッダーの中身を置かない」方向に変えた。** `app/globals.css`の
`--pwa-header-safe-gap`（`@supports (-webkit-touch-callout: none)` + `display-mode: standalone`限定で
非ゼロになるCSS変数）を、`useElementHeight`が実測しているヘッダー内側のdivの`padding-top`に足し、
ロゴ・アイコンの開始位置を安全領域よりさらに下げている。**ヘッダー自身（`fixed`要素）の`padding-top`に
足すと、直後の余白（`headerBarHeight`）が追従せず本文の先頭が隠れる**（内側のdivではなく外側の
`<header>`を測るように変えない限り）。今後 #482/#513 系の「WebKitに固定ヘッダーと誤認させる」対策を
iOS 27で再度試すのは、上記の実測から見込みが薄い。

## アプリアイコン・ブランド画像

**表示名は `kurashio`（#447）。** 画面・manifest・通知・ログイン通知の `source` は kurashio だが、
リポジトリ名・DB名・localStorage のキー（`myroom_*`）・イベント名（`myroom-*`）・`sw.js` の
`CACHE_NAME`・コンポーネント名（`MyRoomDashboard`）は**内部識別子として `myroom` のまま残している。**
キーを変えると保存済みの設定が読めなくなるので、名前を揃えるためだけに変えないこと。

**アイコンとブランド画像の正は `frontend/assets/` の2枚のPNG**（`kurashio-app-icon.png`・
`kurashio-brand-source.png`。受け取った素材にSVGが無いため）。差し替えたら
`cd frontend && node scripts/generate-icons.mjs` を実行すると、`public/kurashio-*.png` と
`app/apple-icon.png` / `app/icon.png` がまとめて書き出される。ラスタライズには **sharp**
（Next.js が連れてくる既存の依存）を使うので、`npm ci` 済みなら追加インストールは要らない。

- **アイコンのファイル名は変えるたびに付け替える。** iOS のホーム画面・ブラウザは同じURLの
  アイコンをキャッシュし続けるため、中身だけ差し替えると旧アイコンが残る。`icon-192.png` から
  `kurashio-icon-192.png` へ変えたのはこのため（`app/` の2つは Next.js がハッシュ付きURLにする）
- **maskable は角をタイル色で塗った別ファイル**（`kurashio-icon-maskable-512.png`）。Android は
  中央80%の円で切り抜くため、絵柄は中心から一辺の0.40以内に収める（今の絵は0.38）。
  Apple Touch Icon も同じく塗りつぶし版（透明な角は iOS で黒くなる）
- **ヘッダーのブランド画像は、元画像のタイルとロゴ文字だけを座標で切り出して並べ直している。**
  キャッチコピーはヘッダーの高さでは読めないため使わない。元画像を差し替えたら
  `BRAND_TILE`・`BRAND_WORDMARK` の座標を測り直すこと。白背景は色→透明で抜いている
- **ダークテーマ用に、ロゴ文字だけ明るく塗った `kurashio-brand-dark.png` を別に持つ。**
  元の文字は濃い紺で、ダークの背景では沈む。ヘッダーは `dark:hidden` / `dark:block` で出し分ける

## 本番DBのマイグレーション

**テーブルや列を増やす変更（`migrate_db.py` へのDDL追加）は、本番の「アプリ用DBユーザー」では実行できない。**
本番は共有MariaDBで、アプリ用ユーザー（`SHARED_DB_USER`）には
`SELECT / INSERT / UPDATE / DELETE` しか付いていない。DDLを含むマイグレーションをそのまま流すと
`CREATE command denied` / `ALTER command denied`（MySQLエラー1142）でデプロイが落ちる（#193）。

そのため `deploy.yml` は、**マイグレーション専用ユーザー**（organization secret の
`SHARED_DB_MIGRATE_USER` / `SHARED_DB_MIGRATE_PASSWORD`）を `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`
として `migrate_db.py` の実行時にだけ渡す。**この値は本番の `.env` には書かない**
（常時稼働するバックエンドにDDL権限を持たせないため）。`migrate_db.py` はこの2つが空なら
アプリ用ユーザーへフォールバックする。

**その前に、`app_settings` テーブル（`setting_key` varchar(64) / `setting_value` TEXT）で足りないかを
必ず検討すること。** 画面から編集する設定や、件数がせいぜい数十件で1行の JSON に収まるデータは、
新しいテーブルを作らずにここへキーを1つ足すだけで持てる。**DDL が無ければ上記の権限問題を
そもそも踏まない。** 既存の設定なら `backend/ui_settings.py` にキーと正規化関数を1つ足せば済む
（#262 の `remote_button_defs` / `remote_catalog` がこの形）。

**`ui_settings.py` にキーを足すときは、同じファイルの3か所すべてに書くこと。**
`_default_settings()`・`_normalize_settings()`・**`save_settings()` の `merged` 辞書**の3つで、
最後の1つを忘れると GET では正しく返るのに、**別の設定を保存した瞬間に既定値へ戻る**
（`save_settings` は `merged` に並べたキーだけを引き継ぐため）。テストは「そのキーを保存 → 別の
キーだけを保存 → 取り直して残っているか」の形にしないとこの抜けを拾えない（#258 の
`light_thresholds`）。`PUT /api/ui-settings` を通すには `backend/main.py` の
`UiSettingsUpdate` にもフィールドが要る。まとまった機能なら `backend/cleaning.py`
のように専用モジュールで読み書きしてもよい（掃除の予定と実施履歴・`cleaning_tasks`、#259）。
どちらもマイグレーションを1行も足さずに追加できた。`setting_value` は `Text`（64KB）なので、
数百KBになるものだけは別の置き場を考える。時系列で伸び続けるもの・期間で絞って引くものは
この器に向かないので、そのときは下記に従ってテーブルを足す。

**複数のキーが同時に変わる操作は、フロント側で1回のPUTにまとめること**（#377）。
`save_settings()` は呼ばれるたびに `current = get_settings(db)` で**全キー**を読み直し、
`merged` を作って**全キーを書き戻す**。`PUT /api/ui-settings` は同期関数なのでFastAPIは
スレッドプールで並行に処理するため、2本のPUTを`await`せずに続けて投げると
「A読み→B読み→A全書き→B全書き」の順に噛み合うことがあり、**Bが読んだ時点の古い値で
Aの変更が上書きされて消える**（`_save_db_setting()` はキーごとに`commit()`するため、
途中まで反映された状態にもなる）。カードを隠す操作で`display_order`と`hidden_devices`の
2本を続けて投げていたのが実例（`frontend/components/device-visibility-page.tsx`の
`handleVisibilityChange()`）。直し方は`updateUiSettings({ key1, key2 })`のように
1回のPUTへキーを並べるだけで済む（`exclude_unset`の部分更新なので他のキーは変わらない）。
バックエンド側（読み直し→全書き戻しという設計自体）は変えていない。

- 新しいテーブル・列を足すときは `migrate_db.py` に「存在チェック → 無ければ作る」の形で追記する
- **マイグレーション専用ユーザーにそのDBのGRANTが無ければ、上記を渡しても落ちる。**
  その場合はVPS上で管理者ユーザーからGRANTを1度だけ実行する必要がある（手作業。Git管理外）

**`app_settings` に入っているJSONの形を変えるときは、読み取り時に古い形も受けて移行する。**
DDLもデータの一括書き換えも要らず、本番の権限問題（上記）をそもそも踏まない。掃除の実施履歴を
`["2026-08-30"]` から `[{"date": …, "recorded_at": …}]` へ変えたとき（#294）は、
`backend/cleaning.py` の `_normalize_history()` が文字列の要素も受けて足りない項目を補う形にした。
**移行スクリプトを書いて既存の行を書き換える形にはしないこと**（本番と手元で実行のタイミングが
揃わず、片方だけ新しい形になる）。テストは「古い形を読める」ことを1件、独立して残す。

**単一オブジェクトを複数件の配列へ広げるときも同じ考え方が使える。** 屋外の地点データを
1件から複数件へ広げたとき（#308）、`outdoor_location`キーの値を`{"latitude", "longitude", "name"}`から
`{"locations": [...], "primary_id": "..."}`へ変えた。`backend/outdoor_config.py`の`_parse_state()`は
「`locations`配列を持つ新形式」「`latitude`を直接持つ旧形式（1件だけの配列＋そのIDを基準地点として
扱う）」の両方を読み、どちらの場合も既存データを失わない。**複数地点を扱うAPI・地点選択のUIを
足す一方で、推移グラフ・表示順序・チャート色設定は「屋外は1件」という前提のまま変えなかった**
（display-order.ts・chart-colors.tsを地点ごとに複数持たせる形にすると改修範囲が全面改修になるため）。
グラフに出すのは常に基準地点で、他の地点は屋外詳細パネル内の切り替えタブから選ぶと、その地点の
今の天気・推移グラフだけが差し替わる（`weather.get_coords()`が`location_id`省略時に基準地点へ
フォールバックする形にしてある）。

**カードも地点ごとに1枚並べるようにしたのが#321。** 並び順（`display_order`）と非表示
（`hidden_devices`）のキーを`outdoor`から**`outdoor:<地点ID>`**へ広げた。移行はフロントの
読み込み時に行い、DDLもデータの書き換えもしていない。

- **旧`outdoor`のキーは「基準地点」として読み替える**（`lib/display-order.ts`の
  `resolveOutdoorOrderItem()`・`lib/visible-devices.ts`の`normalizeHiddenDeviceKeys()`）。
  **`backend/ui_settings.py`は1行も変えていない**——`_normalize_display_order()`は任意の文字列を
  素通しするため、`outdoor:<id>`はそのまま往復する。`DEFAULT_DISPLAY_ORDER`に残る`"outdoor"`は
  保存のたび末尾へ足されるが、読み込み時に基準地点へ読み替えられて重複として落ちる
- **推移グラフの屋外ラインとグラフ色は基準地点の1本のまま**（#308の判断を引き継ぐ）。
  `applyHiddenDevicesToLineVisibility()`には**基準地点のキー**を第4引数で渡す。
  ここを地点ごとに増やすと`/api/history`のレスポンス形・凡例・色設定まで波及する
- 地点の数だけ`/api/outdoor-locations/{id}/weather`を叩かずに済むよう
  `GET /api/outdoor-locations/weather`（全地点ぶん）を足した。`weather.get_outdoor_weather()`の
  座標ごとのキャッシュ（5分）に乗るので、外部APIの呼び出し回数は増えない
- **`normalizeDisplayOrder()`はダッシュボードのレンダー時にも通す。** 地点を足した直後は
  保存済みの並びにその地点が無く、設定を取り直さないとカードが出ないため

**シートの下書きはeffectで詰め直さない。** 開いた地点の値をフォームへ入れるのに
`useEffect(() => setForm(...), [open, location])`と書くと`react-hooks/set-state-in-effect`の
**error**が1件増える。呼び出し側が「開いているあいだだけ描く＋`key`に地点IDを渡す」形にして、
`useState`の初期値で作れば増えない（`components/outdoor-location-sheet.tsx`と
`device-visibility-page.tsx`の呼び出し）。

## サーバー間の内部API（操作用トークン）は書き込みを2種類に絞る

**`INTERNAL_CONTROL_API_KEY` の Bearer でだけ通る口で書き込めるのは、次の2つだけ**（#419・#439）。
ユーザーJWTを介さない経路なので、口が増えるほど「ログインしていない誰かが叩ける操作」が増える。

1. **登録済みボタンを押す**（`POST /api/internal/remote/buttons/{id}/send`）。受け取るのはボタンIDだけで、
   signal ID・appliance ID は受けない
2. **エアコンの運転指示**（`POST /api/internal/aircon/units/{ac_id}/control`）。受け取るのは
   `power` / `mode` / `target_temperature` / `fan_speed` の4つだけ

以前は `send_internal_remote_button` の docstring に「エアコンの操作はここに足さないこと」と書いて
いた（#419）が、#439 で「上の2つ」へ広げた。**3つ目の書き込み（名前の変更・ボタンの登録・設定の書き換え
など）を足すときは、同じ判断（範囲を広げてよいか）をやり直すこと。**

- **エアコンの内部APIは画面用と同じ処理を通す。** `main.py` の `_read_aircon_state()` /
  `_apply_aircon_command()` を画面用（ユーザーJWT）と内部API（操作用トークン）の両方が呼ぶ。
  検証・現在値との混合（`aircon_control.merge_command`）・失敗のステータスと文言（404・422・429 と
  `Retry-After`・502・503）を片方だけ変えて食い違わせないための形。**内部API側に検証を書き足さない**
- **`fan_swing` は受けない。** `InternalAirconControlCommand` は `extra="forbid"` で、余計な項目は
  黙って捨てずに 422 で返す（捨てると呼ぶ側には「送れたのに変わらない」に見える）。画面用の
  `AirconControlCommand` には `fan_swing` を残している
- **温度の意味は呼ぶ側で解釈させない。** 自動運転の `target_temperature` は設定温度ではなくシフト量で、
  モードを切り替えたときの扱いも含めて `merge_command()` が現在の状態と突き合わせる
- **状態の取得（GET）も操作用トークン。** 読み取りだが白くまくんのクラウドを叩く経路なので、読み取り用の
  `INTERNAL_API_KEY`（`room-state` 専用）では通さない。AIDE は「ルート自体が無い404
  （`detail: "Not Found"`）」と「未登録の `ac_id` の404」を `detail` で見分けている
- モックモードでは `room_temperature` が時刻で動く。テストで状態を比べるときは、この項目を外さないと
  呼び出しのあいだにずれて不安定になる（`tests/test_aircon_control.py` の `_without_room_temperature`）

## 3Dプリンター（Bambu Lab A1 mini）の状態は「最新の1件」だけを持つ

**ローカルMQTTの購読はサブPCの常駐プロセス（`collectors/bambu_to_myroom.py`）が持ち、myroom は
受け取って正規化・保存・返却するだけ**（#428）。バックエンドはMQTTへ繋がない（VPSはプリンターと
別のLANにいる）。セットアップ・ログの見方は `collectors/README.md` の bambu の節。

- **保存は `app_settings` の `bambu_printer_state` 1行。マイグレーションは1行も足していない。**
  履歴（過去の印刷の一覧）は持たない。要るなら時系列で伸びるのでテーブルを足す別の話になる
- **`GET /api/internal/bambu/printer` は現在値を `online` のときだけ返す。** 収集が止まった
  （最後の受信から180秒超・`collector_stale`）ときも、プリンターに繋がっていない
  （`printer_offline`）ときも `printer` は `null` で、最後の値は `lastKnown` に分ける。
  **`online` を見ずに `lastKnown` を「いま」の値として使わないこと**
- **収集は変化が無くても60秒ごとに送る。** 待機中は変化が無いので、これが無いと「収集が止まった」と
  区別が付かない。間隔を伸ばすなら `BAMBU_STALE_SECONDS`（既定180）も合わせて見直す
- **全状態を受け取るまで `connected: true` にしない。** 再接続直後は差分しか届かず、
  マージ前の値を「いま」として見せてしまうため（`BambuMonitor.snapshot()`）
- **`pushall` は5分以上あける。** P1/A1 系は短い間隔の要求へ応答しなくなることがある。接続のたびに
  送らず、`BambuMonitor.pushall_allowed()` で間隔を守る（再接続が続く場合は全状態を待たせる）
- **この経路から印刷を操作しない。** 内部APIは読み取り専用（`INTERNAL_API_KEY`）で、収集が送る
  MQTTも `pushall` だけ。操作を足すなら `INTERNAL_CONTROL_API_KEY` の別の口として決め直す
- **画面（「暮らし」末尾の3Dプリンターカード・#436）は `GET /api/bambu/printer`（ユーザーJWT）から読む。**
  応答の形は内部APIと同じ（`bambu.build_response()`）で、内部APIのトークンをブラウザへ渡さないために
  口だけ分けてある。`components/printer-card.tsx` は**現在値を `printer`（＝`online` のときだけ入る）
  から読み、`lastKnown` は「最後に確認した状態」の1行にしか使わない**（温度・進捗の枠は出さない）。
  時刻は `lib/bambu.ts` が文字列のまま切り出し、「いま」は端末の時計ではなく応答の `fetchedAt` を使う。
  更新はダッシュボードの30秒更新に相乗りしている（専用のポーリングは持たない）
- **カードには、プリンターから自動で取れる材料・色（`ams`）を出さない**（#453）。実物のスプールと
  合わないことが多く、「PLA 外付けスプール」のような表示が誤解のもとになるため。フィラメントは
  下の「フィラメント残量」（自分で量った値から計算）だけを正とする。応答の `ams`・`BambuTray` の型は
  API の形として残してあるので、**表示を戻すときは `lib/bambu.ts` へ組み立て関数を書き直す**
  （AMS Lite が無い構成では材料・色は `ams.externalSpool` にしか入らず、残量も読めない）
- **完了・停止・エラーの遷移は `backend/bambu.py` の `detect_transition_events()` が
  `NotificationEvent` として組み立てるが、Push配信はしていない**（`main.py` の
  `_handle_bambu_events()` はログに出すだけ）。AIDE側（guchi-apps/aide#378）と役割分担を決めてから
  `notify_events.dispatch_push_event()` へ渡す。**前回が無い・古い（収集が止まっていた）ときは
  比べない**——再開直後に完了済みのジョブを「いま完了した」と誤検出しないため
- **収集の受け口（`POST /api/bambu/state`）は無認証**で、`/api/sensor`・`/api/energy` と同じ扱い
  （#249）。**接続情報（`BAMBU_HOST`/`BAMBU_SERIAL`/`BAMBU_ACCESS_CODE`）はサブPCの
  `collectors/.env` にだけ置き、1Password・GitHub secret には置かない**（本体の画面から読み直せる）
- AMS Lite の残量は `remain` が 1〜100 のときだけ返す（0・-1 は「不明」）。実機は AMS Lite なしの
  構成でしか確かめていない

## フィラメント在庫は「最後の計量」を基準に、使用量を引く（#445）

**Notionの「3Dプリンター フィラメント在庫」でやっていた計算（現在の全体重量 − 空スプール）をアプリへ
移したもの。** 保存は `app_settings` の `filament_spools` 1行（DB_MOCK は `data/filament.json`）で、
マイグレーションは1行も足していない。計算は `backend/filament.py` の `compute_remaining()` **だけ**が持ち、
フロント（`lib/filament.ts`）は返ってきた `remaining_g` / `percent` / `level` を表示するだけ。
両側に計算を持たせると、計量と使用量の前後の判定が食い違う。

- **残量 ＝ （最後の計量の全体重量 − 空スプール）− 計量より後の使用量。** 計量が無ければ
  「初期フィラメント量 − 使用量」。秤で量ったらその値が正で、それ以前の使用量は引かない
  （誤差を溜めないため）。Notionのグレー（全体1011g・空スプール152g）の859g・86%を
  `tests/test_filament.py` で再現している
- **「計量より後」は `(date, recorded_at)` の組で比べる。** 計量のあとに、計量より前の日の印刷を
  入れ忘れて登録しても数えない（量った重さにすでに含まれる）。印刷した時刻は持っていないので、
  同じ日のうちに「印刷 → 計量 → 印刷の入力」の順で登録すると二重に引く。計量し直せば直る
- **使用量はMQTTから取れない（`report` にグラム数が無い）。手入力に加え、3mf経由で自動でも入る（#454）。**
  サブPCの収集がプリンターSDの `/cache/<subtask_name>`（3mf）をFTPS（990・読み取りのみ・追加の依存なし）で読み、
  `Metadata/slice_info.config` の `<filament used_g>` を `job_filament` として状態と一緒に送る
  （実機で `50x110 ケース.3mf` = 24.41g を確認）。バックエンドは**完了（FINISH）で予定値そのまま、停止（FAILED）で
  進捗率で按分した概算**を、`filament.record_auto_usage()` が**使用中のスプール**へ記録する
  （`source` は `auto` / `auto_estimate`。履歴に「自動」「自動・概算」）。**スライサーの予定値で実測ではない。**
  - **使うフィラメントが1色のときだけ**（複数色はどのスプールから引くか決められない）。使用中のスプールが
    無ければ引かない（外しておけば自動を止められる）
  - **二重に引かない仕組みは `job_key`**（`<ファイル名>@<開始時刻>`・造形の開始ごとに収集が作る）。全スプールを
    見て同じ `job_key` があれば `duplicate` で何もしない。使用中のスプールは**排他区間（`_update()`）の中で決める**
  - 状態の保存は先に済ませ、在庫への記録が失敗しても `POST /api/bambu/state` は成功で返す（`_apply_bambu_filament_usage`）。
    引けなかった造形は手入力で直す。**収集が止まっていた間に終わった造形は引かない**（`detect_transition_events`
    と同じ「前回が古い」の判定）。`job_filament` のジョブ名が現在の `subtask_name` と違えば捨てる
  - **`POST /api/bambu/state` は無認証**（#249）のまま、在庫が動く経路が増えた。1回の上限は `MAX_USAGE_G`、
    記録は履歴から1件ずつ取り消せる。認証を付けるなら収集経路全体でまとめて決める
  - 3mf が読めない（クラウド経由の印刷・SDなし・複数プレート）造形は何もしない。プリンターカードは
    在庫の記録と `job_key` を突き合わせて「差し引きました／在庫には反映されていません」を出す
    （`lib/job-filament.ts`。引く判断はフロントに持たせない）
- **Notionの既存データは移していない。** 値が古く使い切りも混ざっているため。使いかけのスプールは
  登録時に「いまの全体重量」を入れれば、それが最初の計量になる。**移行スクリプトは書かない**
  （本番と手元で実行のタイミングが揃わない）
- **空スプールの重さが未設定なら、計量は受けない**（残量を出せない）。使用量だけで管理はできる
- 操作は1件ずつのAPI（`/api/filament/spools/{id}/usage`・`/weigh` など）で、応答は常に最新の一覧。
  日付は端末の時計ではなく応答の `today`（JST）を使う
- **保存する操作は必ず `filament._update()` を通す**（自動レビューで指摘された lost update・#445）。
  スプール全部が1行のJSONに入っているので、**別のスプールへの操作同士でも**、読み込みから書き戻しの
  間に割り込まれると片方が消える（`_load` → 加工 → `_write` と個別に呼ぶ形は禁止）。DB_MOCK は
  `atomic_json.update_json`、本番は行ロック（`SELECT ... FOR UPDATE`）とプロセス内ロックで囲む。
  入力の誤りで例外を投げるときは `rollback()` して行ロックを放す（残すと次の更新が止まる）。
  テストは `tests/test_filament.py` の「並行する更新」。窓を広げるためロックの内側の `_new_id` を
  遅くしてあり、無ロックの実装だと3件とも落ちる。**SQLite では `FOR UPDATE` が無視される**ので、
  行ロックそのものはテストできていない（SQL文の生成をMySQL方言で確認しただけ）
- **入口はプリンターカードの残量欄だけ。** カードを増やしていないので `LIFE_CARDS` と暮らしの
  並び順設定は触っていない。プリンターがオフラインでも残量は出す（在庫はアプリの中の記録）

## 消費電力の「指定日以降の再取得」はサブPCの収集に依頼を渡す（#711）

**VPSのバックエンドはプラグ・エアコンのクラウドへ届かない**ので、画面から押しても
バックエンドが取り直すことはできない。`backend/energy_refetch.py` が `app_settings` の
`energy_refetch`（`requested_at`・`since`・取得元ごとの `done`）を持ち、収集が定期実行のたびに
`GET /api/energy/refetch/request` で拾う（Tapoの候補更新・#692 と同じ形）。DDLは要らない。

- **完了報告は `requested_at` を添える。** 取得中に新しい依頼が入っても、古い依頼の完了で
  新しい依頼を済みにしないため（`mark_done()` は現在の依頼と一致するときだけ印を付ける）
- **収集向けの2口（`/request`・`/done`）は収集専用トークン `COLLECTOR_API_KEY` の Bearer が必須**（#714。
  #711 の承認済み計画の「認証なし（#249と同じ）」から変えた点）。未認証でも `requested_at` を読めて
  完了報告を偽造できる、という #712 のレビュー指摘への対応。**既存の `INTERNAL_API_KEY`（読み取り）・
  `INTERNAL_CONTROL_API_KEY`（操作）は流用せず、どちらでも通らない**（用途を広げない）。未設定は無認証へ
  落とさず503、値の違いは401。書けるのは完了印だけで、依頼を立てられるのはユーザーJWTの
  `POST /api/energy/refetch` だけ
- **`/api/energy` 本体・`/api/sensor`・`/api/bambu/state` などの既存の収集受け口は無認証のまま**（#249）。
  棚卸しの結果、これらは「データを書き足す」だけで、今回のような「他者の保留中の操作を完了扱いにして
  止める」ことができない。**段階移行**とし、一括で認証を足さない（サブPCの全収集の設定変更が要り、
  通常収集を止めるリスクが大きい）。足すなら `COLLECTOR_API_KEY` を同じ依存で使えるが、
  受け口ごとに別Issueで決める
- **トークンはサブPCの `collectors/.env`（`COLLECTOR_API_KEY`）とVPSの `.env`（デプロイが同期）に同じ値を置く。**
  発行・更新・失効は `collectors/README.md` の「収集専用トークン」。収集側は未設定のとき再取得の確認を
  見送り、通常の収集は続ける（WARNINGに残る）
- **Tapoの完了は「全台読めたとき」だが、`TAPO_HOSTS` に残った古いIPは数えない**（#728）。
  Tapoアプリでプラグを改名すると `merge_hosts()` が名前で新しいIPへ付け替えられず、旧IPが手書きの
  まま残る（「サブPC」→「PC」で実際に発生）。読めず・その回の探索でも見つからない手書きIPは
  `stale_manual_hosts()` が除き、WARNING で `TAPO_HOSTS` から外すよう促す。探索が0台なら判断しない
- **依頼中の重ね押しは409で断る。** 受け付けると待ちが延び、完了済みの取得元がやり直しになる
- 遡れる日数は `MAX_DAYS_BY_KIND`（Tapo 92日・エアコン31日）。収集側の定数
  （`tapo_to_myroom.MAX_DAYS`・`aircon_energy_to_myroom.REFETCH_MAX_DAYS`）と揃えること
- 反映の遅れは timer の間隔どおり（エアコンは最大1時間）。依頼の期限は90分（`REQUEST_TIMEOUT`）

## 収集スクリプトの再送信を時系列データのポーリングに使う（電気代・時間ごと表示）

**「時間ごと」のような、より細かい粒度の表示が要るとき、収集スクリプト自体を変更しなくてよい
ことがある。** `collectors/aircon_energy_to_myroom.py` は1時間ごと、`collectors/tapo_to_myroom.py`
は5分ごとに systemd timer から実行され、そのたびに「当日ぶんの累計」を `/api/energy` へ
POST し直している（`daily_energy` は同じ `(date, source)` を上書きする設計のため）。
この**受信そのものがすでに一定間隔のポーリングになっている**ので、時間ごと表示（#300）は
収集スクリプトを変えず、バックエンド側で受信のたびに「その時点までの当日累計」を
追記専用の新テーブル（`energy_readings`）へ書き足すだけで実現できた
（`backend/energy.py` の `upsert_records(..., now=...)`）。時間帯ごとの使用量は隣接する
スナップショットの差分から出す（`build_hourly`）。

- **収集頻度がそのまま得られる時間粒度の上限になる。** エアコン側は1時間おきの受信なので、
  「◯時台の使用量」はポーリング時刻に依存する近似値になる。秒単位の正確さが要るなら
  収集頻度そのものを上げる必要がある
- **過去分は遡れない。** この方式は「受信を記録し始めた時点から先」のログしか作れない。
  機能をリリースする前の日は時間ごとのデータが存在しないため、無ければ「記録がありません」と
  出す（過去分を埋め直す移行スクリプトは書かない）
- 同じ考え方が使える場面: 取得元がすでに周期実行されていて、かつ「今の値」だけでなく
  「時間の推移」を新しく見せたいとき。逆に、取得元の実行頻度が要求粒度より粗い場合
  （例: 1日1回しか叩けない外部APIから時間ごとを作りたい場合）は使えない

## 保存していない「疑似 source」を集計のたびに組み立てる（消費電力の「その他」）

**消費電力の「その他」（KEPCO実測 − 機器の実測）は、どのテーブルにも保存していない。**
`kepco_hourly_usage`（時間ごとの実測）だけを持ち、差分は `backend/energy.py` の
`build_hourly`（時間ごと・#302）と `build_breakdown`（日別・#319）が算出のたびに組み立てる。
**日別のために日別テーブルを足す必要はない**——`_fetch_kepco_daily()` が同じ器を
`SUM(kwh) GROUP BY date` で引くだけで済む（マイグレーションが1行も要らない）。

- **フロントで「その一覧に無い取得元」が落ちないかを確かめる。** 積み上げの組み立ては
  `buildEnergyStackSegments`（日別）と `buildEnergyHourlyColumns`（時間ごと）の2か所にあり、
  **`breakdown.sources`（機器の一覧）を起点に回すと疑似 source は黙って消える。**
  `by_source` のキーを起点にし、`sources` に無いものを後ろへ回す形にすること（#319）
- **疑似 source を `sources` へ足さないこと。** あの一覧は押すと `/api/energy/summary?source=…`
  で機器ごとの推移が開くボタンで、`daily_energy` に行が無い「その他」は必ず空になる。
  代わりに一覧の下へ「その他 = …」の注記を出す（`KepcoOtherNote`）
- **期間合計（今月・先月）には混ぜない。** KEPCOのCSVは直近1か月強しか落とせないため、
  混ぜると取り込んだ範囲によって「先月」の金額が動く。**タイルの合計と日別行の合計は
  一致しない**が、これは意図した状態

## 取得元の表示名は「別名」で持ち、`source` は変えない（消費電力）

**`daily_energy` の主キーは `(date, source)` で、`source` そのものが表示名の出どころ**
（`tapo:冷蔵庫` → `冷蔵庫`）。スマートプラグの名前はTapoアプリで付けたものが
`collectors/tapo_to_myroom.py` の `device.alias` 経由でここに入っている。
`TAPO_HOSTS` に `192.168.2.21=冷蔵庫` と書いた場合も、Tapo 側の alias が同じなら
探索結果の新しい IP を使い、表示名は `冷蔵庫` のまま保つ。
**名前を変えたいときに `source` を書き換えないこと**——`(date, source)` が別物になり、
過去の使用量・時間ごとの記録（`energy_readings`）と切れる。

- 別名は `app_settings` の `energy_source_names`（`{"tapo:冷蔵庫": "キッチンの冷蔵庫"}`）に
  持つ（#335）。**マイグレーションは1行も要らない**
- **ラベルを決める関数は2つに分ける。** `energy.source_label()` は既定の名前（`source` から
  導ける純関数）、`energy.resolve_source_label(source, overrides)` が別名を優先する。
  `build_breakdown` は `label`（別名を当てたあと）と `default_label`（当てる前）の両方を返す。
  設定画面が「Tapoの名前」を出すのと、上書き中かどうかの判定に `default_label` を使う
- **画面の入口は消費電力の詳細パネルのヘッダー1か所。** 消費電力カードはカード全体が詳細を
  開くボタンなので、カード見出しの中に `SettingsIconButton` を置けない
- **Tapo側で名前を変えると新しい取得元として現れる。** 別名は付け直しになる（記録は
  古い `source` に残り、繋がらない）。アプリ側で名前を変える経路を用意してあるのはこのため

## 掃除記録の「掃除した日」と「登録した日時」

**実施履歴の1件は `{"date": "掃除した日", "recorded_at": "アプリへ登録した日時"}` で、この2つは
別の値**（#294）。当日に押し忘れて翌日に前日ぶんを登録できるようにするための分けかたで、
**最終掃除日・次にやる日・一覧・履歴の表示はすべて `date` を見る。** `recorded_at` は
「いつ入力したか」を後から辿るためだけに持ち、古い記録では `null` になる。

- **未来の日付は `backend/main.py` の `_parse_cleaning_done_date()` が400で弾く。**
  `_normalize_history()` も未来日を落とすが、そちらに任せると「押したのに履歴が増えない」に
  見えるだけで理由が返らない
- **日付は文字列のまま扱い、`new Date(...)` で解釈し直さない。** フロントは
  `frontend/lib/cleaning.ts` の `shiftDate()`（UTC正午で数える）を使い、`recorded_at` の表示は
  サーバーが返したJSTの文字列を `T` で切って組み立てる。端末の時計で解釈すると1日ずれる
- 日付を間違えて登録したときの直し方は `DELETE /api/cleaning/tasks/{id}/done/{date}` で1件消して
  入れ直す形だけ。履歴を直接書き換える口は作らない（`recorded_at` が実態とずれるため）

## Notionへの書き出し（ゴミの収集日・掃除）

**日付プロパティに時刻を入れると、dayspan のカレンダーはその時刻の位置に出す。** 終日エリアと
時間グリッドの振り分けは時刻の有無だけで決まる（dayspan#483）。ゴミの収集日は
`backend/garbage_notion.py` が `data/garbage.json` の `collection_time`（既定 08:30）を足して
`2026-09-01T08:30:00+09:00` の形で書く（#296）。**オフセットを省かないこと**——省くと Notion 側が
閲覧者のタイムゾーンで解釈する。

- **照合キーは日付だけに保ち、時刻の差は「更新」で直す。** キーへ時刻まで入れると、収集時刻を
  変えたときに同じ日のページがアーカイブ＋再作成になり、Notion 側の並びが入れ替わる。
  `parse_page()` は照合用の `date`（`[:10]`）と、書かれたままの `start` を両方返し、
  `plan_changes()` が `start` の差を更新の理由として拾う。**この形なら、時刻を書くようになる前の
  ページも次の同期で自動的に直る**（移行スクリプトも手作業も要らない）
- **日付プロパティの値を文字列のまま比べないこと。** Notion が返す値は書き込んだ文字列と
  1バイトずつ同じとは限らず（ミリ秒が付く・オフセットの書き方が変わる）、文字列比較にすると
  毎回「変わった」と判定して同期のたびに全件を更新してしまう。`datetime.fromisoformat()` に
  通して同じ時点かで比べる（`garbage_notion._same_instant()`）
- 掃除の書き出し（`backend/cleaning_notion.py`）は別モジュールで、いまは日付のみを書いている。
  同じ扱いにするなら両方を直す必要がある

## data/ 配下のファイルはデプロイで上書きされる

**`deploy.yml` の rsync は `data` を除外していない。** リポジトリに含まれる
`data/*.json`（`remote.json`・`garbage.json` など）は、デプロイのたびに**リポジトリの中身で
本番が上書きされる**。

- **利用者が画面から書き換えるものを `data/` に置かない。** 書けたように見えても次のデプロイで消える
  （#262。`data/remote.json` は `"groups": []` のままリポジトリにあり、本番の「電気の操作」カードが
  ずっと未設定だった）。画面から書き換える値は `app_settings`（DB）へ置く
- `data/` に残してよいのは、**リポジトリが正の初期値・定義**だけ。読む側は「DBに保存済みなら
  そちらを使い、まだ無ければファイルを読む」の形にして、保存済みかどうかを区別できるようにする
  （空の保存とファイル未保存を同じ扱いにすると、画面から消したものがデプロイで復活する）
- **手で書くファイルの時刻値を `datetime.time.fromisoformat()` で受けないこと。** 時は0詰め必須で、
  `"9:15"` は `ValueError` になる（`"08:30"` は通るので、既定値だけを試すと気付かない）。
  `":"` で割って `int()` する形にして、`f"{hour:02d}:{minute:02d}"` へ揃えて持つ
  （#270 の `collection_time`）

## data/*.json への読み書きは atomic_json を使う（複数プロセスが読み→加工→書き戻しする場合）

**`open(path, "w")` してから `json.dump` するだけの書き込みは、書き込み中にプロセスが落ちる
（`pm2 restart` は毎回起きる）と壊れたJSONを残し、複数経路の書き込みが競合すると片方の更新を
消し飛ばす**（#382）。`backend/push_subscriptions.py` の購読情報は、バックエンド本体（同期
ハンドラなのでスレッドプールで並行）と別プロセスの `backend.sensor_monitor`（10分ごと）の
両方が読み→加工→書き戻しで更新するため、この問題を実際に踏む経路になっていた。

`backend/atomic_json.py` の `read_json()` / `write_json()` / `update_json()` を使うと解決する。

- **アトミック**: 書き込みは同ディレクトリへの一時ファイル + `os.replace()` で行う。途中で
  落ちても既存ファイルはそのまま残る
- **排他**: 対象パスごとの `threading.Lock`（同一プロセス内の並行リクエスト用）と、専用の
  `.lock` ファイルへの `fcntl.flock`（別プロセスとの排他用）の両方で読み→加工→書き戻しの
  一連の操作を囲む。**ロックは対象ファイル自体ではなく専用の `.lock` ファイルに取ること**
  ——対象ファイルは `os.replace()` で差し替わり inode が変わるため、対象ファイル自体に
  `flock` すると「別プロセスが古い inode をロックしたまま古い内容を読む」という取り違えが起きる
- **read-modify-write は `update_json(path, default, mutate)` を使う。** `read_json()` →
  加工 → `write_json()` と個別に呼ぶと、その間に別プロセスが割り込んで更新を消し飛ばす余地が
  残る。`mutate` に現在の内容を受け取って書き戻す内容を返す関数を渡すと、読み込みから書き戻し
  までが1つのロックに収まる（`push_subscriptions.py` の `upsert_subscription()` 等がこの形）
- **`.lock` ファイルは対象の `data/*.json` と同じ命名で `.gitignore` へ追記すること**
  （`data/push_subscriptions.json.lock` のように）。追記を忘れると次のデプロイでリポジトリの
  中身が本番のロックファイルを消しはしないが、コミット候補に紛れ込む
- **他の `data/*.json` 書き込み（`aircon_config.py`・`cleaning.py`・`device_config.py`・
  `garbage_notion.py`・`garbage_notify.py`・`outdoor_config.py`・`sensor_monitor.py`・
  `ui_settings.py` 等）は、このIssueでは対象にしていない。** 同じ非アトミック・排他なしの
  書き方が残っているが、#382 の指摘は「壊れても再通知で済む」ものは対象外としている。同種の
  問題を踏んだ／踏みそうな箇所を直すときは、このモジュールへの移行で解決できる

## デプロイの値の取得先

**ワークフローは実行時に1Passwordを呼ばない。** 以前は実行のたびに `1password/load-secrets-action`
で読んでいたが、1Passwordサービスアカウントの日次レート制限（**1Passwordアカウント全体で
1,000リクエスト/日**。サービスアカウントを分けても分割されない）を使い切り、フリート全体の
デプロイが止まった（guchi-apps/issue-deck#1302・#1307）。実行時の取得先はGitHubの
secret / variable で、1Passwordは「人が管理する唯一の正」として残す。

**どの値をGitHubのどこから取るかの正は `.github/secrets-manifest.tsv`。**
`SCOPE` が `inherit` の行はorganizationの共通値（このリポジトリでは同期しない）、
`repo` の行はこのリポジトリのsecret。

- **デプロイで使う値を増やすときは、まずマニフェストに行を足す。**
  `deploy.yml` の `env:` ブロックは `scripts/generate-workflow-env-block.sh` で生成する。
  ワークフローに直接書き足すとマニフェストと食い違う
- **順序は「値の投入 → ワークフロー切り替え」。** 投入前にワークフローを切り替えるとデプロイが失敗する
- 1Password側の値を変えたときだけGitHubへ同期する（デプロイのたびには実行しない）。
  `sync-secrets.yml` を `workflow_dispatch` で起こすか、手元で `scripts/sync-github-secrets.sh` を実行する。
  **後者は個人アカウントのセッションが必要**（サービスアカウントではGitHubへ書き込めない）
- `OP_SERVICE_ACCOUNT_TOKEN` のrepository secretは残してある。使うのは上記の同期のときだけで、
  デプロイでは使わない
- **secretの値は必ず1行に収める。** `deploy.yml`の`sync_env_var`は`printf '%s=%s\n'`で本番の
  `.env`へ書くため、改行を含む値（PEM・秘密鍵・JSON）を入れると`.env`の書式そのものが壊れ、
  python-dotenvが2行目以降を**別のキー**として読む（#337でVAPID秘密鍵に実際に該当した）。
  複数行になる値は、base64などの1行の表現に直してから1Passwordへ入れること
- **`provision-secret.sh --from-stdin` へ値をパイプで渡さない。** 必ずファイルへ書いて
  `< ファイル` でリダイレクトする（#343）。スクリプトは値を読んだあともstdinをそのまま
  引き継ぎ、`op item edit` / `op item create` は**stdinがパイプだと中身をJSONのアイテム
  テンプレートとして読む**ため、空になったパイプで`op: [ERROR] invalid JSON provided`と
  なって落ちる。**このときスクリプトは「トークンに write_items があるかを疑ってください」と
  出すが、権限とは無関係**（`op whoami`は通る）。通常ファイル・端末・`/dev/null`がstdinなら
  opはこの解釈をしない。手順は`README.md`の「VAPID 鍵の初回登録」を参照

## デプロイ後のヘルスチェック

`deploy.yml` の `Restart Backend Service` は `pm2 save` のあとに
`http://127.0.0.1:8000/api/health` を **2秒間隔・最大30回（60秒）** 叩き、成功したら `exit 0`、
60秒たっても成功しなければ `pm2 describe` / `pm2 logs` を出して `exit 1` する。
**固定の `sleep` 1回に戻さないこと**（起動が間に合わないだけで赤くなる／即死していても緑で終わる。#205）。

**このステップのヒアドキュメントは `<< EOF`（クォート無し）。** リモートで評価してほしい
`$` はすべて `\$` でエスケープする。忘れるとGitHub Actionsのランナー側で展開され、
リモートには展開済みの文字列が渡る（`\$(seq 1 30)` を素で書くとループが壊れる）。

**リモートが実際に受け取る文字列は、ローカルで確認できる。** `run:` を取り出して
`ssh ... bash -s <<` を `cat <<` へ差し替えて実行すれば、展開後のスクリプトがそのまま出る。
`bash -n` に通せば構文も確認できる。

## 本番デプロイが起動しないとき

**mainへマージしたのに「Deploy to Production」が1件も作られないことがある。** 実測で
`deploy.yml`導入後のmainへのマージ55件中1件（#315のv4.8.0）。原因はGitHub側のイベント
取りこぼしで、**このリポジトリの設定では直せない**（設定で決められるのは「届いたイベントに
どう反応するか」だけで、今回はイベント自体が届いていない）。

- **見分け方はマージコミットのcheck-suiteが0件かどうか。** 正常時はマージの2〜5秒後に2件
  作られる。0件なら、そのpushに対してGitHubがワークフローを1つも作っていない。**`push`
  だけが落ちるのではなく、`issue-labels.yml`の`pull_request(closed)`も同時に落ちる**ので、
  トリガーを書き足しても救えない

  ```bash
  gh api repos/guchi-apps/myroom/commits/<マージコミット>/check-suites --jq .total_count
  ```

- **`.github/workflows/deploy-watchdog.yml`が拾って起動し直す。** mainのHEADの**tree**と
  `deploy.yml`直近成功実行のtreeを比べ、一致するものが無ければ`deploy.yml`を`--ref main`で
  起動する。**`schedule`だけには頼れない**——このリポジトリの`*/15`は実測で1日5〜8回しか
  起動していない（期待96回）。そのため`workflow_run`（`CI`・`Issue Progress`の完了）にも
  相乗りさせている
- **手で起動するときは必ず`--ref main`にする。** リリースブランチのref（例:
  `release-main/v4.8.0`）から起動すると`deploy.yml`の`tag`ジョブが`v<version>`をmain上に
  無いコミットへ付けてしまい、**以後mainから起動したデプロイはタグ検証で必ず失敗する**
  （`Tag v4.8.0 already exists on ...`で`tag`がexit 1し、`deploy`はskipされる。#315で実際に
  起きた。次のバージョンへ上がるまで解消しない）

  ```bash
  gh workflow run deploy.yml --repo guchi-apps/myroom --ref main
  ```

- `deploy-retry.yml`は**起動したデプロイが失敗したとき**に1回だけ再実行する仕組みで、
  **そもそも起動しなかったとき**には何もしない。役割が違うので混同しない

## マルチエージェント運用（GitHub Actions 無人実行）

`@claude` コメントを起点に、計画提示〜実装〜develop向けPR作成までを GitHub Actions 上で無人実行する。
ワークフローの実体は `guchi-apps/issue-deck` にあり、このリポジトリの `.github/workflows/` には
`uses:` で参照する薄い caller だけを置いている（タグは全 caller で揃える。具体的な版はここに書かず、`.github/workflows/*.yml` の既存の caller と同じタグにする。版を上げたら `prompts-ref` も同じ版に揃える）。

| ファイル | 役割 |
|---|---|
| `claude-issue-dispatch.yml` | `@claude` 起点の無人実行（計画提示・実装・PR作成・質問応答） |
| `issue-labels.yml` | Issueの進捗（Project Status）の状態遷移 |
| `claude-conflict-resolve.yml` | develop向けPRが `develop` とコンフリクトした際の無人解消 |

### 無人実行で使える環境

**`claude-issue-dispatch.yml` は `runtime-setup: minimal` を指定している。** 準備ステップは全てリポジトリルートで動くが、
ルートに実質の依存が無いため意味が無い。**依存のインストールは実装エージェント自身が行う。**

- フロントエンドを触るなら `cd frontend && npm ci`
- バックエンドを触るなら `pip install -r requirements-dev.txt`

`claude-conflict-resolve.yml` だけは `runtime-setup: node` + `install-dependencies: false` にしている
（CI と同じ Node 20 のセットアップだけ行い、意味の無いルートでの `npm ci` は行わない）。
こちらも依存のインストールはエージェント自身が `cd frontend && npm ci` から始める。

**Python のバージョンは固定されない。** CI は `setup-python` で 3.11 に固定しているが、
共有ワークフローに Python のプリセットは無く、実装ステップは**ランナー標準の Python** を使う。
バージョン依存の挙動に当たった場合は、無理に回避せず `00.check-user` を付けて相談すること。

**`24.screenshot-required` は無人実行では成立しない。** `minimal` のため Playwright が
インストールされない。ローカル実行でのみ意味を持つラベルとして扱う。

設計・運用の詳細は issue-deck 側を参照する。

- 進捗管理の設計: [progress-status-architecture.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/progress-status-architecture.md)
- 無人実行の挙動: [multi-agent/dispatch.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/dispatch.md)

**`/install-github-app` を実行しないこと。** 生成される素の `claude.yml` は
`claude-issue-dispatch.yml` と同じ `issue_comment` イベントで起動するため、1つのコメントで
Claude が二重に走る（`subscription-lists` で実際に起きた）。

### `.shared-context/` と `.shared-prompts/`

無人実行のたびにワークツリーへcheckoutされる**リポジトリ管理外**のディレクトリ。
`.gitignore` 済み。**編集・`git add`・コミットを一切行わないこと。**

## ブランチ運用

- `main` は本番と一致するリリース用ブランチ。直接pushは禁止し、`develop` → `main` のPRのみで進める
- `develop` が日常の開発ブランチ。**デフォルトブランチは `develop`**（`issues`・`issue_comment`
  イベントはデフォルトブランチのワークフローしか起動しないため、変更すると無人実行が動かなくなる）
- Issue専用ブランチは `develop` から作成し、ブランチ名は **`issue-<Issue番号>`** とする（例: `issue-111`）。
  ワークフローはブランチ名から対象Issueを特定するため、**この命名規約に従わないブランチはすべて対象外**になる

## Issueの進捗

**進捗は GitHub Projects の Status で管理する。進捗ラベルは存在しない**
（issue-deck#1010 / #991 Phase 5 で `01.wip`〜`09.main` を廃止した）。

1. `Ready` — 未着手
2. `Planning` — 計画検討中（`21.plan-required` 選択時のみ経由）
3. `Implementation` — 実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。この時点でissueをcloseする

**`gh issue edit` で進捗を進めることはできない。** Status を書けるのは issue-deck だけで、
ワークフローは進捗報告API（`POST /api/progress`）へ報告する。ブランチのpush・PR作成・PRマージを
トリガーに自動で遷移するため、エージェントが自分で進捗を動かす必要はない。

## 条件を表すラベル（進捗とは別軸）

| ラベル | 意味 |
|---|---|
| `00.check-user` | ユーザーの確認・指示が必要。どの段階でも併用する |
| `00.qa-answered` | 質問への回答のみ完了（`00.check-user` と常に併用） |
| `11.local` | ローカル（VSCode等）で対応中。付いている間は無人実行を起動しない |
| `21.plan-required` | 実装前に計画を提示し承認を得る |
| `22.merge-confirm-required` | 内容によらず、developへのマージ前に必ず `00.check-user` を付ける |
| `23.preview-required` | PR作成前に開発サーバーでの画面確認を必須にする |
| `24.screenshot-required` | PR作成前にスクリーンショット取得を必須にする（**無人実行では成立しない**） |

## 自動マージ不可カテゴリ

以下に該当する変更は自動マージせず `00.check-user` を付与してユーザーの確認を待つ。

- 認証・認可
- DBスキーマ変更・マイグレーション（`init_db.py`・`migrate_db.py`）
- 本番環境の設定（`deployment/`・`ecosystem.config.js`）
- GitHub Actionsやデプロイ設定（`.github/workflows/**`）
- Secretsや環境変数（`.github/secrets-manifest.tsv`・1Password関連）
- 大規模な依存関係の更新（`requirements.txt`・`frontend/package.json`）
- `develop` → `main` のマージ

## 実装エージェントの禁止事項

- `main` / `develop` への直接コミット・push
- 他Issueのブランチの編集
- 不要なforce push
- 自分が作成したPull Requestの自己マージ
- `.shared-context/` / `.shared-prompts/` の編集・コミット

## コミット・PR・コメントの書き方

- コミットメッセージ・PRタイトル・PR本文・issueコメントは**日本語**で書く
- コミットの author は `Claude Code <claude-code@example.com>` にする
- `develop` 宛のPR本文には、対応Issue・実装内容・テスト内容・確認方法・注意点を記載する。
  developマージ時点ではissueをcloseしない運用のため、`closes #番号` / `fixes #番号` は使わず
  `#番号` のみ記載する

## 依存関係の追加

新しい依存関係（`requirements.txt`・`frontend/package.json` のいずれも）を追加する前には、
必ずユーザーに確認を取る。無人実行では確認相手がいないため、追加が必要だと判断した場合は
追加せずに作業を止め、`00.check-user` を付与したうえでなぜ必要かをIssueコメントで相談する。
