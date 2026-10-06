# kurashio

部屋の環境データ（温度、湿度、気圧、CO2、照度など）を可視化するアプリケーションです。ログイン後にダッシュボードで履歴グラフ・センサー一覧・記録を確認でき、Raspberry Pi からセンサー／エアコンデータを POST できます。

- **バックエンド**: FastAPI (Python)
- **フロントエンド**: Next.js (React + TypeScript + Tailwind CSS + shadcn/ui)
- **本番配信**: Next.js を静的エクスポート (`frontend/out`) し、FastAPI が API と静的ファイルの両方を配信

## プロジェクト構成

```
myroom/
├── backend/           # FastAPI API
├── frontend/          # Next.js UI（開発: port 5173）
├── data/              # 実行時設定（gitignore 対象）
│   ├── devices.json           # デバイス表示名
│   └── outdoor_location.json  # 屋外地点
├── scripts/           # 開発用起動スクリプト
├── collectors/        # サブPCで動かす収集スクリプト＋systemdユニット
└── migrate_db.py      # DB スキーマ更新
```

## 開発環境の起動方法

### 前提条件

以下のツールがインストールされていることを確認してください。

- Python 3.x
- Node.js **20.9 以上** (および npm)

初回のみ Python 依存関係をインストールします（**Streamlit は含みません**。Next.js + FastAPI の開発に必要なものだけです）。

