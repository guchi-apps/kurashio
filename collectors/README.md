# collectors — サブPCで動かす収集スクリプト

kurashio へデータを送る収集処理のうち、**外部のクラウドAPIを叩くだけで完結するもの**を置く。

```
AirCloud Home (白くまくんアプリ)        はぴeみる電のお知らせメール (Gmail)
        │ HTTPS                                │ IMAP
        ▼                                      ▼
     サブPC（systemd user timer・1時間ごと / 1日1回）
        │ HTTPS                                │ HTTPS
        ▼                                      ▼
  myroom.gucchii.com/api/energy          .../api/bills
        →  MySQL (daily_energy)                →  MySQL (utility_bills)
```

**日別の実測（`daily_energy`）と月次の請求（`utility_bills`）は別物。** 前者は機器ごとに
計測できている分、後者は電力会社が確定させた家全体の請求で、足し合わせると二重計上になる。
画面では並べて「請求のうちどこまでを機器ごとに追えているか」を出している。

## ラズパイとサブPCの分担

| 収集するもの | 動かす場所 | 理由 |
|---|---|---|
| SwitchBot の CO2・温湿度 | ラズパイ（`guchi-apps/pi0w_260719`） | BLE のアドバタイズを拾うため、センサーの近くに居る必要がある |
| エアコンの運転状態（5分ごと） | ラズパイ（同上） | すでに動いており、移す理由が無い |
| **エアコンの日別使用量（1時間ごと）** | **サブPC（ここ）** | クラウドAPI同士で完結し、ラズパイである必然性が無い |
| **Bambu Lab A1 mini の状態（常時購読）** | **サブPC（ここ）** | LAN内のローカルMQTT（TLS）へ繋ぐ。Python 3.11 以上と `cryptography` が要り、armv6 の Pi Zero W では導入が現実的でない |

エアコン関係が2箇所に分かれるため、AirCloud Home のクライアント実装もラズパイ側と
このディレクトリの2つある。**このディレクトリのクライアントは電気代の取得だけを持ち、
運転状態（`idu-list`）は移植していない。**

## aircon_energy_to_myroom.py

AirCloud Home から日別の電力使用量（kWh）と電気代（円）を取り、`POST /api/energy` へ送る。

- **エネルギー取得APIは期間の合計しか返さない**（`POST /rac/energy-consumptions/summary/v3?familyId=...`
  に `{"from": ..., "to": ...}` を渡す）。日別が要るので、**日付ごとに `from` と `to` に同じ日を入れて**引いている
- **応答には `energyConsumed`（kWh）だけでなく `cost`（円）も入っている。** これを `cost_yen` として
  送るので、エアコンの金額は kurashio 側で単価を掛けた目安ではなく**白くまくんアプリと同じ実額**になる
  （`allRacsData.currency` が `JPY` 以外なら送らない）
- **同じ `(date, source)` は kurashio 側で上書きされる。** 当日ぶんは1日のあいだ増えていくため、
  何度送っても二重計上にならない。既定では当日と前日の2日ぶんを送り直す（`ENERGY_DAYS`）
- 複数台ある場合は**全台の合計**を送る。1台だけにしたいときは `--unit`（`racName` か `vendorThingId`）
- レート制限（429）に当たったら、理由を出して終了コード1で終わる。次回の実行で取り直せばよい

### 依存

**`requests` だけ。** サブPCのシステムPython（3.12）に導入済みなので、venvを用意しなくても動く。
リポジトリの `venv/` はメインPCのpyenv（3.9.4）向けで、**サブPCでは壊れている**ので使わないこと。

`.env` の読み取りに `python-dotenv` は使っていない（サブPCに入っていないため、`KEY=value` を自前で読む）。

### 設定

`.env.example` を `collectors/.env` にコピーして実値を入れる（`.env` は gitignore 済み）。
実値は 1Password の `apps/MyRoom` から取る。リポジトリルートの `.env` も読むが、
`collectors/.env` のほうが優先される。

### 動作確認

