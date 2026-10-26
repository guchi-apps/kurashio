"""センサーデータの鮮度・室温湿度の異常を監視し、異常のときだけ Discord と PWA Push で通知する（復旧・通常時は通知しない・#844）。"""

from __future__ import annotations

import datetime
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, TypedDict

from dotenv import load_dotenv
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import database, device_config, discord_notify, notify_events, ui_settings

load_dotenv()

logger = logging.getLogger(__name__)

JST = datetime.timezone(datetime.timedelta(hours=9))
STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "sensor_alert_state.json"

STALE_THRESHOLD_MINUTES = int(os.getenv("SENSOR_STALE_MINUTES", "15"))
REMINDER_INTERVAL_MINUTES = int(os.getenv("SENSOR_ALERT_REMINDER_MINUTES", "60"))

#: 室温・湿度の異常判定の対象と表示（#293）。ui_settings.ROOM_ANOMALY_METRICS と揃える
METRIC_LABELS: Dict[str, "tuple[str, str]"] = {
    "temperature": ("室温", "℃"),
    "humidity": ("湿度", "%"),
}
#: 上限・下限の境界からこの幅だけ内側に戻るまでは「まだ異常」として扱う（連続通知の抑止）
ANOMALY_HYSTERESIS: Dict[str, float] = {"temperature": 0.5, "humidity": 3.0}
#: Discord へ送った値からこの幅だけ異常側へ進んだら「悪化」として再通知する（同程度の超過は繰り返さない）
ANOMALY_WORSEN_STEP: Dict[str, float] = {"temperature": 2.0, "humidity": 10.0}


class SensorStatus(TypedDict):
    device_id: int
    name: str
    last_seen: Optional[str]
    age_minutes: Optional[float]
    stale: bool
    has_data: bool


def get_now_jst() -> datetime.datetime:
    return datetime.datetime.now(JST).replace(tzinfo=None)


def stale_threshold_minutes() -> int:
    return STALE_THRESHOLD_MINUTES


def _discover_device_ids(db: Session) -> List[int]:
    rows = db.query(database.SensorRecord.device_id).distinct().all()
    return sorted({row[0] for row in rows if row[0] is not None})


def _latest_by_device(db: Session) -> Dict[int, datetime.datetime]:
    rows = (
        db.query(database.SensorRecord.device_id, func.max(database.SensorRecord.datetime))
        .group_by(database.SensorRecord.device_id)
        .all()
    )
    return {device_id: latest for device_id, latest in rows if latest is not None}


def collect_sensor_statuses(db: Optional[Session] = None) -> List[SensorStatus]:
    """各センサーの最終受信時刻と鮮度を返す。"""
    if database.DB_MOCK or db is None:
        now = get_now_jst()
        devices = device_config.list_devices()
        return [
            {
                "device_id": device["id"],
                "name": device["name"],
                "last_seen": now.strftime("%Y-%m-%d %H:%M:%S"),
                "age_minutes": 0.0,
                "stale": False,
                "has_data": True,
            }
            for device in devices
        ]

    discovered = _discover_device_ids(db)
    devices = device_config.list_devices(discovered)
    latest_map = _latest_by_device(db)
    now = get_now_jst()
    threshold = stale_threshold_minutes()
    statuses: List[SensorStatus] = []

    for device in devices:
        device_id = device["id"]
        last_seen_dt = latest_map.get(device_id)
        if last_seen_dt is None:
            statuses.append(
                {
                    "device_id": device_id,
                    "name": device["name"],
                    "last_seen": None,
                    "age_minutes": None,
                    "stale": True,
                    "has_data": False,
                }
            )
            continue

        age_minutes = (now - last_seen_dt).total_seconds() / 60.0
        statuses.append(
            {
                "device_id": device_id,
                "name": device["name"],
                "last_seen": last_seen_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "age_minutes": round(age_minutes, 1),
                "stale": age_minutes > threshold,
                "has_data": True,
            }
        )

    return statuses


def _load_state() -> Dict[str, Any]:
    if not STATE_PATH.exists():
        return {"devices": {}}
    try:
        with STATE_PATH.open(encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("devices"), dict):
            return data
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        logger.warning("Failed to read sensor alert state; resetting")
    return {"devices": {}}


def _write_state(state: Dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with STATE_PATH.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)


def _device_state_entry(state: Dict[str, Any], device_id: int) -> Dict[str, Any]:
    devices = state.setdefault("devices", {})
    key = str(device_id)
    entry = devices.get(key)
    if not isinstance(entry, dict):
        entry = {"status": "ok", "notified_at": None}
        devices[key] = entry
    # 既存の状態ファイル（鮮度のみ）にも後から足せるよう、無ければ補う
    entry.setdefault("metrics", {})
    return entry