```bash
cd /home/guchi/apps/myroom
python3 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

初回のみ、ルートに `.env` を用意してください（DB接続情報・パスワードなど）。  
起動スクリプトは **環境変数 `DB_MOCK` でモードを上書き**するため、`.env` の `DB_MOCK` 値を毎回書き換える必要はありません。

### まとめて起動（推奨）

プロジェクトルートで、どちらか **1コマンド** を実行します。バックエンド・フロントエンドを同時に起動し、Ctrl+C でまとめて停止できます。

| モード | コマンド | データ |
|--------|----------|--------|
| **開発データ（モック）** | `./scripts/start.sh mock` | ダミーデータ（DB・SSH不要） |
| **本番データ** | `./scripts/start.sh prod` | 本番MySQL（SSHトンネル自動起動） |

停止のみ行う場合:

```bash
./scripts/stop.sh
```

起動後はブラウザで **http://localhost:5173** を開いてください（API: http://localhost:8000/docs）。

#### 開発データ（モック）で起動

```bash
chmod +x scripts/*.sh scripts/lib/*.sh   # 初回のみ
./scripts/start.sh mock
```

- `DB_MOCK=true`（DB接続なし）
- UIの動作確認向け

同等: `./scripts/start-mock.sh`

#### 本番データで起動

```bash
./scripts/start.sh prod
```

- `DB_MOCK=false`
- SSHトンネル（ローカル 3307 → 本番 3306）を自動起動
- `check_db.py` で接続確認後にバックエンド・フロントエンドを起動
- `.env` の `DB_HOST` / `DB_PORT`（例: `127.0.0.1:3307`）がトンネル先と一致していること

同等: `./scripts/start-prod-db.sh`

SSHトンネルだけ別ターミナルで維持したい場合:

```bash
./scripts/start_tunnel.sh
```

### スマホなど同一 LAN の端末から見る場合

開発サーバー自体は起動時から `0.0.0.0` で待ち受けていますが、WSL2 は既定で Windows とは別ネットワーク（NAT）のため、そのままでは同じ Wi-Fi 上のスマホから届きません。`./scripts/start.sh` 実行時に Windows 側のポート転送を自動設定します（**管理者権限の確認（UAC）が毎回表示されます**）。

表示される `http://<WindowsのIPアドレス>.sslip.io:5173` にスマホからアクセスできます。UAC をキャンセルしてもバックエンド・フロントエンドの起動自体は継続します（スマホからのアクセスのみ不可）。

- **Google ログインを試す場合は sslip.io 経由の URL を使う**: Supabase Auth（GoTrue）は `redirectTo` のホスト名が生の IP アドレスだと、Redirect URLs にどう登録してもログインが無条件で失敗する仕様がある。`<IP>.sslip.io` は DNS 解決すると同じ IP を返すワイルドカード DNS のため、TCP 接続は変わらず LAN 内で完結する
- 開発用 Supabase プロジェクトの Authentication → URL Configuration → Redirect URLs に `http://<WindowsのIPアドレス>.sslip.io:5173/auth/callback` を**完全一致**で登録しておく（ポート部分を `*` にしたパターンと混在させると許可リスト全体が効かなくなることがあるため避ける）

WSL を再起動すると WSL 側の IP が変わり転送が切れます。次回 `./scripts/start.sh` 実行時に自動で更新されますが、サーバーを再起動せず再設定だけしたい場合は単独で実行できます。

```bash
./scripts/expose-lan.sh
```

### 手動で起動する場合

#### 1. 環境設定 (.env)

- **モックモード**: `DB_MOCK=true` — ダミーデータ
- **本番データモード**: `DB_MOCK=false` — 本番DB（要SSHトンネル）

本番データ利用時は別ターミナルで `./scripts/start_tunnel.sh` を実行し、接続確認:

```bash
source venv/bin/activate
python3 check_db.py
```

#### 2. バックエンド (Python / FastAPI)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

#### 3. フロントエンド (Next.js)

Google 認証を使う場合、初回のみ `frontend/.env.local` を作成してください（`.gitignore` 対象。ローカル開発用の値は自動同期されないため、1Password アプリから直接コピーします）。

```bash
# frontend/.env.local
NEXT_PUBLIC_SUPABASE_URL=<1Password「Supabase」アイテムの dev-project-url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<同 dev-publishable-key>
```

**バックエンド起動後**に:

```bash
cd frontend
npm install
npm run dev
```

- UI: http://localhost:5173
- 開発時は `/api` が FastAPI (`localhost:8000`) にプロキシされます

## 自動テスト

GitHub への push / PR 前に、次のコマンドで CI と同等のチェックを実行できます。

```bash
chmod +x scripts/test.sh   # 初回のみ
./scripts/test.sh
```

個別に実行する場合:

```bash
# バックエンド（pytest、DB_MOCK=true・外部APIなし）
source venv/bin/activate
pip install -r requirements-dev.txt
pytest tests/ -q

# フロントエンド
cd frontend
npm run typecheck
npm run test          # Vitest（chart-utils 等）
npm run build
```

### テスト内容

| 対象 | 内容 |
|------|------|
| `tests/test_api.py` | API エンドポイント（health、latest、history、sensor、devices、屋外地点、サーバー間参照用の内部API） |
| `tests/test_config.py` | デバイス名・屋外地点の設定ファイル読み書き |
| `frontend/lib/chart-utils.test.ts` | グラフ計算・快適度・履歴マージのユニットテスト |

`main` / `develop` 向け PR と `develop` への push では [`.github/workflows/ci.yml`](.github/workflows/ci.yml) が自動実行されます（`main` への直接 push では CI は走りません）。`main` への push 時はデプロイ（[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)）のみ実行されます。

### ブランチとデプロイ

| ブランチ | 役割 | デプロイ先 |
|----------|------|------------|
| `develop` | 開発 | なし（ローカル） |
| `main` | 本番 | https://myroom.gucchii.com/ |

**マージの流れ**: `develop` → `main`

## システム仕様

### 画面構成

SwitchBot 風のスマートホーム UI をベースに、スマホ向け（最大幅 480px）のライト／ダークテーマで構成しています。
ホーム画面だけは PC（1024px 以上）で最大 1040px まで広がり、2カラムになります。

朝いちばんに知りたい予定を先頭に置き、時系列グラフは掘り下げる情報として下へ回しています。

1. **暮らし（1列）** — 電気の操作・ゴミの日・消費電力・掃除など、推移グラフの凡例を持たないカード
2. **センサー（2列グリッド・PCでは3列）** — 屋内デバイス / 屋外 / エアコン。カードタップでデバイス詳細（グラフ・記録一覧）
3. **推移（履歴グラフ）** — 指標タブ（温度・湿度・気圧・CO2・照度）で切り替え。スマホではグラフ上と画面下部の固定バーの両方から操作可能
4. **最近の記録** — 日ごとの最高・最低値をバー表示
5. **近日公開** — これから作る機能の案内カード。押しても何も起きない
6. **表示設定** (`/devices`) — 表示順・表示名・色・ダッシュボード表示の管理

PC では 1〜6 のうち、左カラムに センサー・推移・最近の記録、右カラムに 暮らし・近日公開 が並びます。
最大幅は画面ごとに違うため `app/layout.tsx` では指定せず、各画面（`myroom-dashboard.tsx`・
`device-visibility-page.tsx`）が持ちます。

フォントは **Noto Sans JP**、カードは角丸 18〜20px です。

#### カードのセクション分け

カードの性質はこれから増えるほどバラバラになる（計測値・操作ボタン・予定・稼働履歴）ため、
置き場所を次のように決めています（`frontend/lib/dashboard-sections.ts`）。

- **センサー** — 時系列グラフを持つ計測値。2列グリッド（PCでは3列）。並び順は `display_order`（グラフ凡例と共通）で管理
- **暮らし** — 推移グラフの凡例を持たないもの（予定・操作、および日ごとの集計値）。
  1行あたりの情報量がカードごとに違うため1列で全幅。`display_order` には混ぜず、
  並びは `LIFE_CARDS` の定義順で固定。表示・非表示だけは共通の `hidden_devices`（表示設定ページ）で管理
- **近日公開** — まだ作っていない機能の案内。`COMING_SOON_CARDS` の定義順。カード単位ではなく
  セクションごと `COMING_SOON_SECTION_KEY` で表示・非表示を切り替える。実装が済んだカードは
  ここから消し、センサーか暮らしの本物のカードに置き換える

**表示・非表示のキーを増やしたら `buildAllDashboardTargetKeys` へ必ず登録すること**
（`frontend/lib/visible-devices.ts`）。`normalizeHiddenDeviceKeys` はこの集合に無いキーを
エラーにせず黙って捨てるため、登録し忘れると「オフにできるがリロードすると復活する」という
分かりにくい症状になる。バックエンド（`backend/ui_settings.py`）は任意の文字列を素通しするので、
API・DB側の変更は要らない。

### 単位と表示

| 項目 | 単位 | 表示 |
|------|------|------|
| 温度 | °C | 小数点第1位、青色 (`#3498db`) |
| 湿度 | % | 整数、緑色 (`#2ecc71`) |
| 気圧 | hPa | 整数、紫色 (`#9b59b6`) |
| CO2 | ppm | 整数、オレンジ (`#e67e22`) |
| 照度 | lx | 小数点第1位、黄色 (`#f1c40f`) |
| 電力使用量 | kWh | 小数点第1位、アンバー (`#f39c12`) |
| 電気代 | 円 | 整数（3桁区切り）。エアコンは取得元の実額、それ以外は単価を掛けた**目安** |

### 履歴グラフ

- **表示幅**: 日 / 週 / 月 / 年 を切り替え。左右ドラッグで表示期間を移動し、範囲外のデータを段階的に取得
- **指標切替**: 温度・湿度・気圧・CO2・照度タブ（スマホではグラフ上部＋画面下部固定バー）
- **屋内 / 屋外**: 屋内は実線、屋外（Open-Meteo）は点線。エアコンの室温・設定温度も個別に表示可能
- **DHT11 温度**: 防水温湿度計など `temperature_dht11` を別系列で表示可能
- **凡例**: 各系列の表示／非表示を切り替え（設定はセッションをまたいで保持）
- **Y軸**: 現在表示中の時間帯のデータに合わせて自動調整
- **年表示**: 日次集計（最高・最低を含む）。日・週・月は生データ（10分間隔等）
- **更新**: 30秒ごとの自動更新、手動更新ボタンあり。起動時は読み込み中表示

### デバイス管理

- **複数デバイス対応**: API の `device` クエリで `device_id` を指定（例: `?device=2`）
- **表示設定ページ** (`/devices`): 表示順のドラッグ並べ替え、表示名・グラフの色・ダッシュボード表示の ON/OFF。「暮らし」のカードは表示・非表示のみ
- **デバイス詳細**: センサーカードをタップ → そのデバイス（設置場所）のグラフと記録一覧。記録の個別削除・一括削除に対応
- **設置場所の継承**: 同じ場所でセンサーを交換した場合、`inherits_from` で過去データを連続表示。場所名は継承チェーン最古のデバイス名を使用
- **エアコン**: 室温と設定温度で色・ダッシュボード表示を個別に設定可能
- **表示名の保存**: UI 設定は DB（`ui_settings`）に永続化。デバイス名は `data/devices.json`（gitignore）にも反映

### 屋外データ

屋内センサーとは別に、[Open-Meteo](https://open-meteo.com/) から外気温・湿度・気圧を取得します。

- **最新値**: Forecast API（`/api/latest` 呼び出し時）
- **履歴**: 直近90日は Forecast API、それ以前は Archive API（1時間ごと）
- **地点の変更**: 屋外カードをタップ → 地名検索または緯度・経度を入力
- **保存先**: `data/outdoor_location.json`（gitignore 対象）
- **初期値**: `.env` の `OUTDOOR_LAT` / `OUTDOOR_LON` / `OUTDOOR_LOCATION_NAME`（未設定時: 茨木市付近）

### CO2 センサー（SwitchBot + Raspberry Pi）

SwitchBot Meter Pro (CO2) 等から **Raspberry Pi Zero W** 経由でデータを送信できます。

**本番 URL**

| 用途 | URL |
|------|-----|
| アプリ | https://myroom.gucchii.com/ |
| API（センサー POST） | https://myroom.gucchii.com/api/sensor |
| 死活監視 | https://myroom.gucchii.com/api/health |

```bash
# POST 例（温度・湿度・CO2 のみ。気圧は CO2 センサーでは省略可）
curl -X POST "https://myroom.gucchii.com/api/sensor?device=2" \
  -H "Content-Type: application/json" \
  -d '{"datetime":"2026-05-30 12:00:00","co2":600,"temperature":30.8,"humidity":31}'
```

- `temperature` / `humidity` / `pressure` / `co2` / `illuminance` / `temperature_dht11` の **いずれか1つ以上** が必須
- 複数デバイスは `device` クエリで区別（例: DHT=`1`、SwitchBot CO2=`2`）
- **SwitchBot 複数台**: Raspberry Pi の `sensors.json` に MAC と `device_id` を列挙（1回の BLE スキャンでまとめて POST）。新しい `device_id` は初回 POST で自動登録され、ダッシュボードにも自動表示
- CO2 値は UI のセンサーカードに ppm として表示

**Raspberry Pi 上のスクリプト・セットアップ手順**（WinSCP、SSH、BLE/`btmon`、systemd、トラブルシューティング）は  
[guchi-apps/pi0w_260719](https://github.com/guchi-apps/pi0w_260719) リポジトリに移管しました。`myroom-api/README.md` を参照してください。

### エアコン（白くまくんアプリ / AirCloud Home + Raspberry Pi）

日立ルームエアコン（白くまくんアプリ対応機）の状態を **AirCloud Home クラウド API** 経由で取得し、kurashio に送信できます。

**前提**

- 白くまくんアプリでアカウント登録・エアコン登録済み
- エアコンが Wi-Fi に接続済み
- Raspberry Pi（または cron 実行可能な Linux マシン）から HTTPS で kurashio API に到達できること

**本番 URL**

| 用途 | URL |
|------|-----|
| API（エアコン POST） | https://myroom.gucchii.com/api/aircon |
| API（最新状態 GET） | https://myroom.gucchii.com/api/aircon/latest |

```bash
# 5分ごとに取得・送信（Pi 上、myroom-api/ 配下）
python3 aircon_to_myroom.py

# 登録済みユニット一覧
python3 aircon_to_myroom.py --list-units

# 自動実行（systemd タイマー・5分間隔）
sudo ./install.sh
sudo systemctl start aircon-myroom.timer
```

Raspberry Pi 上のスクリプトは [guchi-apps/pi0w_260719](https://github.com/guchi-apps/pi0w_260719) リポジトリに移管しました。詳細は `myroom-api/README.md` を参照。

取得できる主な項目: 室温、設定温度、運転モード、電源 ON/OFF、風量・風向、オンライン状態など（詳細は下記参照）。
風量は `AUTO` / `LV1`〜`LV4`、風向は `VERTICAL`（振る）と `OFF`（固定）が実機で確認できた値です。

> **設定温度は自動運転のときだけ意味が変わる。**
> AirCloud Home は自動運転（eco を含む）のとき、設定温度として**温度そのものではなく室温からのシフト量**
> （おおむね -3.0〜+3.0、0 はシフトなし）を返す。つまり `target_temperature: 1.0` は「1℃」ではなく
> 「室温 +1.0℃」を意味する。固定の設定温度は 16〜32℃ の範囲にしかならないため、kurashio は絶対値が
> 5.0 以下かどうかで両者を切り分けている（`frontend/lib/types.ts` の `AIRCON_AUTO_TARGET_OFFSET_LIMIT`、
> `backend/main.py` の `_is_aircon_auto_target()`）。グラフでは自動運転の区間だけ
> 「室温 + シフト量」の位置に点線で描く。年グラフは日ごとの平均を出すため、シフト量と絶対温度は
> 平均できず、自動運転の区間を設定温度の平均から除外している。

#### 画面からの操作

ダッシュボードのエアコンカードをタップすると操作パネルが開き、電源・設定温度・運転モード・風量・
風向を変えられます（#213）。**バックエンドが AirCloud Home のクラウド API を直接呼びます**
（`backend/aircon_control.py`）。

**同じパネルは「暮らし」の「電気の操作」カードからも開けます**（#268）。入口が2つあるだけで、
開くパネルも操作の中身も同じです。「電気の操作」カードを非表示にしているとそちらの入口は消えるので、
どちらか片方に寄せたいときは表示設定（`/devices`）で切り替えます。

**動かすには白くまくんのログイン情報がバックエンドの `.env` に要ります。**

```bash
AIRCON_EMAIL=your@email.com
AIRCON_PASSWORD=your_password
```

未設定なら `GET /api/aircon/units` が `control_enabled: false` を返し、**画面は操作パネルの
入口ごと出しません**（表示だけの従来どおりの状態になります）。実値は 1Password の `apps/MyRoom`
から取ります。

> **AirCloud Home を叩くクライアントは3つある。** ラズパイ（運転状態の取り込み）、
> `collectors/`（日別の電気代）、`backend/aircon_control.py`（操作）です。前の2つは1回動いて
> 終わるスクリプトで毎回サインインしてよいのに対し、バックエンドは常駐するため、トークンを
> プロセス内で持ち回してロックで直列化しています。**リクエストのたびにサインインすると
> レート制限（429）に当たります。**

> **操作APIの形は公開されていない。** #213 で実機に当てて確定させたので、変えるときは
> 根拠を持って変えてください。**この形を知っているのは `_post_command()` と
> `build_command_body()` だけ**です。
>
> | | 正しい形 | 間違えたときの応答 |
> |---|---|---|
> | メソッド | `PUT` | `POST` は **405** |
> | パス | `rac/basic-idu-control/general-control-command-**status**/{id}` | `-status` 無しは **400**（本文が空で理由が出ない） |
> | クエリ | `familyId` | `vendorThingId` / `timeZone` では **400**（本文が空） |
> | 本文 | `power` / `mode` / `fanSpeed` / `fanSwing` / `humidity` / `iduTemperature` / `relativeTemperature` の**7つだけ** | `idu-list` の応答をそのまま返すと **400** |
> | `humidity` | **文字列の `"0"` 固定** | 読み取った値（`50`）を返すと **400 `INVALID_HUMIDITY`** |
>
> 成功すると `{"commandId": "...", "status": "DONE"}` が返ります。**400 の理由は応答本文の
> `stackTrace`**（`INVALID_HUMIDITY` など）に入るので、失敗時はログに残しています。

> **操作は全項目を送る。** 「温度だけ変える」という部分的な指示は受け付けず、送らなかった
> 項目は機器側の既定へ戻ります。そのため送信の直前に必ず現在値を引いて混ぜています
> （`merge_command()`）。

> **自動運転のときだけ温度の入れ先が違う。** `iduTemperature` は設定温度そのもので、
> 室温からのシフト量は `relativeTemperature` に入れます。**読むときは逆で、自動運転でも
> シフト量は `iduTemperature` に現れます**（実機で確認済み）。kurashio は画面もDBも
> `target_temperature` 1つで扱うため、この振り分けは `build_command_body()` が持ちます。

> **操作の結果がDBに入るのはラズパイの取り込み（5分ごと）待ち。** 操作パネルとカードは、
> 送信が成功した時点の状態を先に画面へ出します。グラフ・履歴に出るのは取り込み後です。

**DB マイグレーション**（本番 DB 利用時）:

```bash
python3 migrate_db.py   # aircon / daily_energy テーブルを作成
```

### 消費電力（日別の電力使用量）

取得元を問わない日別テーブル `daily_energy` に使用量（kWh）をためて、ダッシュボードの「暮らし」
セクションに「消費電力」カードとして出します。**エアコンもスマートプラグも1枚のカードにまとめます**
——知りたいのは「家全体で今月いくらか」で、取得元ごとにカードを分けると足し算が読み手の仕事に
なるためです。カードには取得元ごとの行が並び、家全体の合計と先月同日との差が出ます。

エアコンぶんは AirCloud Home の
`rac/energy-consumptions/summary/v3` から取れるため、**運転状態とは別枠（1時間間隔）で**送ります
（状態の取得は5分間隔・レート制限があるため同じ間隔では回せません）。

**送り手はエアコン・スマートプラグとも Raspberry Pi ではなくサブPC**です。エアコンの取得は
クラウドAPI同士で完結し BLE を使わないため、センサーの近くに居る必要がありません（運転状態と
CO2 の収集は引き続き Raspberry Pi 側）。スクリプトは [`collectors/`](collectors/README.md)、
定期実行の systemd ユニットは [`collectors/systemd/`](collectors/systemd/) にあります。
スマートプラグぶんの詳細は後述の「消費電力の収集（Tapo スマートプラグ + サブPC）」を参照してください。

| 用途 | URL |
|------|-----|
| API（日別使用量 POST） | https://myroom.gucchii.com/api/energy |
| API（カード用の集計 GET・要ログイン） | https://myroom.gucchii.com/api/energy/breakdown |
| API（取得元1つの集計 GET・要ログイン） | https://myroom.gucchii.com/api/energy/summary |

```bash
# 1日ぶん、または複数日まとめて送る
curl -X POST "https://myroom.gucchii.com/api/energy" \
  -H "Content-Type: application/json" \
  -d '{"source":"aircon","records":[{"date":"2026-08-22","kwh":2.4}]}'
