"""Apple Push Notification service（APNs）への通知送信（#527）。

iOSアプリ（`ios/`・#526）はWKWebViewの殻のためPWAのWeb Push（`push_notify.py`）を受け取れない。
こちらはAPNsのトークンベース認証（.p8 Auth Key・JWT）でHTTP/2送信する別経路で、失敗しても
呼び出し元（ゴミ・センサーの定期処理）を止めないよう、送信はすべて例外を握りつぶして結果件数
だけ返す。無効になったトークン（400 BadDeviceToken・410 Unregistered）は自動で削除する。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from jose import jwt as jose_jwt

from . import apns_subscriptions

load_dotenv()

logger = logging.getLogger(__name__)

#: JWTの再利用上限（Appleは頻繁な再生成を推奨しない。最大有効期間は1時間）
_TOKEN_TTL_SECONDS = 45 * 60

_token_lock = threading.Lock()
_cached_token: Optional[Tuple[str, float]] = None


def _key_id() -> Optional[str]:
    return os.getenv("APNS_KEY_ID") or None


def _team_id() -> Optional[str]:
    return os.getenv("APNS_TEAM_ID") or None


def _bundle_id() -> Optional[str]:
    return os.getenv("APNS_BUNDLE_ID") or None


def _auth_key_pem() -> Optional[str]:
    """base64化されたAuth Key（.p8）の中身をPEM文字列に戻す。

    改行を含むPEMをそのまま1Passwordへ入れると `.env` の書式が壊れる（#337でVAPID秘密鍵に
    実際に起きた）ため、値は1行のbase64で持つ（README・secrets-manifest.tsvに手順を記載）。
    """
    encoded = os.getenv("APNS_AUTH_KEY")
    if not encoded:
        return None
    try:
        return base64.b64decode(encoded).decode("utf-8")
    except Exception:
        logger.error("Failed to decode APNS_AUTH_KEY as base64")
        return None


def _environment() -> str:
    return (os.getenv("APNS_ENVIRONMENT") or "sandbox").strip().lower()


def _default_environment() -> str:
    """環境がまだ分かっていないトークンを最初に試す側。"""
    return "production" if _environment() == "production" else "sandbox"


def _other_environment(environment: str) -> str:
    return "sandbox" if environment == "production" else "production"


def _host(environment: str) -> str:
    return "api.push.apple.com" if environment == "production" else "api.sandbox.push.apple.com"


def is_configured() -> bool:
    return bool(_key_id() and _team_id() and _bundle_id() and _auth_key_pem())


def _signing_token() -> Optional[str]:
    """APNsへ渡すJWT（ES256）。作り直しを減らすため一定時間キャッシュする。"""
    global _cached_token

    key_id = _key_id()
    team_id = _team_id()
    pem = _auth_key_pem()
    if not (key_id and team_id and pem):
        return None

    with _token_lock:
        now = time.time()
        if _cached_token is not None:
            token, issued_at = _cached_token
            if now - issued_at < _TOKEN_TTL_SECONDS:
                return token

        token = jose_jwt.encode(
            {"iss": team_id, "iat": int(now)},
            pem,
            algorithm="ES256",
            headers={"kid": key_id},
        )
        _cached_token = (token, now)
        return token


def _send_to_token(
    client: httpx.Client, token: str, payload: Dict[str, Any], environment: str
) -> Tuple[Optional[int], Optional[str]]:
    """1件へ送信する。成功は `(None, None)`、失敗は `(HTTPステータス相当, reason)`。

    不明な失敗のステータスは -1。
    """
    signing_token = _signing_token()
    bundle_id = _bundle_id()
    if not (signing_token and bundle_id):
        return None, None

    body = {
        "aps": {
            "alert": {"title": payload.get("title", ""), "body": payload.get("body", "")},
            "sound": "default",
        },
        "url": payload.get("url", "/"),
    }
    #: APNsのcollapse-idは64バイトまで（超える値は素通しするとAppleに拒否されるため切り詰める）
    collapse_id = str(payload.get("tag") or "")[:64]

    headers = {
        "authorization": f"bearer {signing_token}",
        "apns-topic": bundle_id,
        "apns-push-type": "alert",
        "apns-priority": "10",
    }
    if collapse_id:
        headers["apns-collapse-id"] = collapse_id

    try:
        response = client.post(
            f"https://{_host(environment)}/3/device/{token}",
            headers=headers,
            content=json.dumps(body, ensure_ascii=False),
        )
    except Exception as exc:  # HTTP/2接続・ネットワーク周りの予期しない失敗
        logger.error("Unexpected error sending APNs push (token=...%s): %s", token[-6:], exc)
        return -1, None

    if response.status_code == 200:
        return None, None

    reason = None
    try:
        reason = response.json().get("reason")
    except Exception:
        pass
    logger.warning(
        "APNs push failed (status=%s reason=%s env=%s token=...%s)",
        response.status_code,
        reason,
        environment,
        token[-6:],
    )
    return response.status_code, reason


def _send_with_fallback(
    client: httpx.Client,
    token: str,
    known_environment: Optional[str],
    payload: Dict[str, Any],
) -> Tuple[bool, Optional[str], bool]:
    """1端末へ送る。`(成功したか, 成功した環境, 無効なトークンか)` を返す。

    TestFlight/App Storeのトークンはproduction、Xcodeの開発ビルドはsandboxでしか通らず、
    環境違いは `400 BadDeviceToken` で返る（#593）。記録済みの環境→反対側の順に試し、
    `BadDeviceToken` のときだけ次の環境へ進む。それ以外の失敗（設定側の400・429・5xx）は
    トークンのせいではないので、反対側へ回さず削除もしない。
    """
    first = known_environment or _default_environment()
    for environment in (first, _other_environment(first)):
        status, reason = _send_to_token(client, token, payload, environment)
        if status is None:
            return True, environment, False
        if status == 410:
            return False, None, True
        if not (status == 400 and reason == "BadDeviceToken"):
            return False, None, False
    return False, None, True


def broadcast(payload: Dict[str, Any]) -> Dict[str, int]:
    """全登録端末へ配信する。件数（sent/total）を返す。

    `payload` は `push_notify.broadcast()` と同じ形（title・body・tag・url）を受ける。
    無効になったトークン（400/410）はここで削除する。
    """
    total = 0
    sent = 0

    if not is_configured():
        logger.debug("APNs keys not configured; skipping native push")
        return {"sent": sent, "total": total}

    entries = apns_subscriptions.list_entries()
    total = len(entries)
    if not entries:
        return {"sent": sent, "total": total}

    expired: List[str] = []
    with httpx.Client(http2=True, timeout=10.0) as client:
        for token, known_environment in entries:
            ok, environment, invalid = _send_with_fallback(
                client, token, known_environment, payload
            )
            if invalid:
                expired.append(token)
            elif ok:
                sent += 1
                if environment != known_environment and environment:
                    apns_subscriptions.set_environment(token, environment)

    if expired:
        apns_subscriptions.remove_tokens(expired)
        logger.info("Removed %d expired APNs token(s)", len(expired))

    return {"sent": sent, "total": total}


def send_test_push() -> Dict[str, int]:
    return broadcast(
        {
            "title": "🔔 kurashio テスト通知",
            "body": "アプリのプッシュ通知は正常に届いています。",
            "tag": "myroom-apns-test",
            "url": "/",
        }
    )
