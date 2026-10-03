"""Tapo スマートプラグの「候補一覧」と更新依頼（#692）。

プラグはサブPCと同じLANにいて、VPSのバックエンドからは探せない。そのため探索は
サブPCの収集スクリプト（`collectors/tapo_to_myroom.py`）が行い、このモジュールは
**依頼の印と、受け取った候補の一覧を保存して返すだけ**にしている。

流れ:
  1. 画面の「候補を更新」→ `request_refresh()` が `requested_at` を立てる
  2. 収集が定期実行のたびに `GET /api/energy/tapo-candidates/request` で `pending` を見る
  3. `pending` なら探索し直し、`POST /api/energy/tapo-candidates` で候補を送る
     → `save_devices()` が `updated_at` を `requested_at` 以降へ進めて依頼を済みにする

**保存先は `app_settings` の `tapo_candidates` 1行**（DDL不要・本番のアプリ用DBユーザーに
CREATE権限が無い・#193）。DB_MOCK のときは `data/tapo_candidates.json`。
"""

from __future__ import annotations

import datetime
import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from . import atomic_json, database

JST = datetime.timezone(datetime.timedelta(hours=9))

STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "tapo_candidates.json"
SETTING_KEY = "tapo_candidates"

#: 受け付ける候補の最大数。家庭のLANで数十台を超えるのは打ち間違いか不正な送信
MAX_DEVICES = 64
MAX_TEXT_LENGTH = 100
# 5分ごとの収集が1回遅れても待てるよう、依頼は15分で期限切れにする（#701）。
REFRESH_TIMEOUT = datetime.timedelta(minutes=15)

# 読み込み→加工→書き戻しを囲む。同期ハンドラはスレッドプールで並行に動く
_lock = threading.Lock()


def _now_iso(now: Optional[datetime.datetime] = None) -> str:
    return (now or datetime.datetime.now(JST)).replace(microsecond=0).isoformat()


def _parse(value: Any) -> Optional[datetime.datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=JST)


def _text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:MAX_TEXT_LENGTH] if text else None


def normalize_devices(raw: Any) -> List[Dict[str, Any]]:
    """収集から届いた候補を整える。形の合わない行は落とし、同じIPは先の行を残す。"""
    devices: List[Dict[str, Any]] = []
    seen = set()
    if not isinstance(raw, list):
        return devices
    for item in raw:
        if not isinstance(item, dict):
            continue
        host = _text(item.get("host"))
        if host is None or host in seen:
            continue
        seen.add(host)
        devices.append(
            {
                "host": host,
                "name": _text(item.get("name")) or host,
                "model": _text(item.get("model")),
                "measurable": bool(item.get("measurable")),
            }
        )
        if len(devices) >= MAX_DEVICES:
            break
    return devices


def _empty() -> Dict[str, Any]:
    return {"requested_at": None, "updated_at": None, "devices": []}


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
    return {
        "requested_at": data.get("requested_at") if _parse(data.get("requested_at")) else None,
        "updated_at": data.get("updated_at") if _parse(data.get("updated_at")) else None,
        "devices": normalize_devices(data.get("devices")),
    }


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


def _unanswered(state: Dict[str, Any]) -> bool:
    requested = _parse(state.get("requested_at"))
    if requested is None:
        return False
    updated = _parse(state.get("updated_at"))
    return updated is None or updated < requested


def is_pending(state: Dict[str, Any], now: Optional[datetime.datetime] = None) -> bool:
    """依頼があり、まだ候補が届いていない（依頼より新しい `updated_at` が無い）。"""
    requested = _parse(state.get("requested_at"))
    current = now or datetime.datetime.now(JST)
    return bool(requested and _unanswered(state) and current - requested < REFRESH_TIMEOUT)


def build_response(
    state: Dict[str, Any], now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    pending = is_pending(state, now)
    return {**state, "pending": pending, "timed_out": _unanswered(state) and not pending}


def get_state(
    db: Optional[Session] = None, now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    return build_response(_load(db), now)


def request_refresh(
    db: Optional[Session] = None, now: Optional[datetime.datetime] = None
) -> Dict[str, Any]:
    """画面の「候補を更新」。すでに待っている依頼は立て直さない（押し直しで待ちが延びない）。"""
    with _lock:
        state = _load(db)
        if not is_pending(state, now):
            state = {**state, "requested_at": _now_iso(now)}
            _write(db, state)
        return build_response(state, now)


def save_devices(
    raw_devices: Any,
    db: Optional[Session] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """収集から届いた候補を保存する。`updated_at` は依頼より後になるよう進める。"""
    devices = normalize_devices(raw_devices)
    with _lock:
        state = _load(db)
        updated = _now_iso(now)
        requested = _parse(state.get("requested_at"))
        if requested is not None and _parse(updated) < requested:
            updated = state["requested_at"]
        state = {**state, "updated_at": updated, "devices": devices}
        _write(db, state)
        return build_response(state, now)
