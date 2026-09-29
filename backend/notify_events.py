"""ゴミの日通知・部屋の異常通知が共通で使う通知イベントの形と送信処理（#293）。

種別ごとの重複防止（同じ収集日を二重に通知しない・同じ異常が続く間は再通知しない）は
呼び出し側（`garbage_notify.py` / `sensor_monitor.py`）が自分の状態ファイルで判断する
（既存の `garbage_notify_state.json` / `sensor_alert_state.json` と同じやり方）。ここでは
「送るとなったイベントをPush通知として配信する」処理だけを共通化する。
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Optional

from . import apns_notify, push_notify

logger = logging.getLogger(__name__)


@dataclasses.dataclass(frozen=True)
class NotificationEvent:
    #: "garbage" / "room_anomaly_temperature_high" のような種別
    kind: str
    title: str
    body: str
    #: "normal" | "high"。OS通知の見え方はブラウザ依存のため、いまは記録のみ
    priority: str
    #: タップしたときに開く画面
    url: str
    #: JSTのISO8601文字列
    occurred_at: str
    #: 同じ内容の通知をOS側で1つにまとめるためのキー（Service Workerの`tag`に渡す）
    dedupe_key: str


def dispatch_push_event(event: NotificationEvent) -> int:
    """PWA Push・APNs（iOSアプリ・#527）の両方へ配信する。

    失敗しても例外は投げない（呼び出し元の処理を止めないため）。2経路とも未設定なら何もしない
    （`push_notify.broadcast()` / `apns_notify.broadcast()` がそれぞれ `is_configured()` を見る）。
    """
    payload = {
        "title": event.title,
        "body": event.body,
        "tag": event.dedupe_key,
        "url": event.url,
    }
    sent = 0

    try:
        result = push_notify.broadcast(payload)
        sent += result["sent"]
        logger.info(
            "Web Push event dispatched: kind=%s sent=%d/%d dedupe_key=%s",
            event.kind,
            result["sent"],
            result["total"],
            event.dedupe_key,
        )
    except Exception:  # 通知の失敗でゴミ・センサーの定期処理を止めない
        logger.exception("Failed to dispatch web push event (kind=%s)", event.kind)

    try:
        result = apns_notify.broadcast(payload)
        sent += result["sent"]
        logger.info(
            "APNs event dispatched: kind=%s sent=%d/%d dedupe_key=%s",
            event.kind,
            result["sent"],
            result["total"],
            event.dedupe_key,
        )
    except Exception:
        logger.exception("Failed to dispatch APNs event (kind=%s)", event.kind)

    return sent
