"""端末（Apple Watch・iPhoneウィジェット）が、アプリを閉じている間も値を読むための
読み取り専用トークン（#681）。

- ログイン済みのWeb（ユーザーJWT）が `issue_token()` で発行し、iPhone経由で端末へ渡す。
  端末はこのトークンだけで `GET /api/device/sensors` を読む。**書き込みの口は無い**
- DBには**ハッシュだけ**を持つ（平文は発行時に1度だけ返す）。端末ごとに失効できる
- 保存は `app_settings` の `device_tokens` 1行（DB_MOCK は `data/device_tokens.json`）。
  マイグレーションは足していない。全操作は `_update()` の排他区間を通す（`filament.py` と同じ理由）
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import secrets
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import atomic_json, database

JST = datetime.timezone(datetime.timedelta(hours=9))

FILE_PATH = Path(__file__).resolve().parent.parent / "data" / "device_tokens.json"
SETTING_KEY = "device_tokens"

#: 発行できる上限。再インストールのたびに増えるので、超えたら古いものから捨てる
MAX_TOKENS = 10
TOKEN_PREFIX = "kdt_"

_db_lock = threading.Lock()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalize(raw: Any) -> List[Dict[str, Any]]:
    items = raw.get("tokens") if isinstance(raw, dict) else None
    result: List[Dict[str, Any]] = []
    for item in items if isinstance(items, list) else []:
        if (
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and isinstance(item.get("hash"), str)
        ):
            result.append(
                {
                    "id": item["id"],
                    "hash": item["hash"],
                    "label": str(item.get("label") or "")[:40],
                    "created_at": str(item.get("created_at") or ""),
                    "last_used_at": item.get("last_used_at"),
                }
            )
    return result[-MAX_TOKENS:]


def _parse_row(row: Optional[database.AppSetting]) -> Any:
    if row is None:
        return None
    try:
        return json.loads(row.setting_value)
    except (TypeError, ValueError):
        return None


def _lock_row(db: Session) -> database.AppSetting:
    query = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .with_for_update()
    )
    row = query.first()
    if row is None:
        try:
            db.add(database.AppSetting(setting_key=SETTING_KEY, setting_value="{}"))
            db.commit()
        except IntegrityError:
            db.rollback()
        row = query.first()
    assert row is not None
    return row


def _read(db: Optional[Session]) -> List[Dict[str, Any]]:
    if database.DB_MOCK or db is None:
        return _normalize(atomic_json.read_json(FILE_PATH, None))
    row = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .first()
    )
    return _normalize(_parse_row(row))


def _update(
    db: Optional[Session], mutate: Callable[[List[Dict[str, Any]]], None]
) -> List[Dict[str, Any]]:
    """読み込み・加工・書き戻しを1つの排他区間で行う。"""

    def apply(raw: Any) -> Dict[str, Any]:
        tokens = _normalize(raw)
        mutate(tokens)
        return {"tokens": _normalize({"tokens": tokens})}

    if database.DB_MOCK or db is None:
        return atomic_json.update_json(FILE_PATH, None, apply)["tokens"]

    with _db_lock:
        try:
            row = _lock_row(db)
            document = apply(_parse_row(row))
            row.setting_value = json.dumps(document, ensure_ascii=False)
            db.commit()
            return document["tokens"]
        except BaseException:
            db.rollback()
            raise


def issue_token(label: str, db: Optional[Session] = None) -> Dict[str, str]:
    """新しいトークンを発行する。平文が取れるのはこの戻り値だけ。"""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    entry = {
        "id": secrets.token_hex(4),
        "hash": _hash(token),
        "label": label.strip()[:40],
        "created_at": datetime.datetime.now(JST).isoformat(timespec="seconds"),
        "last_used_at": None,
    }
    _update(db, lambda tokens: tokens.append(entry))
    return {"id": entry["id"], "token": token}


def revoke_token(token_id: str, db: Optional[Session] = None) -> bool:
    found = False

    def mutate(tokens: List[Dict[str, Any]]) -> None:
        nonlocal found
        kept = [item for item in tokens if item["id"] != token_id]
        found = len(kept) != len(tokens)
        tokens[:] = kept

    _update(db, mutate)
    return found


def list_tokens(db: Optional[Session] = None) -> List[Dict[str, Any]]:
    """一覧（ハッシュは返さない）。"""
    return [
        {k: item[k] for k in ("id", "label", "created_at", "last_used_at")}
        for item in _read(db)
    ]


def verify_token(token: Optional[str], db: Optional[Session] = None) -> bool:
    """トークンが有効か。定数時間で比べる。使用時刻は書かない（読み取りのたびに書き込まない）。"""
    if not token or not token.startswith(TOKEN_PREFIX):
        return False
    digest = _hash(token)
    matched = False
    for item in _read(db):
        if hmac.compare_digest(item["hash"], digest):
            matched = True
    return matched
