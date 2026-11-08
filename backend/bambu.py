"""Bambu Lab A1 mini の状態を受け取り、正規化して返す（#428）。

プリンターはLAN内のローカルMQTTから読める。購読はサブPCの常駐プロセス
（`collectors/bambu_to_myroom.py`）が持ち、差分で届く `report` を1つの全状態へ
マージしたうえで `POST /api/bambu/state` へ送ってくる。**このモジュールは受け取った
生の `print` を正規化して保存し、鮮度を判定して返すだけ**で、MQTTには繋がない。

**保存先は `app_settings` の `bambu_printer_state` 1行。** 保存するのは「最新の1件」だけ
なので、DDL（`migrate_db.py`）は要らない（本番のアプリ用DBユーザーにはCREATE権限が無い・#193）。
履歴（過去の印刷の一覧など）が要る場合は、時系列で伸びるためテーブルを足す別の話になる。
DB_MOCK のときは `data/bambu_state.json` へ書く（本番は `app_settings`、モックはファイルの二本立て）。

古い値を現在値として返さない
-----------------------------
- **収集プロセスが止まっている**（最後の受信から `BAMBU_STALE_SECONDS` 秒超）→ `online: false`・
  `connection: "collector_stale"`。収集が生きているあいだは接続状態を含めて毎分再送してくるので、
  ここが古くなるのは「サブPCの常駐が落ちている」ときだけ
- **収集は生きているがプリンターに繋がらない**（電源断・LAN断・認証失敗）→ `online: false`・
  `connection: "printer_offline"`
- どちらも `printer`（現在値）は `null` にし、最後に受け取った値は `lastKnown` へ分ける。
  呼ぶ側が `online` を見忘れても、古い温度や進捗率を「いま」の値として読めない

造形の使用量（#454）
--------------------
MQTT の `report` にグラム数は無い。サブPCの収集がプリンターSDの3mf（`slice_info.config` の `used_g`）を
FTPS で読み、`job_filament` として一緒に送ってくる（`normalize_job_filament()`）。**スライサーの予定値。**
造形が終わった（止まった）遷移のとき、`detect_filament_usage()` が在庫から引く量を返し、
`main.py` が `filament.record_auto_usage()` へ渡す（完了は予定値そのまま、停止は進捗率で按分した概算。
使うフィラメントが1色のときだけ）。

完了・停止・エラーの遷移は `detect_transition_events()` が `NotificationEvent` として組み立てる。
**この段階ではPush配信までは行わない**（AIDE側 guchi-apps/aide#378 との役割分担が決まってから
`notify_events.dispatch_push_event()` へ渡す）。

印刷完了後の「取り出した」（#464）
--------------------------------
完了（finished）・停止（failed）のまま次の印刷を始めるまで、カードの進捗表示が張り付く問題への
対応。レコードに `acknowledged` フラグを持たせ、`acknowledge_finished()`（ユーザーの「取り出した」
操作）がこれを立てる。**新しい印刷が始まった（`ACTIVE_STATES` へ遷移した）瞬間に
`record_state()` が自動でFalseへリセットする**ので、同じジョブ名で繰り返し印刷しても、
毎回の完了で改めてボタンが出る。識別子を持たせて比較する形にしなかったのはこのため。
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from . import atomic_json, database
from .notify_events import NotificationEvent

logger = logging.getLogger(__name__)

JST = datetime.timezone(datetime.timedelta(hours=9))

STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "bambu_state.json"

#: app_settings のキー。最新の状態を1行に持つ
SETTING_KEY = "bambu_printer_state"

#: 収集が生きているかの判定。収集側は最短でも1分ごとに再送する
DEFAULT_STALE_SECONDS = 180

#: 受信する生の report の大きさの上限。実機の全状態は数KBで、桁違いに大きければ形が変わっている
MAX_REPORT_BYTES = 200_000

#: 収集が3mfから読んだ使用量（`job_filament`）の上限。1本のスプール（`filament.MAX_USAGE_G`）を
#: 超える値は桁の読み違いか改ざんとして捨てる
MAX_JOB_FILAMENT_G = 5000.0
MAX_JOB_FILAMENTS = 16
MAX_JOB_KEY_LENGTH = 200

#: `gcode_state` → 画面向けの状態。**知らない値は "unknown" に倒し、警告を1回だけ出す**
#: （ファームウェア更新で状態が増えたときに気付くため）
STATE_MAP = {
    "IDLE": "idle",
    "INIT": "preparing",
    "SLICING": "preparing",
    "PREPARE": "preparing",
    "RUNNING": "printing",
    "PAUSE": "paused",
    "FINISH": "finished",
    "FAILED": "failed",
}
ACTIVE_STATES = {"preparing", "printing", "paused"}

#: `spd_lvl` → 印刷速度モード
SPEED_MODES = {1: "silent", 2: "standard", 3: "sport", 4: "ludicrous"}

#: HMS の重大度（`code` の上位16bit）
HMS_SEVERITIES = {1: "fatal", 2: "serious", 3: "common", 4: "info"}

#: これらが全状態に無いときは、項目名が変わった疑いがある（正規化が黙って null を返し続けないため）
EXPECTED_KEYS = (
    "gcode_state",
    "mc_percent",
    "mc_remaining_time",
    "layer_num",
    "total_layer_num",
    "subtask_name",
    "nozzle_temper",
    "nozzle_target_temper",
    "bed_temper",
    "bed_target_temper",
    "spd_lvl",
    "print_error",
    "hms",
    "ams",
)

#: 警告を出し済みの内容。同じ警告を毎回出さない（プロセスの寿命のあいだだけ覚える）
_warned: set = set()


def _warn_once(key: str, message: str, *args: Any) -> None:
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(message, *args)


def stale_seconds() -> int:
    """環境変数 `BAMBU_STALE_SECONDS`。読めない・0以下は既定値へ倒す。"""
    try:
        value = int(os.getenv("BAMBU_STALE_SECONDS", ""))
    except ValueError:
        return DEFAULT_STALE_SECONDS
    return value if value > 0 else DEFAULT_STALE_SECONDS


# --- 時刻 ---------------------------------------------------------------------


def now_jst() -> datetime.datetime:
    return datetime.datetime.now(JST)


def _parse_iso(value: Any) -> Optional[datetime.datetime]:
    """ISO8601文字列を tz付きで読む。オフセットが無ければJSTとして扱う。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST)