```

- `records[].date` は `YYYY-MM-DD`。`kwh` か `cost_yen` の**どちらか1つ以上**が必須
- **同じ `(date, source)` は上書きします。** 当日ぶんは1日のあいだ増えていくため、
  追記だと二重計上になります。何度送っても構いません
- `source` は取得元の識別子。エアコンは `aircon`、スマートプラグなら `tapo:<機器名>` のように
  「種別:識別子」で書きます。レコードごとに `records[].source` で上書きもできます
- **金額は取得元によって出どころが違います。** `cost_yen` が送られてきたらその値をそのまま使い、
  無ければ `ui_settings` の `energy_unit_price`（円/kWh・既定 31）を掛けた目安になります。
  単価はカードをタップした詳細パネルから変更できます。エアコン（AirCloud Home）は金額まで返すため
  実額、スマートプラグ（Tapo）は使用量しか返さないため目安です
- `records[].power_w` は**いまの消費電力（W）**。スマートプラグだけが返します。日別の集計には
  使わず、カードに「動いているか」を出すために**その日の最後の値だけ**を持ちます。エアコンは
  瞬時値を返さないため NULL のままで、カードの行では「—」になります
- 集計（`/api/energy/breakdown?days=30`）は、取得元ごとの行と、家全体の今日・今月・先月・
  先月の同じ日まで・日別の内訳を1度に返します。カードと詳細パネルはこれだけを使います
- `/api/energy/summary?source=aircon&days=30` は取得元を1つに絞った集計です。カードは使いません
- **欠測は 0 として扱いません。** プラグは停電明けにローカル API が黙ることがあり、抜けた日を
  0 kWh として描くと「その日は使っていない」に見えてしまうため、棒を描かず集計の日数からも外します
- カードを消したい場合は表示設定ページ（`/devices`）の「暮らし」でオフにします

**DB マイグレーション**（本番 DB 利用時）:

```bash
python3 migrate_db.py   # daily_energy テーブルの作成と power_w 列の追加
```

### 時間ごとの電力使用量（KEPCO「みるでん」のCSV）

消費電力カードをタップして開く詳細パネルには「日別」と「時間ごと」のタブがあります。
「時間ごと」は、エアコン・スマートプラグの受信のたびに記録した当日累計のスナップショット
（`energy_readings`）の差分から、その日の時間帯ごとの使用量を出します。**記録し始めた日より
前は遡れません**（無い日は「この日の時間ごとの記録はありません」と出ます）。

家全体の実測は関西電力の会員サイト「みるでん」からCSVで取り込みます。**取得先はここだけです。**

| 用途 | URL |
|------|-----|
| 時間ごとCSVのダウンロード（関西電力「みるでん」・要ログイン） | https://kepco.jp/miruden/mypage/download |
| API（CSVの取り込み POST・要ログイン） | https://myroom.gucchii.com/api/energy/kepco/import |
| API（時間ごとの内訳 GET・要ログイン） | https://myroom.gucchii.com/api/energy/hourly |

- **アプリからも同じURLへ飛べます。** 詳細パネルの「時間ごと」タブにある
  「KEPCOの明細（CSV）を取り込む」ボタンの下に、ダウンロードページへのリンクがあります
  （`frontend/lib/energy.ts` の `KEPCO_MIRUDEN_DOWNLOAD_URL`）。**リンクを増やすと片方が古くなるため、
  貼るのはこの1か所だけにします**
- 落としたCSVをそのままボタンから選ぶと、`kepco_hourly_usage` へ `(date, hour)` で upsert します。
  期間が重なるCSVを何度取り込んでも二重計上にはなりません
- **みるでんのCSVはローリングウィンドウ（直近1か月強）です。** 過去分を残したいなら定期的に
  取り込む必要があります。CSVは年を持たず `MM/DD` だけなので、`backend/kepco_import.py` が
  ヘッダーの「データ抽出対象期間」から年を復元します
- 時間ごとのグラフに出る**「その他」= KEPCO実測（家全体）− エアコン・スマートプラグ実測**です。
  取り込んだ日だけ出ます

### 消費電力の収集（Tapo スマートプラグ + サブPC）

TP-Link Tapo スマートプラグ（P110 系）の消費電力を LAN 経由で読み、日別の使用量として
記録します。**計測のみで、ON/OFF の操作はできません。**

エアコン（`source='aircon'`）と同じ `daily_energy` テーブルへ `source='tapo:<表示名>'` として
入り、ダッシュボードの「消費電力」カードに1枚でまとまって出ます。

収集スクリプトは `collectors/tapo_to_myroom.py`。**ラズパイではなくサブPCで動かします。**
`python-kasa` が Python 3.11 以上と `cryptography` を要求し、armv6 の Pi Zero W では導入が
現実的でないためです。プラグと同じ LAN にいればどこからでも読めます。

**前提**

- Tapo アプリでプラグをセットアップ済み（TP-Link アカウントに紐付いていること）
- プラグとサブPC が同じ LAN にいること（KLAP プロトコル・TCP 80、ディスカバリーは UDP 20002）
- プラグとサブPCが DHCP で到達できること（IP が変わっても収集時の探索で追従する）

**セットアップ**

```bash
cd ~/apps/myroom

# このスクリプトだけ依存がある（python-kasa）。専用の venv を作る
python3 -m venv collectors/.venv-tapo
collectors/.venv-tapo/bin/pip install -r collectors/requirements-tapo.txt

# collectors/tapo.env.example の内容を collectors/.env へ追記し、実値を入れる
# （実値は 1Password の apps/MyRoom から取る。.env は gitignore 済み）

# LAN 上のプラグを探して IP と名前を確認する
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --list-devices