```bash
cd ~/apps/myroom

# 登録されているエアコンの一覧
python3 collectors/aircon_energy_to_myroom.py --list-units

# 取得のみ（POSTしない）
python3 collectors/aircon_energy_to_myroom.py --dry-run --debug

# 未加工の応答（応答の形が想定と違うときの調査用）
python3 collectors/aircon_energy_to_myroom.py --dump-raw

# 特定の日だけ送り直す
python3 collectors/aircon_energy_to_myroom.py --date 2026-08-21

# 本番へ送る
python3 collectors/aircon_energy_to_myroom.py
```

> 調査元は海外向けホスト（`api-global-prod`）の Home Assistant 統合
> （[svmironov/aircloud_ha](https://github.com/svmironov/aircloud_ha)）。`api-kuma`（白くまくん＝国内向け）
> でも同じ形で通ることは確認済み。応答の形が変わった場合は `individualRacsData` が無いという
> エラーで止まるので、`--dump-raw` で実際の形を見ること。

### 収集が止まっていた期間を埋め直す

**毎時の実行が送るのは当日と前日の2日ぶんだけ**（`ENERGY_DAYS`）なので、収集や受け口が
半日以上止まると、その期間の日は**放っておいても埋まらない**。カードの「今月」「先月」の
合計からエアコンぶんが抜けたままになる（#204）。

AirCloud Home は過去の日付も返すので、`--days` で遡って送り直す。`(date, source)` は
上書きなので、すでに入っている日を含めても二重計上にならない。

```bash
cd ~/apps/myroom

# まず取れるか確認（POSTしない）
python3 collectors/aircon_energy_to_myroom.py --days 53 --dry-run

# 本番へ送る（日付ごとに1回・2秒間隔なので53日ぶんで2分ほどかかる）
python3 collectors/aircon_energy_to_myroom.py --days 53
```

- **カードが使うのは「先月1日」か「今日の29日前」の古いほうから今日まで**なので、
  月初なら60日ぶんほど遡れば足りる
- レート制限（429）に当たったら終了コード1で止まる。`--date` で日を分けるか、
  30分ほど空けてから残りの期間をやり直す

## tapo_to_myroom.py

Tapo スマートプラグ（P110系）の消費電力を LAN 内から読み、`POST /api/energy` へ送る（計測のみ）。
`python-kasa` が要るため、**専用の venv（`collectors/.venv-tapo/`）で動かす**
（`requirements-tapo.txt`）。設定は `tapo.env.example` を `collectors/.env` へ追記する。

```bash
cd ~/apps/myroom

# LAN 上の Tapo 機器を探して IP を調べる（初回の設定用）
# ここで IP を調べるのだから、TAPO_HOSTS はまだ空でよい（認証情報だけ要る）
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --list-devices

# 読み取るだけ（POSTしない）
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --dry-run -v

# 過去1か月ぶんを取り込む（プラグを増やしたとき・収集が長く止まったときに1度だけ）
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --days 31
```

### プラグを足したら自動で反映される（#660）

**`TAPO_HOSTS` は任意。** 収集のたびに LAN 上の Tapo 機器を探し、計測できるものを読む。
結果は `collectors/.tapo-hosts.json`（gitignore 済み）に1時間覚え、毎回 /24 を走査しないようにしている。
Tapo アプリで足したプラグは、最大1時間（キャッシュが切れた次の定期実行）で消費電力に出る。

```bash
# 今すぐ反映したいとき（キャッシュを捨てて探し直す）
collectors/.venv-tapo/bin/python collectors/tapo_to_myroom.py --rediscover
# または systemd から: キャッシュを消して service を起動
rm -f collectors/.tapo-hosts.json && systemctl --user start myroom-tapo-energy.service
```

**画面の「候補を更新」（#692）。** 消費電力の詳細 →「取得元の名前」の「Tapoの候補」欄のボタンを押すと、
バックエンドに更新依頼（`app_settings` の `tapo_candidates`）が立つ。収集は定期実行のたびに
`GET /api/energy/tapo-candidates/request` で依頼を見て、あれば探索キャッシュを捨てて探し直し、
見つかった機器（計測できない P100 なども含む）を `POST /api/energy/tapo-candidates` で送る。
**反映は次の定期実行（最大5分）。** VPS はプラグの LAN に届かないため、探索はここでしかできない。
`--dry-run` では依頼を見ない。

- `TAPO_HOSTS` に書いた行は**名前の固定**と**探索で見つからない機器の指定**に使う。表示名と Tapo の alias が一致すれば、探索した新しい IP へ自動的に置き換える
- 到達不能な `TAPO_HOSTS` は「IP が古い可能性があります」と WARNING に残し、その回に1度だけ探し直す。ほかの機器の取得・送信が成功していれば collector は成功終了する
- 探索はブロードキャスト→0台なら /24 のユニキャスト走査（下の ufw の節）。計測に対応しない機器（電球など）は対象外
- **名前はプラグ自身の alias。Tapo アプリで名前を変えると別の取得元になる**（記録は古い名前に残る）。
  固定したいときは `TAPO_HOSTS` に `IP=名前` を書く。DHCP 変更への追従には、この名前を Tapo 側の alias と同じに保つ

### 過去ぶんはプラグ本体から取れる

**P110 系は日別の使用量をプラグ自身が覚えている。** `get_energy_data`（`interval=1440`）で
月初起点の 92 日ぶんが Wh の配列として返るため、収集を始める前の日や、収集が止まっていた
あいだの日も後から埋められる（#208）。

- 既定は `--days 3`（当日＋直近2日）。当日ぶんは1日のあいだ増えていくので、直近の確定値も
  送り直して最終値へ寄せる。**5分ごとの定期実行で毎回30行を書き直すのは重いので、
  1か月ぶんは既定にしない**
- **計測を始める前の日も `0` が返る。** 「まだ計測していない日」と「本当に0だった日」は
  区別できないため、返ってきた履歴全体で最初に0でなかった日より前は送らない
  （プラグを付ける前の日が0で埋まり、グラフが平らに伸びるのを防ぐ）。その日以降の0は
  「使わなかった日」として送る
- **瞬時電力（`power_w`）が付くのは当日ぶんだけ。** 過去ぶんは日別の積算しか残っていない
- `--days` の上限は 92（プラグが返す履歴の長さ）。それ以前の日は取得できない

### ディスカバリーの応答は ufw に落とされる

**`--list-devices` が0台になっても、プラグが応答していないとは限らない。**
ブロードキャスト（255.255.255.255）宛に投げた問い合わせへの応答は、送信元がプラグ個々の
IP になるため conntrack の ESTABLISHED に一致しない。サブPCは ufw が
`DEFAULT_INPUT_POLICY="DROP"` なので、応答は届いたそばから捨てられる（#199）。

```
[UFW BLOCK] IN=enp1s0 SRC=192.168.2.143 DST=192.168.2.167 PROTO=UDP SPT=20002 DPT=34149
```

- **ユニキャストなら通る。** そのため `--list-devices` はブロードキャストが空だったときに、
  同じサブネットを1台ずつ当たり直す（/24 でおよそ12秒。範囲は `--scan 192.168.2.0/23` で指定）
- **収集本体（`--dry-run`・定期実行）は最初からユニキャスト**なので、この状態でも普通に読める。
  ブロードキャストが0台でも、`TAPO_HOSTS` に IP さえ書いてあれば消費電力は取れる
- ufw 側で通すなら `ufw allow proto udp from <LAN>/24 port 20002`（送信元ポート指定）だが、
  ufw はサブPCのリポジトリで Git 管理していないため、今のところ手作業になる

### 読み終えたら必ず切断する

python-kasa の `Device` は aiohttp のセッションを握る。`disconnect()` せずに捨てると解放時に
`Unclosed client session` を **ERROR で** 吐き、送信自体は成功しているのに
`journalctl --user -u myroom-tapo-energy.service` では失敗に見える。`close_device()` を通すこと。

## kepco_bill_to_myroom.py

関西電力「はぴeみる電」が検針のたびに送ってくる**お知らせメール**を Gmail から IMAP で読み、
月ごとの確定請求（電気・ガス）を `POST /api/bills` へ送る。設定は `kepco.env.example` を
`collectors/.env` へ追記する。

**依存は `requests` だけ。** IMAP もメールの解析も Python 標準ライブラリ（`imaplib` / `email`）
で足りる。

```bash
cd ~/apps/myroom

# 取得のみ（POSTしない）。何通が請求として読めたかが出る
python3 collectors/kepco_bill_to_myroom.py --dry-run --debug

# 直近3か月だけ見る
python3 collectors/kepco_bill_to_myroom.py --months 3 --dry-run

# 該当したメールの本文をそのまま出す（書式が変わったときの調査用）
python3 collectors/kepco_bill_to_myroom.py --dump-raw

# 本番へ送る
python3 collectors/kepco_bill_to_myroom.py
```

### なぜサイトを読みに行かないのか

**はぴeみる電に公開APIは無い。** サイトはCapyのパズル認証で守られており、さらに
**2026年3月10日から「初めての環境からのログインは2段階認証が必須」**になった
（マイページで「希望しない」に設定していても、新しい端末・ブラウザ・通信環境からは
認証番号の入力を求められる）。自動ログインで画面を読む方式は、いつ止まってもおかしくない。

`curl` で `kepco.jp` を叩くと **403** が返る点も同じ話で、素のHTTPクライアントは弾かれる。

いっぽうお知らせメールは検針のたびに決まった書式で届き、請求金額・使用量・契約種別が
そのまま本文に載っている。**サイトのCSVも月次の検針結果しか持たない**ので、メールから
取れる情報はCSVと同じ粒度になる。

### 本文の書式で気をつける点

- **見出しは行頭に固定して探す。** 電気のメールには前置きとして
  「メール本文に、【契約種別】の記載がある場合はご請求金額のお知らせ、…」という説明文があり、
  固定しないと契約種別としてこの一文を拾う
- **電気とガスで見出しの文言が違う。** 電気は太陽光発電の振込通知にも同じ件名を使うため
  `【ご請求（振込）年月】`・`【ご請求（予定）金額】` のように括弧が挟まる。ガスは
  `【ご請求年月】`・`【ご請求金額】`
- **`【契約種別】` が無い電気のメールは請求ではない。** 太陽光発電等を契約している場合の
  「振込金額のお知らせ」で、請求として数えると売電が支出に混ざる（本文にその旨が書かれている）
- **種別は使用量の単位で決める**（`kWh` なら電気、`立方メートル` ならガス）。件名の文言より確実
- **引越しの月は旧契約と新契約の2通が届く**（2026年4月に実例）。`utility_bills` は
  お客さま番号のハッシュ（先頭12文字）まで主キーに含めるので、片方が上書きで消えない。
  画面では月ごとに合算して出す
- 本文の文字コードは **ISO-2022-JP**

## bambu_to_myroom.py

Bambu Lab A1 mini の状態を**LAN内のローカルMQTT**（TLS・8883）から読み、`POST /api/bambu/state`
へ送る（#428）。kurashio は正規化して `app_settings` の `bambu_printer_state` に**最新の1件だけ**を
持ち、`GET /api/internal/bambu/printer`（`INTERNAL_API_KEY` の Bearer）で返す。

**読み取りのみ。印刷を操作するコマンドは送らない。** 例外は状態の再要求（`pushing.pushall`）だけ。

```
A1 mini ──MQTT/TLS 8883──▶ サブPC（常駐 service）──HTTPS──▶ /api/bambu/state
  device/<serial>/report      差分を全状態へマージ            └ app_settings（最新1件）
                                                              ▼
                                        GET /api/internal/bambu/printer（AIDE が読む）
```

- **常駐させる。** 他の収集は timer の周期実行だが、購読は常時接続なので service（`Type=simple`・
  `Restart=always`）で持つ。プリンターの電源断・LAN断・アクセスコード変更ではスクリプト自身が
  バックオフしながら再接続する（2秒から倍々で最大120秒）
- **LAN Only Mode は有効にしない。** クラウドへ紐付けたまま、`bblp` ＋ LANアクセスコードで
  ローカルMQTTへ繋がる。有効にすると Bambu アカウントとの紐付けが切れる（Bambu Handy・
  クラウド経由の送信・MakerWorld 連携が使えなくなる）
- **`report` は差分で届く。** 購読するだけでは初期状態が埋まらないので、接続直後に `pushall` を
  1回要求して全状態（約65項目）を受け取り、以降の差分を重ねる。**P1/A1 系は更新値のみを送る
  作りなので `pushall` は5分以上あける**（再接続が続いても割らない）
- **古い値を現在値として返さない。** 収集は変化のたびと、変化が無くても60秒ごとに送る。
  kurashio は最後の受信から180秒（`BAMBU_STALE_SECONDS`）を超えると `connection: "collector_stale"`、
  プリンターに繋がっていないと `"printer_offline"` にし、どちらも現在値（`printer`）を `null`
  にして最後の値を `lastKnown` へ分ける
- 証明書は BBL CA による自己署名。プリンター自身の証明書を信頼の起点にして、ホスト名の検証だけを省く
- **A1 mini に AMS Lite が繋がっていない構成では `ams.units` は空で、外付けスプール
  （`externalSpool`）だけが入る。** 実機（AMS Lite なし）でしか確認できていないので、AMS Lite を
  繋いだときのスロット・残量の値は、繋いだ最初に `--dry-run -v` と内部APIの応答で確かめること

### 造形の使用量（3mf）と在庫への自動差し引き（#454）

**MQTT の `report` にフィラメントのグラム数は無い。** 代わりに、造形が始まったことを検出したら、
プリンターSDの3mf（`/cache/<subtask_name>`）を **FTPS（990番・暗黙的TLS・`bblp` ＋ アクセスコード）で
読み取り専用に取り**、`Metadata/slice_info.config` の `<filament used_g="…">` を `job_filament` として
状態と一緒に送る。**スライサーの予定値で、実測ではない。** 実機で `50x110 ケース.3mf` = 24.41 g を確認した。

- **追加の依存は無い。** `ftplib`・`zipfile`（標準ライブラリ）だけ。接続情報も MQTT と同じ3項目
- **造形の開始ごとに `job_key`（`<ファイル名>@<開始時刻>`）を作る。** 同じファイルの再印刷は別の造形。
  kurashio はこれで使用量を二重に引かない。**収集を再起動すると、造形の途中でも新しい `job_key` になる**
  （引くのは終わった瞬間の1回だけなので、二重にはならない）
- 3mf は FTPS を別スレッドで読む（数秒かかる）。**読めなければ 5・30・120 秒あけて再試行し、それでも
  だめならその造形は諦める**（`3mf から使用量を読めませんでした` の WARNING。手入力で直せる）。
  クラウド経由の印刷・SDカードなし・複数プレートの 3mf は読めない（INFO のログだけ）
- 造形が終わっても `job_filament` は次の造形が始まるまで送り続ける（完了の瞬間に kurashio が受け取るため）
- kurashio は**完了（FINISH）で予定値そのまま、停止（FAILED）で進捗率で按分した概算**を、
  **使用中のスプール**へ自動で記録する。使うフィラメントが1色のときだけ（複数色は引かない）。
  使用中のスプールを外しておけば自動では引かれない
- 確認は `--dry-run` で足りる（`job_filament=` の行が出る）

### 依存

**`paho-mqtt` だけで、専用の venv に入れる**（バックエンドの `requirements.txt` には入れない。
VPS はプリンターと同じLANにいないため。Tapo の `python-kasa` と同じ分け方）。

```bash
python3 -m venv collectors/.venv-bambu
collectors/.venv-bambu/bin/pip install -r collectors/requirements-bambu.txt
```

### 設定

`bambu.env.example` の3項目を `collectors/.env` へ追記する（`BAMBU_HOST` / `BAMBU_SERIAL` /
`BAMBU_ACCESS_CODE`）。**1Password・GitHub secret には置かない**——3つとも
プリンター本体からいつでも読み直せる値のため。

- **IP アドレス** — ルーターで固定割り当て（DHCP予約）にしておく。変わると
  「接続できません（プリンターの電源・BAMBU_HOST の IP アドレスを確認）」がログに出る
- **LAN アクセスコード** — プリンター本体の画面（設定の WLAN の項目。機種・ファームウェアで
  メニュー名が違うことがある）に表示される8桁。
  **再生成すると変わる**ので、変えたら `collectors/.env` を直して service を再起動する。
  古いままだと「MQTT の接続が拒否されました…アクセスコードが変わった可能性があります」が出続ける
- **シリアル番号** — 本体のラベル、または Bambu Handy / Bambu Studio のデバイス情報

**シリアル番号とアクセスコードはログに出ない**（`MaskingFormatter` が最終出力を伏せる）。
Issue・PR・チャットへ貼るときも実値を含めないこと。

### 動作確認

```bash
# 15秒だけ繋いで、受け取った全状態の要約を出す（POSTしない）
collectors/.venv-bambu/bin/python collectors/bambu_to_myroom.py --dry-run --once 15 -v

# ローカルのバックエンド（DB_MOCK）へ送って、内部APIまで通す
MYROOM_BAMBU_API_URL=http://localhost:8000/api/bambu/state \
  collectors/.venv-bambu/bin/python collectors/bambu_to_myroom.py --once 15
curl -s -H "Authorization: Bearer $INTERNAL_API_KEY" http://localhost:8000/api/internal/bambu/printer
```

`connected=True ... （65項目）` が出れば、接続・TLS・アクセスコード・`pushall` の応答まで通っている。

### ファームウェア更新で変わったときの見つけ方

次のログ（WARNING）が出たら、項目や接続条件が変わった合図。**同じ内容は1度しか出ない**ので、
`journalctl --user -u myroom-bambu.service | grep WARNING` でさかのぼって探す。

| ログ | 意味 |
|---|---|
| `既知のリストに無い項目が届きました` | `print` に新しい項目が増えた。`KNOWN_PRINT_KEYS`（`bambu_to_myroom.py`）へ足すか、必要なら正規化（`backend/bambu.py`）へ取り込む |
| `全状態に想定している項目がありません` | 項目名が変わった。正規化がその項目を `null` で返し続けるので、`EXPECTED_KEYS`（両方）と `build_snapshot()` を直す |
| `未知の gcode_state を受け取りました` | 状態が増えた（kurashio 側のログ）。`STATE_MAP`（`backend/bambu.py`）へ足す。それまで `state` は `"unknown"` |
| `print 以外の種別のメッセージ` | `report` に `print` 以外（`info`・`system` など）が流れ始めた |
| `pushall に…応答がありません` | 要求の間隔が短すぎる、または `pushall` の仕様が変わった |
| `TLS の証明書検証に失敗しました` | 繋ぎ先がプリンターではない、または証明書が変わった |
| `3mf から使用量を読めませんでした` | 再試行を使い切った。FTPS（990）が開いているか・SDカードの有無・クラウド経由の印刷でないかを見る。在庫へは自動で引かれないので、手入力で記録する |

## 定期実行

ユニットは [`systemd/`](systemd/) にある。`aide` と同じく
**サブPCの `~/.config/systemd/user/` へ手でコピーする**（リポジトリからは自動反映されない）。

```bash
cp collectors/systemd/myroom-aircon-energy.service collectors/systemd/myroom-aircon-energy.timer \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now myroom-aircon-energy.timer

systemctl --user list-timers myroom-aircon-energy.timer
journalctl --user -u myroom-aircon-energy.service -n 50
```

Tapo ぶん（5分ごと）も同じ手順で、ユニット名を `myroom-tapo-energy` に読み替える。
はぴeみる電ぶん（1日1回）は `myroom-kepco-bill` に読み替える。

**Bambu ぶんだけは timer ではなく常駐 service**（`myroom-bambu.service`）。`enable --now` するのは
service 本体で、timer は無い。venv（`collectors/.venv-bambu`）を先に作っておくこと。

```bash
cp collectors/systemd/myroom-bambu.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now myroom-bambu.service

systemctl --user status myroom-bambu.service
journalctl --user -u myroom-bambu.service -f
```
