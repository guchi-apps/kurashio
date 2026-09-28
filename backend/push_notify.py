"""Web Push（VAPID）通知の送信。

失敗しても呼び出し元（センサー保存・定期チェック・画面のAPI）を止めないため、送信は
すべて例外を握りつぶして結果件数だけ返す。無効になった購読（410/404）は自動で削除する。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from pywebpush import WebPushException, webpush

from . import push_subscriptions

load_dotenv()

logger = logging.getLogger(__name__)


def _vapid_private_key() -> Optional[str]:
    value = os.getenv("VAPID_PRIVATE_KEY")
    return value if value else None


def _vapid_subject() -> str:
    return os.getenv("VAPID_SUBJECT") or "mailto:myroom@example.com"


def get_vapid_public_key() -> Optional[str]:
    value = os.getenv("VAPID_PUBLIC_KEY")
    return value if value else None


def is_configured() -> bool:
    return bool(_vapid_private_key() and get_vapid_public_key())


def _send_to_subscription(subscription: Dict[str, Any], payload: Dict[str, Any]) -> Optional[int]:
    """1件へ送信する。成功は None、失敗はHTTPステータス相当（不明な失敗は -1）を返す。"""
    private_key = _vapid_private_key()
    if not private_key:
        return None

    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=private_key,
            vapid_claims={"sub": _vapid_subject()},
        )
        return None
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        logger.warning(
            "Web push failed (status=%s endpoint=%s): %s", status, subscription.get("endpoint"), exc
        )
        return status
    except Exception as exc:  # 暗号化・ネットワーク周りの予期しない失敗
        logger.error(
            "Unexpected error sending push to %s: %s", subscription.get("endpoint"), exc, exc_info=True
        )
        return -1


def broadcast(payload: Dict[str, Any]) -> Dict[str, int]:
    """全購読者へ配信する。件数（sent/total）を返す。

    `payload` は Service Worker（`frontend/public/sw.js`）が受け取る形
    （title・body・tag・url）。無効になった購読（404/410）はここで削除する。
    """
    total = 0
    sent = 0

    if not is_configured():
        logger.debug("VAPID keys not configured; skipping web push")
        return {"sent": sent, "total": total}

    subscriptions = push_subscriptions.list_subscriptions()
    total = len(subscriptions)
    if not subscriptions:
        return {"sent": sent, "total": total}

    expired: List[str] = []
    for subscription in subscriptions:
        status = _send_to_subscription(subscription, payload)
        if status in (404, 410):
            endpoint = subscription.get("endpoint")
            if isinstance(endpoint, str):
                expired.append(endpoint)
            continue
        if status is None:
            sent += 1

    if expired:
        push_subscriptions.remove_subscriptions(expired)
        logger.info("Removed %d expired push subscription(s)", len(expired))

    return {"sent": sent, "total": total}


def send_test_push() -> Dict[str, int]:
    return broadcast(
        {
            "title": "🔔 kurashio テスト通知",
            "body": "プッシュ通知は正常に届いています。",
            "tag": "myroom-push-test",
            "url": "/",
        }
    )
