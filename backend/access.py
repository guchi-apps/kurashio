"""StatusHub 共通アクセス設定の判定APIのクライアント（#718）。

誰がこのアプリを使えるかの正本は StatusHub（`guchi-apps/status-hub` の `docs/access-control.md`）。
旧 `ALLOWED_GOOGLE_EMAILS` は判定にもフォールバックにも使わない（判定APIが使えないときに旧リストで
通すと、StatusHub で取り消した利用者が通ってしまうため）。

契約:
- 結果は `ttlSeconds` だけ使い回す
- 取得に失敗したときは、直前に取得できた判定を `maxStaleSeconds` まで使う。超えたら拒否する
- 一度も判定できていない利用者は拒否する（許可を広げない）
- 判定APIのトークンが無いときも通信せず失敗として扱う＝全員拒否（未設定が「誰でも通す」に化けない）

トークン（アプリ別）は管理画面の「トークン発行」が issue-deck の共有トークン
`MYROOM_ACCESS_APP_TOKEN` へ書き込む。`shared_token.py` で10分キャッシュして読む。
再発行で古いものは即失効するので、401ならキャッシュを捨てて読み直し、1回だけ再試行する。
トークンの値・メールの実値はログへ出さない。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import requests

from . import shared_token

logger = logging.getLogger(__name__)

APP_ID = "myroom"
TOKEN_NAME = f"{APP_ID.upper()}_ACCESS_APP_TOKEN"
# 共有トークンAPIを使えない環境（開発など）向けの直接指定。判定の許可リストではなくトークンの置き場。
TOKEN_ENV_VAR = "ACCESS_APP_TOKEN"
DEFAULT_ACCESS_API_URL = "https://admin.gucchii.com"
URL_ENV_VAR = "ACCESS_API_URL"
REQUEST_TIMEOUT_SECONDS = 5

# StatusHub の契約は「5分以内に1回」。それより短く送る。
HEARTBEAT_INTERVAL_SECONDS = 240


class AccessResponseError(Exception):
    """判定APIの応答が契約の形ではない、またはHTTPエラー。メッセージに値を含めない。"""


@dataclass(frozen=True)
class AccessSubject:
    sub: str
    email: str
    email_verified: bool


@dataclass(frozen=True)
class AccessDecision:
    allowed: bool
    permissions: List[str] = field(default_factory=list)
    reason: Optional[str] = None


@dataclass(frozen=True)
class AccessResponse:
    app_version: float
    ttl_seconds: float
    max_stale_seconds: float
    decision: Optional[AccessDecision]


DENY = AccessDecision(False, [], "unavailable")

Fetcher = Callable[[Dict[str, Any]], AccessResponse]


def parse_response(payload: Any, expect_decision: bool) -> AccessResponse:
    """応答の形を確かめる。違えば例外にして、失敗として扱わせる。"""
    if not isinstance(payload, dict):
        raise AccessResponseError("unexpected payload")

    def positive(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0

    if not (
        positive(payload.get("appVersion"))
        and positive(payload.get("ttlSeconds"))
        and positive(payload.get("maxStaleSeconds"))
    ):
        raise AccessResponseError("unexpected payload")
    decision: Optional[AccessDecision] = None
    if expect_decision:
        raw = payload.get("decision")
        if not isinstance(raw, dict) or not isinstance(raw.get("allowed"), bool):
            raise AccessResponseError("unexpected payload")
        permissions = raw.get("permissions")
        perms = [p for p in permissions if isinstance(p, str)] if isinstance(permissions, list) else []
        reason = raw.get("reason")
        decision = AccessDecision(
            raw["allowed"],
            perms if raw["allowed"] else [],
            reason if isinstance(reason, str) else None,
        )
    return AccessResponse(
        payload["appVersion"], payload["ttlSeconds"], payload["maxStaleSeconds"], decision
    )


def _cache_key(subject: AccessSubject) -> str:
    return f"{subject.sub}\n{subject.email.lower()}"


def _post(base_url: str, token: str, body: Dict[str, Any]) -> requests.Response:
    return requests.post(
        f"{base_url.rstrip('/')}/api/access/v1/decision",
        json=body,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def _get_token() -> Optional[str]:
    return shared_token.get_shared_token(TOKEN_NAME) or os.getenv(TOKEN_ENV_VAR) or None


def _forget_token() -> None:
    shared_token.forget(TOKEN_NAME)


def _http_fetch(body: Dict[str, Any]) -> AccessResponse:
    base_url = os.getenv(URL_ENV_VAR) or DEFAULT_ACCESS_API_URL
    token = _get_token()
    if not token:
        raise AccessResponseError(f"{TOKEN_NAME} is not set")
    response = _post(base_url, token, body)
    if response.status_code == 401:
        _forget_token()
        renewed = _get_token()
        if renewed and renewed != token:
            response = _post(base_url, renewed, body)
    if response.status_code != 200:
        raise AccessResponseError(f"HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise AccessResponseError("invalid JSON") from exc
    return parse_response(payload, "subject" in body)


@dataclass
class _CacheEntry:
    decision: AccessDecision
    fetched_at: float
    ttl: float
    max_stale: float


class AccessClient:
    def __init__(self, fetcher: Fetcher = _http_fetch, now: Callable[[], float] = time.monotonic):
        self._fetcher = fetcher
        self._now = now
        self._lock = threading.Lock()
        self._cache: Dict[str, _CacheEntry] = {}
        self._applied_version: Optional[float] = None

    def _body(self, subject: Optional[AccessSubject]) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if self._applied_version is not None:
            body["appliedVersion"] = self._applied_version
        if subject is not None:
            body["subject"] = {
                "sub": subject.sub,
                "email": subject.email,
                "emailVerified": subject.email_verified,
            }
        return body

    def decide(self, subject: AccessSubject) -> AccessDecision:
        # 検証済みでないIDは問い合わせず拒否する（契約でも unverified_identity）。
        if not subject.sub or not subject.email or not subject.email_verified:
            return AccessDecision(False, [], "unverified_identity")
        key = _cache_key(subject)
        with self._lock:
            cached = self._cache.get(key)
            if cached and self._now() - cached.fetched_at < cached.ttl:
                return cached.decision
            body = self._body(subject)
        try:
            response = self._fetcher(body)
            if response.decision is None:
                raise AccessResponseError("missing decision")
        except Exception as exc:  # noqa: BLE001 - 失敗の種類だけを残す
            logger.warning("アクセス判定の取得に失敗しました（%s）", _describe(exc))
            # 直前の判定を、取得できた時刻から maxStale まで。超えたら（または無ければ）拒否。
            if cached and self._now() - cached.fetched_at <= cached.max_stale:
                return cached.decision
            return DENY
        at = self._now()
        with self._lock:
            self._applied_version = response.app_version
            self._cache[key] = _CacheEntry(
                response.decision, at, response.ttl_seconds, response.max_stale_seconds
            )
        return response.decision

    def heartbeat(self) -> bool:
        """判定なしの確認。反映状況（appliedVersion）をStatusHubへ伝える。"""
        with self._lock:
            body = self._body(None)
        try:
            response = self._fetcher(body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("アクセスのハートビートに失敗しました（%s）", _describe(exc))
            return False
        with self._lock:
            self._applied_version = response.app_version
        return True


def _describe(exc: Exception) -> str:
    return str(exc) if isinstance(exc, AccessResponseError) else type(exc).__name__


_client = AccessClient()


def decide(subject: AccessSubject) -> AccessDecision:
    return _client.decide(subject)


def send_heartbeat() -> bool:
    return _client.heartbeat()
