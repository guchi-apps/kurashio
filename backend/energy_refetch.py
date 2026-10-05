"""消費電力の「指定日以降の再取得」の依頼と進み具合（#711）。

プラグ・エアコンのクラウドはサブPCの収集スクリプトが読んでいて、VPSのバックエンドからは
取り直せない。そのためこのモジュールは**依頼の印と、取得元ごとの完了印を保存して返すだけ**
にしている（`tapo_candidates.py` と同じ作り）。

流れ:
  1. 画面の「再取得」→ `request_refetch()` が `requested_at` と `since`（この日以降）を立てる
  2. 各収集（`tapo` 5分ごと・`aircon` 1時間ごと）が定期実行のたびに
     `GET /api/energy/refetch/request` で自分の依頼を見る
  3. 依頼があれば `since` 以降を取り直して `/api/energy` へ送り、`mark_done()` で完了を報告する
     （`/api/energy` は同じ `(date, source)` を上書きするので二重計上しない）

**保存先は `app_settings` の `energy_refetch` 1行**（DDL不要・#193）。DB_MOCK のときは
`data/energy_refetch.json`。
"""

from __future__ import annotations

import datetime
import json
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from . import atomic_json, database

JST = datetime.timezone(datetime.timedelta(hours=9))

STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "energy_refetch.json"
SETTING_KEY = "energy_refetch"

#: 再取得を受け付ける収集。値は「何日前まで遡れるか」。
#: tapo はプラグ本体の日別履歴（月初起点の92日ぶん）、aircon は1日1リクエスト（2秒間隔・
#: レート制限あり）なので短くする。
MAX_DAYS_BY_KIND: Dict[str, int] = {"tapo": 92, "aircon": 31}
KINDS = tuple(MAX_DAYS_BY_KIND)

#: 画面から依頼できる最大の遡り日数（一番長い収集に合わせる。短い収集は自分の上限へ切り詰める）
MAX_DAYS = max(MAX_DAYS_BY_KIND.values())

#: エアコンの収集が1時間ごとなので、1回遅れても待てる長さにする
REQUEST_TIMEOUT = datetime.timedelta(minutes=90)

# 読み込み→加工→書き戻しを囲む。同期ハンドラはスレッドプールで並行に動く
_lock = threading.Lock()


class RefetchError(ValueError):
    """依頼を受け付けられない（日付が不正・取得元が不明）。"""


class RefetchBusyError(RefetchError):
    """すでに依頼中で、重ねて受け付けない。"""


def _now(now: Optional[datetime.datetime] = None) -> datetime.datetime:
    """`main.get_now_jst()` は tz なしのJST時刻を返すので、ここでJSTを付けて比べられる形にする。"""
    current = now or datetime.datetime.now(JST)
    return current if current.tzinfo else current.replace(tzinfo=JST)


def _iso(now: Optional[datetime.datetime] = None) -> str:
    return _now(now).replace(microsecond=0).isoformat()


def _parse_time(value: Any) -> Optional[datetime.datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=JST)


def _parse_date(value: Any) -> Optional[datetime.date]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        return None


def _empty() -> Dict[str, Any]:
    return {"requested_at": None, "since": None, "done": {}}


def _load(db: Optional[Session]) -> Dict[str, Any]:
    if database.DB_MOCK or db is None:
        data = atomic_json.read_json(STATE_PATH, None)
    else:
        row = (
            db.query(database.AppSetting)
            .filter(database.AppSetting.setting_key == SETTING_KEY)
            .first()
        )
        try:
            data = json.loads(row.setting_value) if row is not None else None
        except (TypeError, ValueError):
            data = None
    if not isinstance(data, dict):
        return _empty()
    requested_at = data.get("requested_at")
    since = data.get("since")
    if _parse_time(requested_at) is None or _parse_date(since) is None:
        return _empty()
    raw_done = data.get("done") if isinstance(data.get("done"), dict) else {}
    done = {
        kind: raw_done[kind]
        for kind in KINDS
        if _parse_time(raw_done.get(kind)) is not None
    }
    return {"requested_at": requested_at, "since": since, "done": done}


