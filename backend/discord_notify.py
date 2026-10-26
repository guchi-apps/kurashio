"""異常だけを Discord へ送る（Signaly 廃止・#844）。

宛先は全リポジトリ共通の既存 Webhook（1Password `apps/Notify/alert-webhook-url`）で、
環境変数 `DISCORD_ALERT_WEBHOOK_URL` から読む。**成功・復旧・通常ログインは送らない。**
呼び出し側は戻り値（送れたか）を見て、失敗した異常を次回の実行で送り直す。

Webhook URL は秘密。例外メッセージに URL が入るため、ログには例外の型と HTTP ステータスだけを残す。
"""

import logging
import os
from typing import Optional

import requests

logger = logging.getLogger(__name__)

ALERT_COLOR = 0xED4245
APP_NAME = "kurashio"


def webhook_url() -> str:
    return os.getenv("DISCORD_ALERT_WEBHOOK_URL", "").strip()


def is_configured() -> bool:
    return bool(webhook_url())


def send_alert(title: str, fields: list[dict], description: str = "") -> bool:
    """異常を1件送る。送れたら True。未設定・失敗は False（呼び出し元の処理は止めない）。"""
    url = webhook_url()
    if not url:
        logger.warning("DISCORD_ALERT_WEBHOOK_URL not set; Discord alert not sent: %s", title)
        return False

    embed = {"title": title, "color": ALERT_COLOR, "fields": fields, "footer": {"text": APP_NAME}}
    if description:
        embed["description"] = description
    try:
        response = requests.post(
            url,
            json={"embeds": [embed], "allowed_mentions": {"parse": []}},
            timeout=5,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        status: Optional[int] = getattr(getattr(exc, "response", None), "status_code", None)
        logger.error(
            "Discord alert delivery failed (%s, status=%s): %s",
            type(exc).__name__,
            status,
            title,
        )
        return False
    return True


def send_sensor_stale_alert(
    *,
    device_name: str,
    device_id: int,
    last_seen: Optional[str],
    age_minutes: Optional[float],
    threshold_minutes: int,
) -> bool:
    if last_seen:
        last_seen_value = f"{last_seen}（約 {int(age_minutes or 0)} 分前）"
    else:
        last_seen_value = "なし（一度も届いていません）"
    return send_alert(
        "⚠️ センサーデータが届いていません",
        [
            {"name": "センサー", "value": f"{device_name}（device={device_id}）", "inline": False},
            {"name": "最終受信", "value": last_seen_value, "inline": True},
            {"name": "閾値", "value": f"{threshold_minutes} 分", "inline": True},
        ],
    )


def send_room_anomaly_alert(
    *,
    device_name: str,
    device_id: int,
    label: str,
    unit: str,
    value: float,
    limit: float,
    direction: str,
    worsened: bool,
) -> bool:
    word = "高く" if direction == "high" else "低く"
    limit_name = "上限" if direction == "high" else "下限"
    prefix = "🔺 悪化: " if worsened else "⚠️ "
    return send_alert(
        f"{prefix}{label}が{word}なっています",
        [
            {"name": "センサー", "value": f"{device_name}（device={device_id}）", "inline": False},
            {"name": "現在値", "value": f"{value}{unit}", "inline": True},
            {"name": limit_name, "value": f"{limit}{unit}", "inline": True},
        ],
    )