# 読み取りだけ試す（POST しない）
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --dry-run -v
```

`TAPO_HOSTS` は `192.168.2.21=冷蔵庫,192.168.2.22=テレビ` のように書き、`=表示名` を省くと
プラグ自身の名前を使います。

`TAPO_HOSTS` は必須ではありません。表示名と Tapo 側の名前が一致する場合、収集時の探索で見つけた
IP を優先するため DHCP による IP 変更にも追従します。到達不能な手書き IP は WARNING に残りますが、
ほかのプラグの取得と API 送信が成功していれば collector は成功終了します。

> **表示名はあとから変えないこと。**
> 表示名はそのまま `daily_energy.source`（`tapo:<表示名>`）になるため、変更すると
> 別の機器として記録され、グラフが途中で途切れます。

> **停電・ブレーカー断のあと、Tapo のローカル API はディスカバリー通信を受け取るまで応答しない。**
> 遅延初期化のためで、放っておくと数分〜場合によっては復活しません。収集スクリプトは各機器へ
> 接続する前に必ずブロードキャストのディスカバリーを1回投げてこれを回避しています
> （`wake_up_devices()`）。この順序を崩さないでください。

**定期実行**は systemd user timer（5分ごと）で行います。

```bash
cd ~/apps/myroom
cp collectors/systemd/myroom-tapo-energy.service collectors/systemd/myroom-tapo-energy.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now myroom-tapo-energy.timer
```

### 電気の操作（Nature Remo）

Nature Remo に登録済みのリモコン操作を、ダッシュボードの「暮らし」セクションのボタンから押せます。
**並べるボタンは画面から登録します**（#262）。「ダッシュボードの表示」（`/devices`）の「暮らし」にある
「電気の操作」の**編集** →「Nature Remo から選ぶ」で、登録済みの操作にチェックを付けるだけです。

**照明が点いているかどうかは表示しません。** 赤外線は片方向で、機器が受け取ったかは返ってこないため、
状態を持つと画面と部屋の実態が必ずずれます。物理リモコンと同じ「押したら飛ぶだけ」に揃えることで、
状態の同期・Cloud API のレート制限（30回/5分）・バックエンドでのポーリングがまとめて不要になります（#106）。
そのため **Nature Remo を叩くのは押したときだけ**で、一覧の取得では叩きません。

**保存先は DB（`app_settings` テーブルの `remote_button_defs`）です。**
`data/remote.json` を正にしていた頃は、デプロイの `rsync` がリポジトリの空ファイルで本番を上書きするため、
画面から書いても次のデプロイで消えていました。いまファイルが読まれるのは
**画面から一度も保存していないあいだだけ**で、初期値として置いておけます（形式は以下）。

```jsonc
{
  "groups": [
    {
      "id": "light",
      "name": "照明",
      "buttons": [
        // Nature Remo に「照明」として登録した機器
        { "id": "light-on",  "label": "点ける", "appliance_id": "xxxx", "button": "on" },
        { "id": "light-off", "label": "消す",   "appliance_id": "xxxx", "button": "off" }
      ]
    },
    {
      "id": "tv",
      "name": "テレビ",
      // 「その他」として登録した赤外線は signal_id で押す
      "buttons": [{ "id": "tv-power", "label": "電源", "signal_id": "xxxx" }]
    }
  ]
}
```

- **押し方は2通りあります。** Nature Remo アプリで **「照明」として登録した機器は `signals` を持ちません**。
  `GET /1/appliances` が返す `signals` は空で、`light.buttons` に `on` / `off` / `night` などが入り、
  `POST /1/appliances/{id}/light` でしか押せません。部屋の電気はこの登録になっていることが多いため、
  `signal_id` だけでは肝心の照明を出せません。「その他」として登録した赤外線は `signal_id` を使います
- **「エアコン」として登録した機器はこのカードでは押せません。** 温度・モードを持つ専用APIしか無く、
  ボタン1つに対応しません。ボタンとして出したい場合は Nature Remo アプリで「その他」として登録し直します
- **白くまくんのエアコンは、赤外線ボタンの下から操作パネルを開けます**（#268）。区切り線をはさんだ
  「エアコン」の行がそれで、**押しても赤外線は飛びません**。開くのはセンサーのエアコンカードから開く
  ものと同じパネル（`components/aircon-control-panel.tsx`）で、Nature Remo は一切通りません。
  行の右に出る運転状態はエアコンカードのバッジと同じ値（`buildAirconStatusPill()`）で、この行のために
  問い合わせを増やしてはいません。**操作できないとき（`AIRCON_EMAIL` / `AIRCON_PASSWORD` が未設定・
  オフライン）は行ごと出しません。** 「ダッシュボードに表示（設定温度）」を切っているときは、
  エアコンカードのバッジと揃えて運転状態も出しません
- **「Nature Remo から選ぶ」は、開いただけでは Nature Remo を叩きません。** 出すのは最後に取得した控え
  （`app_settings` の `remote_catalog`）で、取り直すのは「読み込み直す」を押したときだけです。
  Cloud API の上限が 30回/5分しかないため、シートを開くたびに問い合わせる作りにはできません
- **ボタンIDは機器と操作から決まります**（並び順から採番しません）。チェックを外して付け直しても
  同じIDに戻るので、付けた名前もそのまま残ります。`data/remote.json` に手で書く場合だけ、`id` を省くと
  `group1-1` のように並び順から採番され、あとからボタンを挿すと以降のIDがずれます
  （その場合の手当ては後述の `default_label`）
- **グループは機器ごとにできます。** 見出しは Nature Remo のニックネームで、画面から書き換えられます。
  ↑↓ で並び替え、✕ でボタン1件ずつ登録から外せます。1つも残らないグループは見出しごと消えます
- **ボタンの名前と、ダッシュボードに出すかどうかも同じシートで変えられます**（#260）。
  名前を空にすると Nature Remo 側の名前へ戻ります。上書きの中身は UI 設定
  （`app_settings` テーブルの `remote_buttons`）が持ち、定義（`remote_button_defs`）とは分けています。
  定義は「どの機器へ何を送るか」の正、UI 設定は「画面での見せ方」の正です。
  隠したボタンも `GET /api/remote/buttons` は `hidden: true` を付けて返します（設定画面が一覧に出すため）。
  カードから消す判断は画面側で行い、隠したボタンも送信API自体は受け付けます
- 設定には保存時点の元の名前（`default_label`）も控えてあり、今の定義と食い違う設定は無視されるので、
  **付けた名前が黙って別のボタンに付くことはありません**（その場合は元の名前へ戻ります）
- 初期値として `data/remote.json` を書きたいときは、貼り付け用の一覧をスクリプトで出せます

  ```bash
  # リポジトリルートで。.env に NATURE_REMO_TOKEN があれば環境変数の指定は不要
  python scripts/list-remo-signals.py
  ```

- 環境変数 `NATURE_REMO_TOKEN` が未設定だと、押したときと「読み込み直す」を押したときに
  「トークンが設定されていません」を返します（登録済みボタンの表示には影響しません）。
  トークンは https://home.nature.global/ で発行します
- API は次の5本で、どれも他のダッシュボードAPIと同じ Supabase JWT 認証です。実装は `backend/remote.py`

  | メソッド | パス | 用途 |
  |---|---|---|
  | GET | `/api/remote/buttons` | 登録済みボタンの一覧（Nature Remo は叩かない） |
  | POST | `/api/remote/buttons/{id}/send` | 押す |
  | GET | `/api/remote/catalog` | 選べる操作の控え（Nature Remo は叩かない） |
  | POST | `/api/remote/catalog/refresh` | 控えを取り直す（**ここだけ Nature Remo を叩く**） |
  | PUT | `/api/remote/config` | 登録内容・名前・隠す指定をまとめて保存 |

- **signal ID・appliance ID は画面へ返しません。** 登録するときもボタンIDだけを送り返す形にしてあり、
  送り先はサーバー側で引きます（`remote.resolve_config()`）。外へ出す値は少ないほど安全です
- カードを消したい場合は表示設定ページ（`/devices`）の「暮らし」でオフにします

### ゴミの日

収集日を `data/garbage.json`（**リポジトリに含まれる**手編集ファイル）に書くと、ダッシュボードの
「暮らし」セクションに次の収集が見出しで出て、今日・明日の予定と、品目ごとの次の収集日が並び、
前日夜に PWA Push 通知が届きます。
外部 API もスクレイピングも使わず、書いたルールから日付を計算するだけです。

```jsonc
{
  // 画面には出ません。どの市のどの地区のルールかを編集する人に伝えるためのメモです
  "area": "高槻市 出丸町",
  "notify_hour": 20,               // 通知する時刻（JST・0〜23）
  "categories": [
    {
      "id": "burnable",
      "name": "普通ごみ",
      "color": "#e67e22",
      "note": "生ごみ・紙くずなど",
      "rules": [{ "type": "weekly", "weekdays": ["mon", "thu"] }]
    },
    {
      "id": "recyclable",
      "name": "リサイクルごみ",
      // 第2・第4火曜（weeks は 1〜5 と -1（最終週）が使える）
      "rules": [{ "type": "monthly", "weekday": "tue", "weeks": [2, 4] }]
    }
  ],
  "exceptions": [
    { "date": "2026-12-31", "cancel": true, "note": "年末年始のため収集なし" },
    { "date": "2027-01-05", "cancel": ["recyclable"] },
    { "date": "2027-01-06", "add": ["burnable"], "note": "振替収集" }
  ]
}
```

- `weekday` / `weekdays` は `mon`〜`sun` でも `月`〜`日` でも書けます
- **`categories` の並び順が、カードの「品目ごとの次の収集」の並び順になります。** 日付順には
  並べ替えません（毎日順番が入れ替わると目的の品目を探しにくいため）。約2か月先まで収集が
  見つからない品目は「予定なし」と出るので、ルールの書き忘れに気付けます
- 年末年始などの変則日程は `exceptions` に書きます。`cancel: true` でその日を全休、
  `cancel: ["id"]` で品目を指定して中止、`add: ["id"]` で臨時収集を追加
- 通知は `backend/garbage_notify.py`。バックエンドが5分ごとに呼び、`notify_hour` の時刻にだけ PWA Push で送信します
  （本番のバックエンドは PM2 が起動するプロセス1つなので、systemd タイマーではなくこのプロセス内で回しています。
  手動で試すときは `python -m backend.garbage_notify`）
- 同じ収集日に二重通知しないよう、送信済みの日付を `data/garbage_notify_state.json`（gitignore）に残します
- カードを消したい場合は表示設定ページ（`/devices`）の「暮らし」でオフにします

**いま書いてあるルールの出どころは Notion の「しおり › 情報本体 › ♻️ ゴミ分別ルール（高槻市・出丸町）」**
（分別区分マスターデータの表）です。引越しや市の変更でルールを直すときは、まず Notion 側の
その表を直してから `data/garbage.json` へ写してください。**逆順にすると Notion 側の
「ゴミの日」データベースが次の同期で巻き戻ります**（下記）。

#### Notion への書き出し（dayspan のカレンダー連携）

収集日を Notion のデータベースへ書き出し、Notion を読むアプリ（dayspan など）のカレンダーから
見えるようにします。**収集日の正はあくまで `data/garbage.json`** で、Notion 側を手で書き換えても
次の同期で戻ります（`data/garbage.json` に無い日のページは自動でアーカイブされます）。

```json
"notion": {
  "enabled": true,
  "window_days": 60,
  "category_value": "ゴミの日",
  "properties": { "title": "タイトル", "date": "日付", "category": "種類", "memo": "メモ" }
}
```

- 実装は `backend/garbage_notion.py`（同期）と `backend/notion_api.py`（Notion API の薄いラッパ）。
  バックエンドが1時間ごとに呼び、1日1回だけ実行します。手動で試すときは
  `python -m backend.garbage_notion --dry-run`（書き込まずに差分の件数だけ表示）
- 環境変数 `GARBAGE_NOTION_TOKEN`（Notion のインテグレーショントークン）と
  `GARBAGE_NOTION_DATA_SOURCE_ID` の両方が設定されているときだけ動きます。未設定なら何もしません
- **持つのは `database_id` ではなく `data_source_id` です。** Notion API のバージョン `2025-09-03` 以降、
  プロパティ定義とクエリの対象はデータベースではなくデータソースに変わり、`database_id` では読み書きできません
- ページの粒度は「収集日 × 品目」で1件。今日から `window_days` 日先までを毎回まるごと計算し直し、
  Notion 側の同じ期間を引いて差分（作成・更新・アーカイブ）を当てます。ページIDを手元に持たないため、
  状態ファイルを失っても二重登録になりません。過ぎた収集日のページは検索対象に入らないので消えません
- **select プロパティ「種類」に `category_value` を書き込み、これを目印に myroom が作ったページを見分けます。**
  この目印が無いと人が手で作ったページと区別できず、`exceptions` で中止になった日のページを片付けられません。
  そのため「種類」は必須で、見つからない場合は1件も書かずに中止します
- プロパティ名は Notion 側で自由に付けられるため、`properties` の名前で当たらない場合は
  「その型のプロパティが1つしか無ければそれ」という判定に落とします。複数あって絞れないときは中止します
- 同期のきっかけは「日付が変わったこと」に加えて「`data/garbage.json` の内容が変わったこと」。
  収集ルールを直したあと翌日まで反映されないのを避けるため、設定のハッシュを
  `data/garbage_notion_state.json`（gitignore）に残して比べています

### 掃除

場所ごとに「何日に1回」「何をするか」を持ち、**最後にやった日 + 間隔（日数）**で次にやる日を決めます。
曜日固定にしないのは、1日ずれただけで次の週まで飛んでしまい、掃除の実態と合わないためです。

- カード先頭の「今日やること」に出るのは、**期限を過ぎたものと今日が期限のもの**だけです。
  ここに全部を並べると「そろそろやる」と「もうやるべき」の区別が付きません。1件も無ければブロックごと消えます
- 場所・間隔・やることは**アプリ画面から**編集します（カード右上の「設定」）。
  1件ずつ保存せず、開いている間の編集をまとめて `PUT /api/cleaning/tasks` で置き換えるため、
  追加・削除・並べ替えが1回の保存に収まります。実施履歴は送らず、同じ `id` の項目からサーバー側が引き継ぎます
- **定義と実施履歴の保存先は既存の `app_settings` テーブル**（キー `cleaning_tasks`）です。
  掃除のためにテーブルを増やすと `migrate_db.py` へ DDL を足すことになり、本番のアプリ用DBユーザーには
  CREATE 権限が無いのでデプロイが落ちます（#193）。項目数はせいぜい十数件で1行の JSON に収まるため、
  既存の器を使っています。**マイグレーションは不要です**
- 実施履歴は1項目あたり10件まで。画面に出すのは直近3件で、残りは間隔を見直すときの手がかりです

#### Notion のタスクへの書き出し（`backend/cleaning_notion.py`）

ゴミの日と同じ考え方で、次の掃除を Notion の `☑️ Task` データベースへ書き出します。
DaySpan・AIDE が読むタスク一覧に「次の掃除」を並べることが目的で、掃除の正は myroom 側のままです。

- **書き出すのは場所ごとに「次の1件」だけ。** 先の予定まで並べるとタスク一覧が掃除で埋まります
- **myroom が書いたページかどうかは multi_select「タグ」に `掃除` が入っているかで判断します。**
  ゴミの日の書き出し先には目印用の select「種類」がありましたが、Task データベースには無いため、
  既存のタグへ1つ足して目印にしています。既存の手書きタスクには触りません
- 照合キーはタイトル（`掃除: <場所名>`）。場所の名前を変えると別物になり、古いページはアーカイブされて
  新しい名前で作り直されます
- **日付は「期限」に書きます。** Task データベースには日付型が「期限」「予定日」の2つあるため、
  型だけでは決まりません。名前で当たらなければ同期を中止します
- **Notion 側で「完了」にすると、次の同期でその掃除を実施済みとして myroom へ記録します**（読み戻し）。
  実施日は**同期した日**です。チェックを入れた瞬間は分からないため。同期は1時間ごとなのでずれは小さく収まります
- 環境変数 `CLEANING_NOTION_TOKEN` と `CLEANING_NOTION_DATA_SOURCE_ID` の両方が設定されているときだけ動きます。
  **未設定でも掃除カードはそのまま動きます**（書き出しだけが行われない）。トークンはゴミの日と同じ値でよいですが、
  Notion の権限はページ単位のため、Task データベース側にもそのインテグレーションを接続しておく必要があります
- 手動で試すときは `python -m backend.cleaning_notion --dry-run`

### その他

- **最近の記録**: 直近7日分から表示し、「もっと見る」で追加読み込み
- **モバイルアプリ対応 (PWA)**: ホーム画面に追加して全画面起動可能。専用アプリアイコン設定済み
- **オフライン表示**: ネットワーク切断時、IndexedDB に保存した最新値と直近24時間のグラフを表示
- **センサー未到達通知**: API 側で鮮度を監視し、Signaly で通知。ダッシュボードに警告表示
- **死活監視用 API**: `/api/health` が `GET` / `HEAD` で `200 OK` を返す
- **ログイン管理**:
  - ダッシュボードのデータ取得 API は **認証必須**（`Authorization: Bearer <Supabaseアクセストークン>`）。センサー POST（`/api/sensor`）・エアコン POST（`/api/aircon`）は認証なし
  - ログインは Supabase Auth 経由の Google 認証で行う（複数の自作アプリ共通の Supabase プロジェクトを使用）。許可したアカウントのみアクセス可能（`ALLOWED_GOOGLE_EMAILS` にメールアドレスをカンマ区切りで設定）
  - バックエンドは Supabase の JWKS（`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`）を取得・キャッシュし、kid 付きの JWT（ES256/RS256）は手元で検証する。kid の無い JWT と、Googleで確認済みのアカウントかどうか（identities）は Auth サーバー（`/auth/v1/user`）に問い合わせ、トークンごとに5分覚える（#724）。問い合わせには `SUPABASE_PUBLISHABLE_KEY` が要る（本番は `deploy.yml` がサーバー `.env` へ同期。ローカルは `.env` に開発用の値を書く）
  - 本番: GitHub の organization variable `SUPABASE_PROJECT_URL` / `SUPABASE_PUBLISHABLE_KEY` と、このリポジトリの secret `ALLOWED_GOOGLE_EMAILS` を、それぞれ `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `ALLOWED_GOOGLE_EMAILS` としてサーバー `.env` と GitHub Actions のフロントエンドビルドへ反映（`deploy.yml`。対応表は `.github/secrets-manifest.tsv`）
  - ローカル開発: 本番と誤って同じ Supabase プロジェクトを操作しないよう、1Password 共有アイテム `Supabase` の `dev-project-url` / `dev-publishable-key`（開発用の別 Supabase プロジェクト）を使用。**ローカルは自動同期されない**ため、バックエンドはローカルの `.env` に `SUPABASE_URL` を、フロントエンドは `frontend/.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を、それぞれ 1Password アプリから値をコピーして書き込む（詳細は「3. フロントエンド (Next.js)」参照）
  - Supabase ダッシュボードの Authentication → URL Configuration → Redirect URLs に、本番用プロジェクトには本番ドメインの、開発用プロジェクトにはローカル開発用の `/auth/callback` を、それぞれ**完全一致**で登録しておく必要がある（生の IP アドレスをホスト名にした URL は無条件で拒否される）
  - ログイン成功時: Signaly へ通知（`LOGIN_WEBHOOK_URL`）。Supabase Auth ではコールバックが Supabase 側にあり、バックエンドに「ログインした瞬間」が通らないため、フロントエンドの `/auth/callback` が `POST /api/auth/login-notify` を1回だけ叩いて起点にしている（#240）。宛先は**全アプリ共通の1チャンネル**で、どのアプリのログインかはペイロードの `source`（`backend/login_notify.py` の `APP_NAME`）で見分ける（guchi-apps/signaly#192）。**未設定なら通知が飛ばないだけで、ログイン自体は通る**
    - **`/auth/callback` に来たこと自体を「いまログインした」の合図にしている。** URL の `?code=` の有無では判定できない。Supabase クライアント（`frontend/lib/supabase-client.ts`）は `flowType` を指定しておらず、既定の **implicit フロー**で動くため、本物のログインではアクセストークンがハッシュ（`#access_token=...`）で返り、`code` は付かない
  - センサー異常・復旧時: Signaly（1Password の `sensor-webhook-url`）へ通知
  - GitHub Actions（CI / デプロイ）の成功・失敗: Signaly へ通知