def _write(db: Optional[Session], state: Dict[str, Any]) -> None:
    if database.DB_MOCK or db is None:
        atomic_json.write_json(STATE_PATH, state)
        return
    serialized = json.dumps(state, ensure_ascii=False)
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


def _kind_done(state: Dict[str, Any], kind: str) -> bool:
    requested = _parse_time(state.get("requested_at"))
    finished = _parse_time(state.get("done", {}).get(kind))
    return requested is not None and finished is not None and finished >= requested


def _in_time(state: Dict[str, Any], now: datetime.datetime) -> bool:
    requested = _parse_time(state.get("requested_at"))
    return requested is not None and now - requested < REQUEST_TIMEOUT


def is_pending(state: Dict[str, Any], now: Optional[datetime.datetime] = None) -> bool:
    """期限内で、まだ完了していない収集が1つでもある。"""
    current = _now(now)
    return _in_time(state, current) and not all(_kind_done(state, k) for k in KINDS)


def kind_pending(
    state: Dict[str, Any], kind: str, now: Optional[datetime.datetime] = None
) -> bool:
    """この収集がまだ取り直していない依頼がある（期限内）。"""
    return _in_time(state, _now(now)) and not _kind_done(state, kind)


def build_response(
    state: Dict[str, Any], now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    current = _now(now)
    sources = {}
    for kind in KINDS:
        if state.get("requested_at") is None:
            status = "idle"
        elif _kind_done(state, kind):
            status = "done"
        elif _in_time(state, current):
            status = "waiting"
        else:
            status = "timed_out"
        sources[kind] = {
            "status": status,
            "done_at": state.get("done", {}).get(kind) if status == "done" else None,
            "max_days": MAX_DAYS_BY_KIND[kind],
        }
    return {
        "requested_at": state.get("requested_at"),
        "since": state.get("since"),
        "pending": is_pending(state, current),
        "sources": sources,
    }


def get_state(
    db: Optional[Session] = None, now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    return build_response(_load(db), now)


def validate_since(since: datetime.date, today: datetime.date) -> None:
    if since > today:
        raise RefetchError("未来の日付は指定できません")
    if (today - since).days >= MAX_DAYS:
        raise RefetchError(f"{MAX_DAYS}日より前は取り直せません")


def request_refetch(
    since: datetime.date,
    db: Optional[Session] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """画面の「再取得」。依頼中に重ねて出すと待ちが延びるので受け付けない。"""
    current = _now(now)
    validate_since(since, current.astimezone(JST).date())
    with _lock:
        state = _load(db)
        if is_pending(state, current):
            raise RefetchBusyError("すでに再取得を依頼しています。完了してからやり直してください")
        state = {"requested_at": _iso(current), "since": since.isoformat(), "done": {}}
        _write(db, state)
        return build_response(state, current)


def get_request_for(
    kind: str,
    db: Optional[Session] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """収集が見る口。`requested_at` は完了報告のときにそのまま返してもらう。"""
    state = _load(db)
    pending = kind in KINDS and kind_pending(state, kind, now)
    return {
        "pending": pending,
        "since": state["since"] if pending else None,
        "requested_at": state["requested_at"] if pending else None,
    }


def mark_done(
    kind: str,
    requested_at: str,
    db: Optional[Session] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """収集の完了報告。**報告が指す依頼が今の依頼のときだけ**印を付ける。

    取得中に新しい依頼が入っていた場合、古い依頼の完了で新しい依頼を済みにしない。
    """
    if kind not in KINDS:
        raise RefetchError(f"不明な取得元です: {kind}")
    with _lock:
        state = _load(db)
        if state.get("requested_at") != requested_at:
            return build_response(state, now)
        state["done"] = {**state["done"], kind: _iso(now)}
        _write(db, state)
        return build_response(state, now)
