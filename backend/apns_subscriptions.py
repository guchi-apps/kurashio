"""iOSアプリ（Apple Push Notification service）のデバイストークンの永続化。

`push_subscriptions.py`（Web Push・#293）と同じ考え方で、画面から編集する設定ではなく
「端末が登録した状態」に近いため `app_settings`（DB）ではなく gitignore 済みのJSONファイルに
保存する（DDL不要・DB_MOCKでも動く。#527）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import atomic_json

JST = timezone(timedelta(hours=9))
#: 端末のトークンが有効なAPNsの環境。開発ビルドは sandbox、TestFlight/App Store は production
ENVIRONMENTS = ("sandbox", "production")
TOKENS_PATH = Path(__file__).resolve().parent.parent / "data" / "apns_tokens.json"


def _now_iso() -> str:
    return datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")


def _sanitize_items(data: Any) -> List[Dict[str, Any]]:
    if not isinstance(data, list):
        return []
    result = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("token"), str) and item["token"]:
            result.append(item)
    return result


def list_tokens() -> List[str]:
    return [item["token"] for item in _sanitize_items(atomic_json.read_json(TOKENS_PATH, []))]


def list_entries() -> List[Tuple[str, Optional[str]]]:
    """`(トークン, 送信先環境)` の一覧。環境が未判定の端末は None（#593）。"""
    result: List[Tuple[str, Optional[str]]] = []
    for item in _sanitize_items(atomic_json.read_json(TOKENS_PATH, [])):
        environment = item.get("environment")
        result.append((item["token"], environment if environment in ENVIRONMENTS else None))
    return result


def set_environment(token: str, environment: str) -> None:
    """トークンの送信先環境（`sandbox` / `production`）を記録する。無いトークンは何もしない。"""
    if environment not in ENVIRONMENTS:
        raise ValueError("invalid environment")

    def _mutate(data: Any) -> List[Dict[str, Any]]:
        items = _sanitize_items(data)
        for item in items:
            if item.get("token") == token:
                item["environment"] = environment
        return items

    atomic_json.update_json(TOKENS_PATH, [], _mutate)


def upsert_token(token: str, *, user_agent: str = "") -> None:
    if not token:
        raise ValueError("invalid device token")

    def _mutate(data: Any) -> List[Dict[str, Any]]:
        items = _sanitize_items(data)
        updated = False
        for item in items:
            if item.get("token") == token:
                item["updated_at"] = _now_iso()
                if user_agent:
                    item["user_agent"] = user_agent[:200]
                updated = True
                break

        if not updated:
            entry: Dict[str, Any] = {
                "token": token,
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
            if user_agent:
                entry["user_agent"] = user_agent[:200]
            items.append(entry)
        return items

    atomic_json.update_json(TOKENS_PATH, [], _mutate)


def remove_token(token: str) -> bool:
    removed = False

    def _mutate(data: Any) -> List[Dict[str, Any]]:
        nonlocal removed
        items = _sanitize_items(data)
        next_items = [item for item in items if item.get("token") != token]
        removed = len(next_items) != len(items)
        return next_items

    atomic_json.update_json(TOKENS_PATH, [], _mutate)
    return removed


def remove_tokens(tokens: List[str]) -> None:
    if not tokens:
        return
    token_set = set(tokens)

    def _mutate(data: Any) -> List[Dict[str, Any]]:
        items = _sanitize_items(data)
        return [item for item in items if item.get("token") not in token_set]

    atomic_json.update_json(TOKENS_PATH, [], _mutate)