def _iso(value: Optional[datetime.datetime]) -> Optional[str]:
    return value.astimezone(JST).isoformat(timespec="seconds") if value else None


# --- 値の読み取り -------------------------------------------------------------


def _number(value: Any) -> Optional[float]:
    """数値として読めるものだけを返す（真偽値・空文字・NaNは除く）。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    return number if number == number else None  # NaN


def _int(value: Any) -> Optional[int]:
    number = _number(value)
    return int(number) if number is not None else None


def _temperature(value: Any) -> Optional[float]:
    number = _number(value)
    return round(number, 1) if number is not None else None


def _text(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def format_hms_code(attr: int, code: int) -> str:
    """HMS のコードを Bambu の表記（`HMS_0300_0100_0001_0007`）へ直す。"""
    return "HMS_{:04X}_{:04X}_{:04X}_{:04X}".format(
        (attr >> 16) & 0xFFFF, attr & 0xFFFF, (code >> 16) & 0xFFFF, code & 0xFFFF
    )


def format_print_error(value: int) -> str:
    """`print_error`（32bit整数）を `0300_4001` の形へ直す。"""
    return "{:04X}_{:04X}".format((value >> 16) & 0xFFFF, value & 0xFFFF)


def _normalize_hms(raw: Any) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    if not isinstance(raw, list):
        return entries
    for item in raw:
        if not isinstance(item, dict):
            continue
        attr = _int(item.get("attr"))
        code = _int(item.get("code"))
        if attr is None or code is None:
            continue
        severity = HMS_SEVERITIES.get((code >> 16) & 0xFFFF)
        entries.append({"code": format_hms_code(attr, code), "severity": severity})
    return entries


def _hex_color(value: Any) -> Optional[str]:
    """`RRGGBBAA` を `#RRGGBB` へ。8桁・6桁の16進だけを受け、他は null。"""
    text = _text(value)
    if text is None or len(text) not in (6, 8):
        return None
    try:
        int(text, 16)
    except ValueError:
        return None
    return "#" + text[:6].upper()


def _normalize_tray(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    material = _text(raw.get("tray_type"))
    remain = _int(raw.get("remain"))
    return {
        "slot": _int(raw.get("id")),
        "empty": material is None,
        "material": material,
        "brand": _text(raw.get("tray_sub_brands")),
        "color": _hex_color(raw.get("tray_color")) if material else None,
        # 1〜100 だけを残量として返す。-1 は「読めない」（RFIDの無い社外フィラメント）で、
        # 外付けスプールも実機では常に 0（追跡していない）を返す。0 を「残量0%」と読ませない
        "remainPercent": remain if remain is not None and 1 <= remain <= 100 else None,
    }


def _normalize_ams(raw_ams: Any, raw_external: Any) -> Dict[str, Any]:
    """AMS Lite のスロット・材料・色・残量。AMSが無い構成（外付けスプールだけ）も空で返す。"""
    units: List[Dict[str, Any]] = []
    tray_now: Optional[str] = None
    if isinstance(raw_ams, dict):
        tray_now = _text(raw_ams.get("tray_now"))
        for unit in raw_ams.get("ams") or []:
            if not isinstance(unit, dict):
                continue
            slots = [
                tray
                for tray in (_normalize_tray(item) for item in unit.get("tray") or [])
                if tray is not None
            ]
            units.append(
                {
                    "id": _int(unit.get("id")),
                    "humidity": _int(unit.get("humidity")),
                    "slots": slots,
                }
            )

    # tray_now: "254" は外付けスプール、"255" は未選択、それ以外はAMSのスロット番号
    if tray_now == "254":
        active_source, active_slot = "external", None
    elif tray_now is not None and tray_now.isdigit() and int(tray_now) < 254:
        active_source, active_slot = "ams", int(tray_now)
    else:
        active_source, active_slot = "none", None

    external = _normalize_tray(raw_external)
    return {
        "connected": bool(units),
        "units": units,
        "activeSource": active_source,
        "activeSlot": active_slot,
        "externalSpool": external if external and not external["empty"] else None,
    }


def _grams(value: Any) -> Optional[float]:
    number = _number(value)
    if number is None or number <= 0 or number > MAX_JOB_FILAMENT_G:
        return None
    return round(number, 2)


def normalize_job_filament(raw: Any, job_name: Optional[str]) -> Optional[Dict[str, Any]]:
    """収集が3mfの `slice_info.config` から読んだ、この造形の使用量（#454）。

    MQTT の `report` にグラム数は無いので、サブPCの収集がプリンターSD（`/cache/<subtask_name>`）を
    FTPS で読んで `job_filament` として一緒に送ってくる。**スライサーの予定値で、実測ではない。**

    - `job_key` は造形1回ごとの識別子（同じファイルの再印刷と区別する）。使用量の二重記録を防ぐ
    - **いま印刷中のジョブ名（`subtask_name`）と一致しないものは捨てる。** 前のジョブの値を
      次のジョブの使用量として見せないため
    """
    if not isinstance(raw, dict):
        return None
    job_key = _text(raw.get("job_key"))
    name = _text(raw.get("name"))
    if job_key is None or len(job_key) > MAX_JOB_KEY_LENGTH or name is None:
        return None
    if job_name is not None and name != job_name:
        return None

    filaments: List[Dict[str, Any]] = []
    for item in (raw.get("filaments") or [])[:MAX_JOB_FILAMENTS]:
        if not isinstance(item, dict):
            continue
        used = _grams(item.get("used_g"))
        if used is None:
            continue
        filaments.append(
            {
                "slot": _int(item.get("id")),
                "material": _text(item.get("type")),
                # 3mf の色は `#BCBCBC`。MQTT の `tray_color`（`BCBCBCFF`）と同じ関数で読むため `#` を外す
                "color": _hex_color((_text(item.get("color")) or "").lstrip("#")),
                "usedGrams": used,
            }
        )
    if not filaments:
        return None
    total = round(sum(item["usedGrams"] for item in filaments), 1)
    if total <= 0 or total > MAX_JOB_FILAMENT_G:
        return None
    return {"jobKey": job_key, "name": name, "totalGrams": total, "filaments": filaments}


# --- 正規化 -------------------------------------------------------------------


def missing_expected_keys(report: Dict[str, Any]) -> List[str]:
    return [key for key in EXPECTED_KEYS if key not in report]


def build_snapshot(
    report: Dict[str, Any],
    observed_at: datetime.datetime,
    job_filament: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """生の `print`（収集側でマージ済みの全状態）を、画面・AIDE向けの形へ正規化する。

    `observed_at` はプリンターから最後にメッセージを受けた時刻。残り時間からの
    終了予測はこれを起点にする（受信のたびに動く時刻を使うと、変化の無い再送のたびに
    終了予測が後ろへずれる）。

    `job_filament` は収集が3mfから読んだ使用量（`normalize_job_filament()` を参照）。
    """
    raw_state = _text(report.get("gcode_state"))
    state = STATE_MAP.get(raw_state or "", "unknown")
    if raw_state and state == "unknown":
        _warn_once(
            f"state:{raw_state}",
            "Bambu: 未知の gcode_state を受け取りました（ファームウェア更新で状態が増えた可能性）: %s",
            raw_state,
        )
    missing = missing_expected_keys(report)
    if missing and report:
        _warn_once(
            "missing:" + ",".join(missing),
            "Bambu: 想定している項目が report に見当たりません（項目名が変わった可能性）: %s",
            ", ".join(missing),
        )

    remaining = _int(report.get("mc_remaining_time"))
    active = state in ACTIVE_STATES
    remaining_minutes = remaining if active and remaining is not None and remaining > 0 else None
    finish_at = (
        observed_at + datetime.timedelta(minutes=remaining_minutes)
        if remaining_minutes is not None
        else None
    )

    percent = _int(report.get("mc_percent"))
    print_error_raw = _int(report.get("print_error"))
    speed_level = _int(report.get("spd_lvl"))
    job_name = _text(report.get("subtask_name")) or _text(report.get("gcode_file"))

    return {
        "state": state,
        "rawState": raw_state,
        "job": {
            "name": job_name,
            "progressPercent": percent if percent is not None and 0 <= percent <= 100 else None,
            "layer": _int(report.get("layer_num")),
            "totalLayers": _int(report.get("total_layer_num")),
            "remainingMinutes": remaining_minutes,
            "estimatedFinishAt": _iso(finish_at),
            "filament": normalize_job_filament(job_filament, job_name),
        },
        "nozzle": {
            "temperature": _temperature(report.get("nozzle_temper")),
            "target": _temperature(report.get("nozzle_target_temper")),
        },
        "bed": {
            "temperature": _temperature(report.get("bed_temper")),
            "target": _temperature(report.get("bed_target_temper")),
        },
        "speed": {
            "level": speed_level,
            "mode": SPEED_MODES.get(speed_level) if speed_level is not None else None,
        },
        "ams": _normalize_ams(report.get("ams"), report.get("vt_tray")),
        "errors": {
            "printError": (
                {"code": format_print_error(print_error_raw), "raw": print_error_raw}
                if print_error_raw
                else None
            ),
            "hms": _normalize_hms(report.get("hms")),
        },
    }


# --- 状態遷移 -----------------------------------------------------------------


def _error_codes(snapshot: Dict[str, Any]) -> set:
    """通知に値するエラーの集合。HMSは重大度が高いものだけ（情報レベルで鳴らさない）。"""
    errors = snapshot.get("errors") or {}
    codes = set()
    print_error = errors.get("printError")
    if print_error:
        codes.add("print:" + print_error["code"])
    for entry in errors.get("hms") or []:
        if entry.get("severity") in ("fatal", "serious"):
            codes.add(entry["code"])
    return codes


def detect_transition_events(
    previous: Optional[Dict[str, Any]],
    current: Dict[str, Any],
    occurred_at: datetime.datetime,
) -> List[NotificationEvent]:
    """前回の状態と比べ、完了・停止・一時停止・エラーの遷移を `NotificationEvent` にする。

    **「前回が無い」ときは何も出さない。** 起動直後・初回受信で完了済みのジョブ
    （プリンターは次のジョブまで FINISH のまま）を「いま完了した」と誤って通知しないため。
    `previous` が「収集が止まっていた間の古い状態」のときの判断は呼び出し側（`record_state`）が行う。
    """
    if previous is None:
        return []

    events: List[NotificationEvent] = []
    before = previous.get("state")
    after = current.get("state")
    job_name = (current.get("job") or {}).get("name") or "印刷"
    timestamp = _iso(occurred_at) or ""
    epoch = int(occurred_at.timestamp())

    def make(kind: str, title: str, body: str, priority: str) -> NotificationEvent:
        return NotificationEvent(
            kind=kind,
            title=title,
            body=body,
            priority=priority,
            url="/",
            occurred_at=timestamp,
            dedupe_key=f"{kind}-{epoch}",
        )

    if before != after:
        if after == "finished" and before in ACTIVE_STATES:
            events.append(
                make("bambu_print_finished", "3Dプリントが完了しました", job_name, "normal")
            )
        elif after == "failed" and before in ACTIVE_STATES:
            events.append(
                make("bambu_print_failed", "3Dプリントが停止しました", job_name, "high")
            )
        elif after == "paused" and before in ("printing", "preparing"):
            events.append(
                make("bambu_print_paused", "3Dプリントが一時停止しました", job_name, "normal")
            )

    new_errors = _error_codes(current) - _error_codes(previous)
    if new_errors:
        events.append(
            make(
                "bambu_error",
                "3Dプリンターでエラーが発生しました",
                "{}（{}）".format(job_name, ", ".join(sorted(new_errors))),
                "high",
            )
        )
    return events


def detect_filament_usage(
    previous: Optional[Dict[str, Any]], current: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """造形が終わった（止まった）遷移のときだけ、在庫から引く使用量を返す（#454）。

    - **完了（FINISH）は3mfの予定値をそのまま**返す。
    - **停止（FAILED・中断も含む）は進捗率で按分した概算**（`estimated: true`）。フィラメントは
      層ごとに均等には使われないので目安でしかなく、記録には「概算」の印を付けて取り消せるようにする
    - **使うフィラメントが1色のときだけ。** 複数色（AMS）は「どのスプールから何g」かを決められない
    - 前回が無い・前回も終わっていた場合は何も返さない（`detect_transition_events` と同じ理由で、
      再開直後に終わった造形を「いま終わった」と誤検出しない）
    """
    if previous is None:
        return None
    if previous.get("state") not in ACTIVE_STATES:
        return None
    after = current.get("state")
    if after not in ("finished", "failed"):
        return None

    job = current.get("job") or {}
    filament = job.get("filament")
    if not filament or len(filament.get("filaments") or []) != 1:
        return None

    total = filament["totalGrams"]
    if after == "finished":
        grams, estimated, percent = total, False, 100
    else:
        percent = job.get("progressPercent")
        if percent is None or percent <= 0:
            return None
        grams, estimated = round(total * min(percent, 100) / 100, 1), True
    if grams < 0.1:
        return None
    return {
        "job_key": filament["jobKey"],
        # 在庫の履歴のメモに使う。`benchy.gcode.3mf` ではなく `benchy` と読めるようにする
        "name": re.sub(r"(\.gcode)?\.3mf$", "", filament["name"], flags=re.IGNORECASE) or filament["name"],
        "grams": grams,
        "estimated": estimated,
        "percent": percent,
    }


# --- 保存 ---------------------------------------------------------------------


def _load_record(db: Optional[Session]) -> Optional[Dict[str, Any]]:
    if database.DB_MOCK or db is None:
        data = atomic_json.read_json(STATE_PATH, None)
    else:
        row = (
            db.query(database.AppSetting)
            .filter(database.AppSetting.setting_key == SETTING_KEY)
            .first()
        )
        if row is None:
            return None
        try:
            data = json.loads(row.setting_value)
        except (TypeError, ValueError):
            return None
    return data if isinstance(data, dict) else None


def _write_record(db: Optional[Session], record: Dict[str, Any]) -> None:
    if database.DB_MOCK or db is None:
        atomic_json.write_json(STATE_PATH, record)
        return
    serialized = json.dumps(record, ensure_ascii=False)
    row = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .first()
    )
    if row is None:
        db.add(database.AppSetting(setting_key=SETTING_KEY, setting_value=serialized))
    else:
        row.setting_value = serialized
    db.commit()


def get_record(db: Optional[Session] = None) -> Optional[Dict[str, Any]]:
    return _load_record(db)


# 状態レコードの「読み込み→加工→書き戻し」を囲むロック。バックエンドは同期ハンドラを
# スレッドプールで並行に処理するため、収集の POST と「取り出した」が同じ行を取り合う。
_record_lock = threading.Lock()


def acknowledge_finished(db: Optional[Session] = None) -> Optional[Dict[str, Any]]:
    """「取り出した」操作（#464）。現在の状態が完了・停止のときだけ確認済みにする。

    印刷中・待機中など対象外の状態で呼ばれても何も変えず、現在のレコードをそのまま返す
    （ボタンは対象の状態でしか出ないが、念のため）。**`record_state()` と同じ
    `_record_lock` の中で読み書きする。** 収集の定期POSTが読んでから書くまでの間に確認が
    入ると、`acknowledged` が古い値で上書きされ、押し直すまで完了表示が残るため（#500）。
    """
    with _record_lock:
        record = _load_record(db)
        if record is None:
            return None
        snapshot = record.get("snapshot")
        state = snapshot.get("state") if snapshot else None
        if state not in ("finished", "failed"):
            return record
        updated = {**record, "acknowledged": True}
        _write_record(db, updated)
        return updated


def record_state(
    *,
    connected: bool,
    report: Optional[Dict[str, Any]],
    last_message_at: Optional[str],
    db: Optional[Session] = None,
    now: Optional[datetime.datetime] = None,
    job_filament: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], List[NotificationEvent], Optional[Dict[str, Any]]]:
    """収集からの送信を保存し、検出した遷移のイベントと、在庫から引く使用量を返す。

    `report` が無い（プリンターに繋がっていない）ときは、保存済みの状態を残したまま
    接続状態と受信時刻だけを更新する。これが `lastKnown` の元になる。
    """
    with _record_lock:
        now = now or now_jst()
        previous = _load_record(db)
        previous_snapshot = previous.get("snapshot") if previous else None
        message_at = _parse_iso(last_message_at) or now

        events: List[NotificationEvent] = []
        usage: Optional[Dict[str, Any]] = None
        if report is not None:
            snapshot = build_snapshot(report, message_at, job_filament)
            # 収集が止まっていた間の古い状態とは比べない（再開直後に完了済みを誤検出しない）
            previous_received = _parse_iso(previous.get("received_at")) if previous else None
            previous_fresh = (
                previous_received is not None
                and (now - previous_received).total_seconds() <= stale_seconds()
            )
            if previous_fresh:
                events = detect_transition_events(previous_snapshot, snapshot, now)
                usage = detect_filament_usage(previous_snapshot, snapshot)
        else:
            snapshot = previous_snapshot

        # 新しい印刷が始まったら「取り出した」の確認状態をリセットする（#464）。report が無い
        # （プリンターに繋がっていない）ときは snapshot が変わらないので、確認状態も維持する
        if report is not None and snapshot is not None and snapshot.get("state") in ACTIVE_STATES:
            acknowledged = False
        else:
            acknowledged = bool((previous or {}).get("acknowledged"))

        record = {
            "received_at": _iso(now),
            "connected": bool(connected),
            "last_message_at": _iso(message_at) if report is not None else (previous or {}).get("last_message_at"),
            "snapshot": snapshot,
            "acknowledged": acknowledged,
        }
        _write_record(db, record)

    if previous is not None and previous.get("connected") != record["connected"]:
        logger.info(
            "Bambu: プリンターとの接続が%sになりました",
            "確立" if record["connected"] else "切断",
        )
    for event in events:
        logger.info("Bambu: 状態遷移を検出しました kind=%s job=%s", event.kind, event.body)
    return record, events, usage


# --- 応答 ---------------------------------------------------------------------


def build_response(
    record: Optional[Dict[str, Any]], now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    """`GET /api/internal/bambu/printer` の応答を組み立てる。

    現在値（`printer`）は `online` のときだけ入れる。呼ぶ側が古い値を現在値として
    読まないよう、経過秒（`ageSeconds`）と切断の理由（`connection`）も返す。
    """
    now = now or now_jst()
    threshold = stale_seconds()
    base: Dict[str, Any] = {
        "fetchedAt": _iso(now),
        "staleThresholdSeconds": threshold,
    }
    if not record:
        return {
            **base,
            "configured": False,
            "connection": "no_data",
            "online": False,
            "stale": True,
            "lastUpdateAt": None,
            "ageSeconds": None,
            "lastMessageAt": None,
            "messageAgeSeconds": None,
            "printer": None,
            "lastKnown": None,
        }

    received_at = _parse_iso(record.get("received_at"))
    message_at = _parse_iso(record.get("last_message_at"))
    age = int((now - received_at).total_seconds()) if received_at else None
    stale = age is None or age > threshold

    if stale:
        connection = "collector_stale"
    elif not record.get("connected"):
        connection = "printer_offline"
    else:
        connection = "online"
    online = connection == "online"

    snapshot = record.get("snapshot")
    if snapshot is not None:
        snapshot = {**snapshot, "acknowledged": bool(record.get("acknowledged"))}
    return {
        **base,
        "configured": True,
        "connection": connection,
        "online": online,
        "stale": stale,
        "lastUpdateAt": _iso(received_at),
        "ageSeconds": age,
        "lastMessageAt": _iso(message_at),
        "messageAgeSeconds": int((now - message_at).total_seconds()) if message_at else None,
        "printer": snapshot if online else None,
        "lastKnown": None if online else snapshot,
    }
