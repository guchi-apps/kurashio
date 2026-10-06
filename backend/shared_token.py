"""issue-deck の共有トークンAPIから、アプリ間の認証値を実行時に取得する（#525）。

値を1Passwordから各アプリの `.env` へ複製せず、issue-deck を唯一の正にする方式。
仕様は issue-deck の `docs/shared-token-api.md`。

- `GET {SHARED_TOKEN_API_URL}/api/shared-tokens?name=<名前>` に
  `Authorization: Bearer <SHARED_TOKEN_API_SECRET>` と `X-Shared-Token-Consumer: myroom`
  を付けると `{ "name", "value" }` が返る（取得のたびに利用元が記録される）
- 成功した値は10分キャッシュする。失敗したら**直前の値を使い続ける**
- 一度も取れていないときは `None` を返し、呼ぶ側が環境変数へフォールバックする。
  そのときの失敗は短い間だけ覚え、リクエストのたびに5秒のタイムアウトを待たせない
- **トークンの値とBearerの値はログ・例外文に出さない。** ログに残すのはトークン名と失敗の種類だけ
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable, Dict, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

SECRET_ENV_VAR = "SHARED_TOKEN_API_SECRET"
URL_ENV_VAR = "SHARED_TOKEN_API_URL"
CONSUMER_NAME = "myroom"

CACHE_TTL_SECONDS = 600
FAILURE_RETRY_SECONDS = 30
REQUEST_TIMEOUT_SECONDS = 5

# name -> (value, 次に取り直してよい時刻)。value が None は「まだ一度も取れていない」
_cache: Dict[str, Tuple[Optional[str], float]] = {}
_lock = threading.Lock()


def _now() -> float:
    return time.monotonic()


def clear_cache() -> None:
    """キャッシュを空にする（テスト用）。"""
    with _lock:
        _cache.clear()


def forget(name: str) -> None:
    """名前のキャッシュを捨てる。再発行で古い値が失効したとき、次の取得で読み直させる。"""
    with _lock:
        _cache.pop(name, None)


def _endpoint() -> Optional[Tuple[str, str]]:
    """（取得URL, Bearer）。どちらかが未設定・空なら None（＝共有トークンは使わない）。"""
    secret = os.getenv(SECRET_ENV_VAR)
    base_url = os.getenv(URL_ENV_VAR)
    if not secret or not base_url:
        return None
    return base_url.rstrip("/") + "/api/shared-tokens", secret


def _fetch(name: str, url: str, secret: str) -> str:
    """1回取得する。失敗は例外（メッセージに値を含めない）。"""
    response = requests.get(
        url,
        params={"name": name},
        headers={
            "Authorization": f"Bearer {secret}",
            "X-Shared-Token-Consumer": CONSUMER_NAME,
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    if response.status_code != 200:
        raise RuntimeError(f"status {response.status_code}")
    value = response.json().get("value")
    if not isinstance(value, str) or not value:
        raise RuntimeError("empty value")
    return value


def get_shared_token(
    name: str, fetch: Optional[Callable[[str, str, str], str]] = None
) -> Optional[str]:
    """共有トークンの値。取れなければ直前の値、それも無ければ None。"""
    endpoint = _endpoint()
    if endpoint is None:
        return None
    url, secret = endpoint
    do_fetch = fetch or _fetch

    with _lock:
        cached = _cache.get(name)
        if cached is not None and _now() < cached[1]:
            return cached[0]
        try:
            value = do_fetch(name, url, secret)
        except Exception as exc:  # noqa: BLE001 - 失敗の種類だけを残す
            previous = cached[0] if cached else None
            _cache[name] = (previous, _now() + FAILURE_RETRY_SECONDS)
            logger.warning(
                "共有トークン %s の取得に失敗しました（%s）。%s",
                name,
                type(exc).__name__ if not isinstance(exc, RuntimeError) else exc,
                "直前の値を使います" if previous else "環境変数へフォールバックします",
            )
            return previous
        _cache[name] = (value, _now() + CACHE_TTL_SECONDS)
        return value