## API 概要

| メソッド | パス | 説明 |
|----------|------|------|
| GET/HEAD | `/api/health` | 死活監視 |
| GET | `/api/auth/me` | ログイン確認（Supabaseセッションの許可判定、要認証） |
| POST | `/api/auth/login-notify` | ログイン成功を Signaly へ通知（要認証。フロントの `/auth/callback` から呼ぶ） |
| GET | `/api/latest?device=1` | 最新の屋内＋屋外データ（要認証） |
| GET | `/api/history?range=day&device=1` | 履歴（`range`: day/week/month/year、または `start`/`end`、要認証） |
| GET | `/api/daily-stats?device=1` | 日次統計（最近の記録、要認証） |
| GET | `/api/records?device=1` | センサー記録一覧（要認証） |
| DELETE | `/api/records` | センサー記録の削除（要認証） |
| POST | `/api/records/bulk-delete` | センサー記録の一括削除（要認証） |
| POST | `/api/sensor?device=1` | センサーデータ受信（認証不要） |
| POST | `/api/aircon` | エアコン状態受信（認証不要） |
| GET | `/api/aircon/latest?ac_id=1` | エアコン最新状態（要認証） |
| GET | `/api/aircon/history` | エアコン履歴（要認証） |
| GET | `/api/devices` | デバイス一覧（要認証） |
| PUT | `/api/devices/{id}` | デバイス表示名・継承設定の更新（要認証） |
| GET | `/api/aircon/units` | エアコンユニット一覧（要認証） |
| PUT | `/api/aircon/units/{ac_id}` | エアコン表示名の更新（要認証） |
| GET | `/api/aircon/units/{ac_id}/state` | エアコンの現在の運転状態（**エアコンから直接読む**・要認証） |
| POST | `/api/aircon/units/{ac_id}/control` | エアコンの運転操作（要認証・下記） |
| GET/PUT | `/api/ui-settings` | UI 設定（表示順・色・非表示デバイス、要認証） |
| GET | `/api/outdoor-location` | 屋外地点の取得（要認証） |
| PUT | `/api/outdoor-location` | 屋外地点の更新（要認証） |
| GET | `/api/outdoor-location/search?q=大阪` | 地名検索（要認証） |
| GET | `/api/sensors/status` | センサー鮮度ステータス（要認証） |
| GET | `/api/garbage` | ゴミの日（今日・明日・この先の予定・品目ごとの次の収集、要認証） |
| GET | `/api/cleaning` | 掃除の予定と次にやる日（要認証） |
| PUT | `/api/cleaning/tasks` | 掃除の定義をまとめて置き換え（追加・編集・削除・並べ替え、要認証） |
| POST | `/api/cleaning/tasks/{id}/done` | 掃除をやった記録を追加（要認証） |
| GET | `/api/internal/room-state` | 部屋の状態のスナップショット（**サーバー間専用**・下記） |
| GET | `/api/internal/remote/buttons` | 「電気の操作」で押せるボタンの一覧（**サーバー間専用・操作用トークン**・下記） |
| POST | `/api/internal/remote/buttons/{button_id}/send` | 登録済みのボタンを押す（**サーバー間専用・操作用トークン**・下記） |
| GET | `/api/internal/aircon/units/{ac_id}/state` | エアコンの今の状態（白くまくんから直接読む。**サーバー間専用・操作用トークン**・下記） |
| POST | `/api/internal/aircon/units/{ac_id}/control` | エアコンの運転指示（電源・モード・設定温度・風量。**サーバー間専用・操作用トークン**・下記） |