def _should_send_reminder(
    notified_at: Optional[str], now: datetime.datetime, reminder_minutes: int
) -> bool:
    if not notified_at:
        return True
    try:
        previous = datetime.datetime.strptime(notified_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return True
    elapsed = (now - previous).total_seconds() / 60.0
    return elapsed >= reminder_minutes


def _latest_reading(db: Session, device_id: int) -> Optional["database.SensorRecord"]:
    return (
        db.query(database.SensorRecord)
        .filter(database.SensorRecord.device_id == device_id)
        .order_by(database.SensorRecord.datetime.desc())
        .first()
    )


def _direction_for_value(value: float, thresholds: Dict[str, float]) -> Optional[str]:
    if value > thresholds["max"]:
        return "high"
    if value < thresholds["min"]:
        return "low"
    return None


def _has_recovered(
    value: float, thresholds: Dict[str, float], direction: str, hysteresis: float
) -> bool:
    if direction == "high":
        return value <= thresholds["max"] - hysteresis
    if direction == "low":
        return value >= thresholds["min"] + hysteresis
    return True


def _evaluate_device_anomalies(
    *,
    db: Session,
    device: SensorStatus,
    thresholds_by_metric: Dict[str, Dict[str, float]],
    reminder_minutes: int,
    device_state: Dict[str, Any],
    now: datetime.datetime,
    now_str: str,
) -> bool:
    """1台ぶんの室温・湿度を評価し、遷移があれば通知する。状態を変えたら True を返す。"""
    record = _latest_reading(db, device["device_id"])
    if record is None:
        return False

    metrics_state = device_state.setdefault("metrics", {})
    changed = False

    for metric, (label, unit) in METRIC_LABELS.items():
        value = getattr(record, metric, None)
        if value is None:
            continue

        thresholds = thresholds_by_metric.get(metric)
        if thresholds is None:
            continue

        metric_state = metrics_state.get(metric)
        if not isinstance(metric_state, dict):
            metric_state = {"direction": None, "notified_at": None}
            metrics_state[metric] = metric_state

        previous_direction = metric_state.get("direction")
        hysteresis = ANOMALY_HYSTERESIS.get(metric, 0.0)

        if previous_direction in ("high", "low"):
            if _has_recovered(value, thresholds, previous_direction, hysteresis):
                # 復旧は通知しない。状態だけ戻して、次の超過を新たな異常として扱う
                metric_state["direction"] = None
                metric_state["notified_at"] = None
                metric_state.pop("discord_value", None)
                changed = True
            else:
                if _should_send_reminder(metric_state.get("notified_at"), now, reminder_minutes):
                    _send_anomaly_push(
                        device=device,
                        metric=metric,
                        label=label,
                        unit=unit,
                        value=value,
                        thresholds=thresholds,
                        direction=previous_direction,
                        now=now,
                    )
                    metric_state["notified_at"] = now_str
                    changed = True
                if _send_discord_anomaly(
                    device=device,
                    metric=metric,
                    label=label,
                    unit=unit,
                    value=value,
                    thresholds=thresholds,
                    direction=previous_direction,
                    metric_state=metric_state,
                ):
                    changed = True
            continue

        direction = _direction_for_value(value, thresholds)
        if direction is not None:
            _send_anomaly_push(
                device=device,
                metric=metric,
                label=label,
                unit=unit,
                value=value,
                thresholds=thresholds,
                direction=direction,
                now=now,
            )
            metric_state["direction"] = direction
            metric_state["notified_at"] = now_str
            metric_state.pop("discord_value", None)
            _send_discord_anomaly(
                device=device,
                metric=metric,
                label=label,
                unit=unit,
                value=value,
                thresholds=thresholds,
                direction=direction,
                metric_state=metric_state,
            )
            changed = True

    return changed


def _discord_worsened(
    metric: str, value: float, direction: str, sent_value: Optional[float]
) -> bool:
    if sent_value is None:
        return False
    step = ANOMALY_WORSEN_STEP.get(metric, 0.0)
    if direction == "high":
        return value >= sent_value + step
    return value <= sent_value - step


def _send_discord_anomaly(
    *,
    device: SensorStatus,
    metric: str,
    label: str,
    unit: str,
    value: float,
    thresholds: Dict[str, float],
    direction: str,
    metric_state: Dict[str, Any],
) -> bool:
    """Discord へ送る必要があるときだけ送る。送れたら状態を更新して True。

    新たな異常（`discord_value` が無い）と、送った値からの悪化だけを送る。送れなかった異常は
    `discord_value` を残さないので、次回の実行で送り直す。
    """
    sent_value = metric_state.get("discord_value")
    worsened = _discord_worsened(metric, value, direction, sent_value)
    if sent_value is not None and not worsened:
        return False
    sent = discord_notify.send_room_anomaly_alert(
        device_name=device["name"],
        device_id=device["device_id"],
        label=label,
        unit=unit,
        value=value,
        limit=thresholds["max"] if direction == "high" else thresholds["min"],
        direction=direction,
        worsened=worsened,
    )
    if sent:
        metric_state["discord_value"] = value
    return sent


def _send_anomaly_push(
    *,
    device: SensorStatus,
    metric: str,
    label: str,
    unit: str,
    value: float,
    thresholds: Dict[str, float],
    direction: str,
    now: datetime.datetime,
) -> None:
    device_name = device["name"]
    device_id = device["device_id"]

    if direction == "high":
        title = f"{label}が高くなっています"
        body = f"{device_name}の現在の{label}は{value}{unit}です。設定上限の{thresholds['max']}{unit}を超えました"
    else:
        title = f"{label}が低くなっています"
        body = f"{device_name}の現在の{label}は{value}{unit}です。設定下限の{thresholds['min']}{unit}を下回りました"

    notify_events.dispatch_push_event(
        notify_events.NotificationEvent(
            kind=f"room_anomaly_{metric}_{direction}",
            title=title,
            body=body,
            priority="high",
            url="/",
            occurred_at=now.isoformat(),
            dedupe_key=f"room-anomaly-{device_id}-{metric}-{direction}",
        )
    )


def run_monitor(db: Optional[Session] = None, notify: bool = True) -> List[SensorStatus]:
    """鮮度を評価し、状態遷移時に通知する。CLI / systemd timer から呼ぶ。"""
    statuses = collect_sensor_statuses(db)
    if not notify or database.DB_MOCK:
        return statuses

    state = _load_state()
    now = get_now_jst()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    changed = False

    settings = ui_settings.get_settings(db)
    anomaly_enabled = settings.get(ui_settings.SETTING_ROOM_ANOMALY_NOTIFY_ENABLED, False)
    thresholds_by_metric = settings.get(
        ui_settings.SETTING_ROOM_ANOMALY_THRESHOLDS, ui_settings.DEFAULT_ROOM_ANOMALY_THRESHOLDS
    )
    anomaly_reminder_minutes = settings.get(
        ui_settings.SETTING_ROOM_ANOMALY_REMINDER_MINUTES,
        ui_settings.DEFAULT_ROOM_ANOMALY_REMINDER_MINUTES,
    )
    #: 「データ未着信のアラートを通知」をオフにした端末（#383）。通知と状態遷移の記録の両方をスキップする
    stale_alert_excluded = set(settings.get(ui_settings.SETTING_STALE_ALERT_EXCLUDED, []))

    for status in statuses:
        device_id = status["device_id"]
        is_stale = status["stale"]
        entry = _device_state_entry(state, device_id)

        if f"device:{device_id}" not in stale_alert_excluded:
            previous = entry.get("status", "ok")

            if is_stale:
                if previous != "alerting" or _should_send_reminder(
                    entry.get("notified_at"), now, REMINDER_INTERVAL_MINUTES
                ):
                    notify_events.dispatch_push_event(
                        notify_events.NotificationEvent(
                            kind="sensor_stale",
                            title="センサーデータが届いていません",
                            body=f"{status['name']}のデータが{stale_threshold_minutes()}分以上届いていません",
                            priority="high",
                            url="/",
                            occurred_at=now.isoformat(),
                            dedupe_key=f"sensor-stale-{device_id}",
                        )
                    )
                    entry["status"] = "alerting"
                    entry["notified_at"] = now_str
                    changed = True
                # Discord は検知時の1回だけ。送れなかったときは次回の実行で送り直す
                if not entry.get("discord_notified") and discord_notify.send_sensor_stale_alert(
                    device_name=status["name"],
                    device_id=device_id,
                    last_seen=status["last_seen"],
                    age_minutes=status["age_minutes"],
                    threshold_minutes=stale_threshold_minutes(),
                ):
                    entry["status"] = "alerting"
                    entry["discord_notified"] = True
                    changed = True
            elif previous == "alerting":
                # 復旧は通知しない。状態だけ戻す
                entry["status"] = "ok"
                entry["notified_at"] = None
                entry.pop("discord_notified", None)
                changed = True
            else:
                entry["status"] = "ok"

        if anomaly_enabled and not is_stale and status["has_data"] and db is not None:
            if _evaluate_device_anomalies(
                db=db,
                device=status,
                thresholds_by_metric=thresholds_by_metric,
                reminder_minutes=anomaly_reminder_minutes,
                device_state=entry,
                now=now,
                now_str=now_str,
            ):
                changed = True

    if changed:
        _write_state(state)

    return statuses


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if database.DB_MOCK:
        logger.info("DB_MOCK=true; skipping sensor monitor")
        return 0

    db = database.SessionLocal()
    try:
        statuses = run_monitor(db, notify=True)
        stale_count = sum(1 for item in statuses if item["stale"])
        logger.info(
            "Sensor monitor finished: %d device(s), %d stale",
            len(statuses),
            stale_count,
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