### サーバー間参照用の内部API

`GET /api/internal/room-state` は、同じ VPS 上で動く [AIDE](https://github.com/guchi-apps/aide) の
MCP ツール `aide_room_status` 向けの**読み取り専用**の口です。ログインセッションでは通らず、
issue-deck の共有トークン `MYROOM_INTERNAL_API_KEY`（取得できなければ環境変数 `INTERNAL_API_KEY`）と一致する `Authorization: Bearer <トークン>` だけを受け付けます。操作用は `MYROOM_INTERNAL_CONTROL_API_KEY`（フォールバックは `INTERNAL_CONTROL_API_KEY`）。取得は `backend/shared_token.py`（10分キャッシュ・5秒タイムアウト・失敗時は直前の値）で、`SHARED_TOKEN_API_SECRET` と `SHARED_TOKEN_API_URL` が `.env` に無ければ使いません。

| 状況 | ステータス |
|------|-----------|
| トークンが一致 | 200 |
| トークンが無い・一致しない | 401 |
| `INTERNAL_API_KEY` が未設定 | 503 |

```bash
curl -s -H "Authorization: Bearer <トークン>" http://127.0.0.1:8000/api/internal/room-state
```

- 各センサーの最新値・鮮度判定（`SENSOR_STALE_MINUTES`）・屋外の現在値・エアコンの最新状態を
  **1回にまとめて**返します。呼ぶ側に鮮度のしきい値判定を再実装させないことが目的です
- 履歴・日別統計・記録の一覧は含みません
- 画面向けAPIは snake_case ですが、**このAPIだけ camelCase** です（AIDE 側がその前提で実装済み）
- 日時は日本時間のISO8601（オフセット付き）。**本番VPSのタイムゾーンはUTC**のため、オフセットを
  省くと受け側で9時間ずれます

#### 操作用の内部API（照明・エアコンの操作・#419・#439）

AIDE から ChatGPT / Claude 経由で照明・エアコンを操作するための口です。**読み取り用とは別のトークン**
`INTERNAL_CONTROL_API_KEY` で通ります（DaySpan の `INTERNAL_EVENTS_API_KEY` と同じ分け方）。

- **`INTERNAL_API_KEY`（読み取り用）では通りません。** 逆も同じで、操作用トークンで `room-state` は
  読めません。片方が漏れても、もう片方の経路は塞がったままにするための分け方です
- ログインセッション（Supabase のJWT）でも通りません
- 状況ごとのステータスは上の表と同じです（未設定 503・無い／不一致 401）

```bash
# 押せるボタンの一覧（Nature Remo は叩かない。GET /api/remote/buttons と同じ形）
curl -s -H "Authorization: Bearer <操作用トークン>" http://127.0.0.1:8000/api/internal/remote/buttons

# 登録済みのボタンを押す
curl -s -X POST -H "Authorization: Bearer <操作用トークン>" \
  http://127.0.0.1:8000/api/internal/remote/buttons/<button_id>/send
```

| 結果 | ステータス・本文 |
|------|-----------------|
| 送信を依頼できた | 200 `{"sent": true, "button_id": "…", "label": "…", "group_name": "…"}` |
| 登録されていないボタン | 404 |
| 送信回数の上限（Nature Remo は 30回/5分） | 429 |
| Nature Remo 側の失敗・つながらない | 502 |
| `NATURE_REMO_TOKEN` が未設定 | 503 |

失敗時の本文は `{"detail": "<利用者向けの文言>"}` です。

- **送れるのは画面で登録済みのボタンだけ。** `button_id`（一覧の `id`）だけを受け取り、signal ID・
  appliance ID を直接渡す口はありません。隠したボタン（`hidden: true`）も押せます
- 返せるのは「Nature Remo が送信を受け付けたか」までで、機器が実際に反応したかは分かりません（赤外線は片方向）
- **`/api/internal/remote/…` で行えるのは登録済みボタンを押すことだけです。** ボタンの登録や名前の変更、
  signal ID の直接指定はできません（ユーザーJWTを介さない書き込みの口を増やさないため、範囲を絞っています）
- トークンは AIDE 側の `AIDE_MYROOM_TOKEN` と**同じ値**にします。片方だけ変えると 401 で静かに
  連携が止まります
- **この操作用トークンの口で書き込めるのは、次の2つだけです。** 「登録済みボタンを押す」と
  「エアコンの運転指示（電源・モード・設定温度・風量）」。**それ以外の書き込み・設定変更の口は
  ここに足さないでください。** ユーザーJWTを介さない経路のため、増やすほど「ログインしていない
  誰かが叩ける操作」が増えます

##### エアコン（#439）

白くまくん（AirCloud Home）の資格情報は AIDE へ渡さず、myroom が中継します。**画面用の
`GET/POST /api/aircon/units/{ac_id}/…` と同じ処理**（検証・現在値との混合・失敗の文言）で、
違うのは認証（操作用トークン）と、受け取る項目だけです。

```bash
# 今の状態（DBではなく白くまくんから直接読む。名前は画面で付けた表示名）
curl -s -H "Authorization: Bearer <操作用トークン>" \
  http://127.0.0.1:8000/api/internal/aircon/units/1/state

# 運転指示（指定した項目だけを変える。返すのは送信後の状態）
curl -s -X POST -H "Authorization: Bearer <操作用トークン>" -H "Content-Type: application/json" \
  -d '{"power": "ON", "mode": "COOLING", "target_temperature": 26}' \
  http://127.0.0.1:8000/api/internal/aircon/units/1/control
```

| 結果 | ステータス・本文 |
|------|-----------------|
| 成功 | 200（画面用と同じ状態の形） |
| 未登録の `ac_id`（`detail` は利用者向けの文言） | 404 |
| 値が範囲外・選べない値・変更する項目が無い | 422 |
| 余計な項目（`fan_swing` など）を含む | 422 |
| 白くまくん側の混雑 | 429（`Retry-After` つき） |
| 白くまくんとつながらない・拒否された | 502 |
| `AIRCON_EMAIL` / `AIRCON_PASSWORD` が未設定 | 503 |

- **受け取るのは `power` / `mode` / `target_temperature` / `fan_speed` の4つだけ**です。`fan_swing`（風向）は
  受けません。黙って捨てると「送ったのに変わらない」に見えるので、422 で返します
- **温度の意味は呼ぶ側で解釈しません。** 自動運転（`AUTO`）の `target_temperature` は設定温度ではなく
  シフト量で、モードだけを切り替えたときの温度の扱いも含めて、`backend/aircon_control.py` の
  `merge_command()` が現在の状態と突き合わせます
- ルート自体が無い 404 は `{"detail": "Not Found"}`、未登録の `ac_id` の 404 は利用者向けの文言です
  （AIDE はこの違いで「未実装のバージョン」を見分けています）
- 状態の取得（GET）も**操作用トークン**です。読み取りですが白くまくんのクラウドを叩く経路のため、
  読み取り用の `INTERNAL_API_KEY` では通しません

## 設定ファイル

| ファイル | 用途 | 備考 |
|----------|------|------|
| `.env` | DB接続、モックモード、初期デフォルト値 | gitignore |
| `data/devices.json` | デバイス表示名 | gitignore、UI から自動生成 |
| `data/outdoor_location.json` | 屋外地点 | gitignore、UI から自動生成 |
| `data/garbage.json` | ゴミ収集日のルール | **リポジトリに含まれる**（手で編集してデプロイする） |
| `data/cleaning.json` | 掃除の予定（モック実行時のみ） | gitignore、UI から自動生成。本番は `app_settings` テーブル |

## データベース

### スキーマ更新

センサー記録テーブルは `sensor_readings`（旧名 `dht`）です。`device_id`（複合主キー）、`co2`、`illuminance`（照度・lux）、`temperature_dht11` などのカラム追加と、旧テーブル名からのリネームは `migrate_db.py` で行います。

```bash
source venv/bin/activate
python3 migrate_db.py
```

ALTER 権限がない場合は、スクリプトが表示する SQL を管理者ユーザーで実行してください。  
`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` を `.env` に設定すると、管理者権限でのマイグレーションが可能です。

デプロイ時（GitHub Actions）も `migrate_db.py` が自動実行されます。

## 本番環境へのデプロイ

### 1. シークレットの設定（1Password → GitHub）

デプロイ用の秘密情報は 1Password で管理しますが、**GitHub Actions は実行時に 1Password を呼びません。** 実行時の取得先は GitHub の secret / variable で、1Password は「人が管理する唯一の正」として残します。

以前は実行のたびに `1password/load-secrets-action` で読んでいましたが、1Password サービスアカウントの日次レート制限（**1Password アカウント全体で 1,000 リクエスト/日**。サービスアカウントを分けても分割されない）を使い切り、フリート全体のデプロイが止まったため移行しました（guchi-apps/issue-deck#1302）。

**どの値を GitHub のどこから取るかは `.github/secrets-manifest.tsv` が正です。** `SCOPE` が `inherit` の行は organization の共通値（このリポジトリでは同期しない）、`repo` の行はこのリポジトリの secret です。`deploy.yml` の `env:` ブロックはこのマニフェストから `scripts/generate-workflow-env-block.sh` で生成します。

1Password 側の値を変えたときだけ、次のいずれかで GitHub へ同期します（デプロイのたびには実行しません）。

- issue-deck の画面、または `sync-secrets.yml` を `workflow_dispatch` で起こす
- 手元から `scripts/sync-github-secrets.sh` を実行する（**個人アカウントのセッションが必要**。サービスアカウントでは GitHub へ書き込めない）

#### 1-1. 1Password にデプロイ用アイテムを作成

保管庫名 `apps` に、次のアイテムを作成してください。**`Server` / `DB` / `githubaction-sshkey` は複数の自作アプリで共通のため、GitHub 側では organization の secret（`SERVER_*` / `SHARED_DB_*`）になっており、このリポジトリからは同期しません**（`.github/secrets-manifest.tsv` の `SCOPE` が `inherit` の行）。

**アイテム `Supabase`**（セキュアノート等・複数の自作アプリで共通利用。本番用の 2 つは organization の variable `SUPABASE_PROJECT_URL` / `SUPABASE_PUBLISHABLE_KEY` になっており、このリポジトリからは同期しない）

| フィールド名 | 内容 |
|-------------|------|
| `project-url` | 本番用 Supabase プロジェクトの URL（`SUPABASE_URL` としてサーバー `.env` に、`NEXT_PUBLIC_SUPABASE_URL` としてフロントエンドのビルドに同期） |
| `publishable-key` | 本番用 Supabase の Publishable key（`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` としてフロントエンドのビルドに同期。フロントに公開してよい値） |
| `dev-project-url` | ローカル開発用 Supabase プロジェクトの URL（本番と誤操作しないよう分離）。**ローカルへは自動同期しない。** バックエンドはローカルの `.env` の `SUPABASE_URL` に、フロントエンドは `frontend/.env.local` の `NEXT_PUBLIC_SUPABASE_URL` に手動でコピー |
| `dev-publishable-key` | ローカル開発用 Supabase の Publishable key。フロントエンドは `frontend/.env.local` の `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` に手動でコピー |

**アイテム `MyRoom`**（セキュアノート等）

| フィールド名 | 内容 |
|-------------|------|
| `allowed-google-emails` | ログインを許可する Google アカウントのメールアドレス（カンマ区切り、`ALLOWED_GOOGLE_EMAILS` としてサーバー `.env` に同期） |
| `sensor-webhook-url` | センサー異常・復旧通知用 Signaly Webhook URL（`SENSOR_WEBHOOK_URL` として同期） |
| `garbage-notion-token` | ゴミの日を書き出す Notion インテグレーションのトークン（`GARBAGE_NOTION_TOKEN` として同期） |
| `garbage-notion-data-source-id` | 書き出し先の Notion データソースID（`GARBAGE_NOTION_DATA_SOURCE_ID` として同期。`database_id` ではない） |
| `cleaning-notion-token` | 次の掃除を書き出す Notion インテグレーションのトークン（`CLEANING_NOTION_TOKEN` として同期）。`garbage-notion-token` と同じ値でよいが、Task データベース側にもそのインテグレーションを接続しておくこと |
| `cleaning-notion-data-source-id` | 書き出し先（Notion の `☑️ Task`）のデータソースID（`CLEANING_NOTION_DATA_SOURCE_ID` として同期。`database_id` ではない） |
| `internal-api-key` | サーバー間参照用APIのトークン（`INTERNAL_API_KEY` として同期）。issue-deck の共有トークン `MYROOM_INTERNAL_API_KEY` が優先で、これはフォールバック（#525） |
| `internal-control-api-key` | 照明などの操作専用のサーバー間トークン（`INTERNAL_CONTROL_API_KEY` として同期）。共有トークン `MYROOM_INTERNAL_CONTROL_API_KEY` が優先で、これはフォールバック。`internal-api-key` とは**別の値**にする（#419・#525） |
| `shared-token-api-secret`（item は `apps/issue-deck`） | issue-deck の共有トークンAPIのBearer（`SHARED_TOKEN_API_SECRET` として同期）。取得先URLは organization variable `APP_BASE_URL`。未登録でも環境変数へフォールバックするだけなので、issue-deck の設定画面で `MYROOM_INTERNAL_API_KEY`・`MYROOM_INTERNAL_CONTROL_API_KEY` の利用元に `myroom` が出ているかで確認する（#525） |
| `nature-remo-token` | 「電気の操作」カードが赤外線を送るための Nature Remo アクセストークン（`NATURE_REMO_TOKEN` として同期）。https://home.nature.global/ で発行 |
| `db-name` | 接続先データベース名（`DB_NAME` として同期） |
| `target-dir` | デプロイ先ディレクトリ（例: `/home/guchi/myroom`） |
| `vapid-private-key` | PWAプッシュ通知（Web Push）用のVAPID秘密鍵（`VAPID_PRIVATE_KEY` として同期）。**PEM ではなく URL-safe base64 の 1 行（43 文字）** |
| `vapid-public-key` | PWAプッシュ通知用のVAPID公開鍵（`VAPID_PUBLIC_KEY` として同期。URL-safe base64 の 1 行・87 文字） |
| `vapid-subject` | PWAプッシュ通知用のVAPID subject（`VAPID_SUBJECT` として同期。例: `mailto:you@example.com`） |
| `apns-auth-key`（item は `apps/AppStoreConnect`） | iOSアプリ（`ios/`）向けAPNs通知（#527）用のAuth Key（`.p8`）。**PEMをそのまま入れず、ファイルの中身を1行のbase64にしてから**入れる（`base64 -i AuthKey_XXXX.p8 \| tr -d '\n'`）。`APNS_AUTH_KEY` として同期 |
| `apns-key-id`（item は `apps/AppStoreConnect`） | 上記Auth KeyのKey ID（Apple Developer Portal → Certificates, Identifiers & Profiles → Keys）。`APNS_KEY_ID` として同期 |
| `apns-team-id`（item は `apps/AppStoreConnect`） | Apple Developer ProgramのTeam ID。`ios/README.md` の署名チーム（`6AA3WFTR94`・`DEVELOPMENT_TEAM`）と同じ値。`APNS_TEAM_ID` として同期 |
| `apns-bundle-id` | iOSアプリのBundle ID（`com.gucchii.kurashio`）。`APNS_BUNDLE_ID` として同期 |
| `apns-environment` | `sandbox` または `production`。`APNS_ENVIRONMENT` として同期。**環境が未判定のトークンを最初に試す側**で、端末ごとの送信先はバックエンドが `BadDeviceToken` で自動判定して記録する（#593。開発ビルド=sandbox・TestFlight版=production の両方へ届く）。通常は`sandbox`のままでよい（プッシュ通知には有料のApple Developer Programでの署名が必要。無料の個人チームでは署名できない・`ios/README.md`参照） |

**VAPID 鍵の初回登録**（PWA プッシュ通知用・1 回だけ。#293・#337）:

```bash
./venv/bin/python scripts/generate_vapid_keys.py --out ~/.cache/myroom-vapid
```

`--out` を付けると値を画面に出さず、`vapid-private-key` / `vapid-public-key` の 2 ファイル（パーミッション 600）へ書き出します。`--out` なしで実行すると値をそのまま表示します。書き出した値の 1Password への登録と GitHub secret への同期は `provision-secret.sh` に任せます（手順は Issue #331 を作り直した手作業 Issue にあります）。

```bash
cd ~/apps/issue-deck && scripts/provision-secret.sh --repo guchi-apps/myroom --key VAPID_PRIVATE_KEY --from-stdin --no-deploy < ~/.cache/myroom-vapid/vapid-private-key
cd ~/apps/issue-deck && scripts/provision-secret.sh --repo guchi-apps/myroom --key VAPID_PUBLIC_KEY  --from-stdin --no-deploy < ~/.cache/myroom-vapid/vapid-public-key
```

`vapid-subject` は生成スクリプトが作らないので、自分でファイルに書いてから同じ形で渡します（`mailto:` に続けて連絡先のメールアドレス）。

```bash
printf 'mailto:you@example.com' > ~/.cache/myroom-vapid/vapid-subject && chmod 600 ~/.cache/myroom-vapid/vapid-subject
cd ~/apps/issue-deck && scripts/provision-secret.sh --repo guchi-apps/myroom --key VAPID_SUBJECT --from-stdin --field-type text --no-deploy < ~/.cache/myroom-vapid/vapid-subject
```

**値をパイプで渡さないでください**（`printf 'mailto:…' | scripts/provision-secret.sh … --from-stdin` の形）。**必ず一度ファイルへ書き、`<` でリダイレクトします。** `provision-secret.sh` は `cat` で値を読んだあともスクリプトのstdinをそのまま引き継ぎ、その先の `op item edit` / `op item create` は**stdinがパイプだと中身をJSONのアイテムテンプレートとして読もうとします**。読み終わって空になったパイプがそのまま渡るため、opは `[ERROR] invalid JSON provided` で落ちます。stdinが通常ファイル（または端末・`/dev/null`）ならopはこの解釈をしないので、ファイルへ書いて渡せば通ります。**このときスクリプトは「トークンに write_items があるかを疑ってください」と案内しますが、原因は権限ではありません**（`op whoami` は成功します。#343）。

**秘密鍵は PEM 形式では動きません。** `backend/push_notify.py` は環境変数の値をそのまま `pywebpush.webpush(vapid_private_key=...)` へ渡し、pywebpush は `py_vapid.Vapid01.from_string()` で読みます。`from_string()` は改行を落として base64 デコードするだけなので、`-----BEGIN PRIVATE KEY-----` を含む PEM は `Could not deserialize key data` で落ちます。加えて `deploy.yml` の `sync_env_var` は値を `KEY=値` の 1 行として `.env` へ書くため、複数行の PEM は `.env` の書式自体を壊します（python-dotenv が 2 行目以降を別のキーとして読む）。**1Password には必ず 1 行の URL-safe base64 を入れてください。**

未設定でもデプロイは失敗せず、プッシュ通知機能だけが無効のままになります。

**APNs Auth Key の初回登録**（iOSアプリ向け通知用・1 回だけ。#527）:

1. Apple Developer Portal → Certificates, Identifiers & Profiles → Keys で、Apple Push Notifications service (APNs) にチェックを入れたKeyを作成し、`.p8` ファイルをダウンロードする（**ダウンロードは1回きり**）。合わせてKey IDを控える
2. `base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d '\n' > ~/.cache/myroom-apns/apns-auth-key && chmod 600 ~/.cache/myroom-apns/apns-auth-key`
3. 1Password の `apps/AppStoreConnect`（ASCキーと同じアプリ共通のアイテム・#669）に `apns-auth-key` / `apns-key-id` / `apns-team-id` を登録する。`APNS_BUNDLE_ID` / `APNS_ENVIRONMENT`（既定 `sandbox`）はこのアプリ固有なので `MyRoom` に置く。`provision-secret.sh`（上記VAPIDと同じ手順・`--from-stdin`＋ファイルからのリダイレクト）は `MyRoom` 側の項目用で、`AppStoreConnect` 側の項目は1Passwordで直接登録し、`scripts/sync-github-secrets.sh`（または `sync-secrets.yml`）で GitHub へ同期する

**アイテム `Notify`**（セキュアノート等・organization 共通。このリポジトリからは同期しない）

| フィールド名 | 内容 |
|-------------|------|
| `login-webhook-url` | 全アプリ共通のログイン通知用 Signaly Webhook URL。organization secret `SIGNALY_LOGIN_WEBHOOK_URL` として GitHub へ入っており、`LOGIN_WEBHOOK_URL` としてサーバー `.env` に同期される（guchi-apps/signaly#192） |

**アイテム `Server`**（セキュアノート等・organization 共通。このリポジトリからは同期しない）

| フィールド名 | 内容 |
|-------------|------|
| `host` | サーバーのホスト名または IP（GitHub Actions の SSH / rsync 用） |
| `username` | SSH ユーザー名 |
| `ssh-port` | SSH ポート番号 |

**アイテム `DB`**（セキュアノート等・organization 共通。このリポジトリからは同期しない）

| フィールド名 | 内容 |
|-------------|------|
| `db-user` | MySQL ユーザー名（`DB_USER` として同期） |
| `db-password` | MySQL パスワード（`DB_PASSWORD` として同期） |
| `db-host` | MySQL ホスト（`DB_HOST` として同期） |
| `db-port` | MySQL ポート（`DB_PORT` として同期） |

**アイテム `githubaction-sshkey`**（「SSH 鍵」アイテム型・organization 共通。このリポジトリからは同期しない）

| フィールド ID | 内容 |
|-------------|------|
| `private_key` | サーバー接続用 SSH 秘密鍵（UI 表示は「秘密鍵」だが参照は ID を使う） |

Vault 名やアイテム名を変える場合は、`.github/secrets-manifest.tsv` の `SOURCE` 列（`op://...`）も合わせて更新してください。`SCOPE` が `inherit` の行はこのリポジトリでは同期していないため、更新先は organization 側の設定になります。日本語ラベル（`秘密鍵`）は secret reference に使えません。

正しい参照の確認:

```bash
op item get githubaction-sshkey --vault apps --format json | jq '.fields[] | {id, label, reference}'
op read "op://apps/githubaction-sshkey/private_key?ssh-format=openssh"
```

#### 1-2. Service Account を作成

1. 1Password で Service Account を作成し、`apps` 保管庫への読み取り権限を付与
2. 発行されたトークンを GitHub リポジトリの Secret に登録

| GitHub Secret | 内容 |
|---------------|------|
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password Service Account のトークン。**デプロイでは使いません。** `sync-secrets.yml` / `scripts/sync-github-secrets.sh` が 1Password から値を読んで GitHub へ同期するときだけ使います |

#### 1-3. 本番サーバーの初期セットアップ

デプロイは `github-user` など **sudo 権限のないユーザー** で SSH 接続します。サーバー管理者が初回のみ次を入れておくとスムーズです。

```bash
sudo apt update
sudo apt install -y python3-venv nodejs npm
```

`python3-venv` が無くても、デプロイ時の `deployment/ensure_venv.sh` が **sudo なし** で [virtualenv.pyz](https://bootstrap.pypa.io/virtualenv/virtualenv.pyz) から venv を作成します（Ubuntu 24.04 の PEP 668 でも system への `pip install` は不要）。PM2 はデプロイ workflow が `npx pm2` を使うため、グローバルインストールは必須ではありません（`nodejs` / `npm` は必要）。

手動で venv だけ作る場合（`github-user` で）:

```bash
cd /apps/myroom
rm -rf venv
curl -sS https://bootstrap.pypa.io/virtualenv/virtualenv.pyz -o /tmp/virtualenv.pyz
python3 /tmp/virtualenv.pyz venv
./venv/bin/python3 -m pip install -r requirements.txt
```

#### 1-4. 本番サーバーの `.env`

rsync では `.env` を転送しません。サーバー上の `.env` には、デプロイで同期しない設定も残します。

| 環境変数 | 管理方法 |
|----------|----------|
| `DB_MOCK` | デプロイ時に `false` を自動設定（本番は常に実 DB） |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | **サーバー `.env` には書きません。** DDL 権限を持つマイグレーション専用ユーザー（organization secret の `SHARED_DB_MIGRATE_USER` / `SHARED_DB_MIGRATE_PASSWORD`）を、`migrate_db.py` を実行する 1 コマンドの間だけ環境変数で渡します（#193） |

デプロイ時に **GitHub の secret / variable** から次の値が自動で `.env` に書き込まれます（既存の同名キーは上書き）。1Password は参照しません。

| 環境変数 | GitHub 側の名前 | スコープ |
|----------|----------------|----------|
| `SUPABASE_URL` | variable `SUPABASE_PROJECT_URL` | organization 共通 |
| `ALLOWED_GOOGLE_EMAILS` | secret `ALLOWED_GOOGLE_EMAILS` | このリポジトリ |
| `SENSOR_WEBHOOK_URL` | secret `SENSOR_WEBHOOK_URL` | このリポジトリ |
| `LOGIN_WEBHOOK_URL` | secret `SIGNALY_LOGIN_WEBHOOK_URL` | organization 共通 |
| `GARBAGE_NOTION_TOKEN` | secret `GARBAGE_NOTION_TOKEN` | このリポジトリ |
| `GARBAGE_NOTION_DATA_SOURCE_ID` | secret `GARBAGE_NOTION_DATA_SOURCE_ID` | このリポジトリ |
| `CLEANING_NOTION_TOKEN` | secret `CLEANING_NOTION_TOKEN` | このリポジトリ |
| `CLEANING_NOTION_DATA_SOURCE_ID` | secret `CLEANING_NOTION_DATA_SOURCE_ID` | このリポジトリ |
| `INTERNAL_API_KEY` | secret `INTERNAL_API_KEY` | このリポジトリ |
| `INTERNAL_CONTROL_API_KEY` | secret `INTERNAL_CONTROL_API_KEY` | このリポジトリ |
| `SHARED_TOKEN_API_SECRET` | secret `SHARED_TOKEN_API_SECRET` | このリポジトリ |
| `SHARED_TOKEN_API_URL` | variable `APP_BASE_URL` | organization 共通 |
| `NATURE_REMO_TOKEN` | secret `NATURE_REMO_TOKEN` | このリポジトリ |
| `DB_NAME` | secret `DB_NAME` | このリポジトリ |
| `DB_USER` | secret `SHARED_DB_USER` | organization 共通 |
| `DB_PASSWORD` | secret `SHARED_DB_PASSWORD` | organization 共通 |
| `DB_HOST` | secret `SHARED_DB_HOST` | organization 共通 |
| `DB_PORT` | secret `SHARED_DB_PORT` | organization 共通 |

`DB_MOCK` は `false` が固定で書き込まれます。フロントエンドのビルドに渡す `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` も、同じ organization variable から取ります。

### 2. デプロイフロー

`main` ブランチにプッシュすると GitHub Actions（`deploy.yml`）が起動し、以下を自動実行します。

1. `frontend/package.json` のバージョンから Git タグ（`v*`）を作成
2. フロントエンドのビルド（`npm run build` → `frontend/out` に静的出力）
3. ファイルの転送 (`rsync`)
4. GitHub の secret / variable から `SUPABASE_URL` / `ALLOWED_GOOGLE_EMAILS` / `SENSOR_WEBHOOK_URL` / `LOGIN_WEBHOOK_URL` / `GARBAGE_NOTION_*` / `CLEANING_NOTION_*` / `INTERNAL_API_KEY` / `INTERNAL_CONTROL_API_KEY` / DB 接続情報をサーバー `.env` に同期（対応は「1-4. 本番サーバーの `.env`」の表）
5. DB マイグレーション (`migrate_db.py`)
6. バックエンドの依存関係更新と PM2 による再起動（`pm2 restart` では cwd が変わらないため、毎回 `delete` → `start`）
7. **デプロイ成功後** GitHub Release を作成
8. CI 用 Webhook へデプロイ・リリース結果を Signaly 通知

※ Actions の `GITHUB_TOKEN` で push したタグは別ワークフローを起動しないため、Release も `deploy.yml` 内で実行します。手動でタグ push した場合のみ `release.yml` が走ります。

本番では FastAPI が `frontend/out` を配信し、API と UI を同一オリジンで提供します。

### 3. バージョン管理（npm version）

アプリのバージョンは `frontend/package.json` が正です。UI の表示と更新履歴はここから同期されます。`main` へのマージ時、GitHub Actions がこの値から `v3.0.0` 形式の Git タグと GitHub Release を自動作成します。

| ファイル | 役割 |
|----------|------|
| `frontend/package.json` | バージョン番号（`npm version` で更新） |
| `frontend/lib/app-version.ts` | package.json を読み込み表示 |
| `frontend/lib/app-changelog.ts` | 更新履歴（`npm version` 時に先頭へ枠を自動追加） |

#### リリース手順

`develop` でバージョンを上げてから `main` にマージします。タグは CI が `main` 上で付けるため、ローカルでは **`--no-git-tag-version`** を付けて `frontend/package.json` / `frontend/package-lock.json` だけ更新してください（ローカルでタグを作ると、マージ後のデプロイが「タグが既に別コミットを指している」として失敗します）。

```bash
git checkout develop
git pull

# patch: 2.4.0 → 2.4.1
npm run version:patch -- -m "Release v%s: 修正内容の要約"

# minor: 2.4.0 → 2.5.0
npm run version:minor -- -m "Release v%s: 機能追加の要約"

# major: 2.4.0 → 3.0.0
npm run version:major -- -m "Release v%s: 破壊的変更の要約"
```

`npm version` 実行時の流れ:

1. `typecheck` と `test`（`preversion`）
2. `package.json` / `package-lock.json` のバージョン更新
3. 環境変数 `RELEASE_CHANGELOG` に変更内容があれば、`changelog.ts` 先頭に新バージョンのエントリを追加
   （**空のときはエントリを作らず、バージョンだけが上がる**。仮の文言は入れない・#446）
4. 上記をまとめて git commit（**タグは作成しない**）

画面で体感できる変更があるのにエントリが作られなかった場合は、`changelog.ts` 先頭へ手で追記してから push してください。

```bash
# changelog を追記したら amend する例
git add frontend/lib/changelog.ts
git commit --amend --no-edit

git push origin develop

# PR を作成して main にマージ
```

同じバージョン番号で再デプロイする場合は、先にバージョンを上げてから `main` にマージする必要があります（タグが既に別コミットを指していると workflow がエラーになります）。
