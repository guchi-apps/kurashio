import datetime
from types import SimpleNamespace

from backend import database, sensor_monitor, ui_settings


_discord_stale = []
_discord_anomaly = []


def _fake_status(device_id=1, name="リビング", stale=False):
    return {
        "device_id": device_id,
        "name": name,
        "last_seen": "2026-08-10 12:00:00",
        "age_minutes": 0.0,
        "stale": stale,
        "has_data": True,
    }


def _setup(monkeypatch, data_dir, *, statuses=None, reading=None):
    monkeypatch.setattr(sensor_monitor, "STATE_PATH", data_dir / "sensor_alert_state.json")
    monkeypatch.setattr(database, "DB_MOCK", False)
    monkeypatch.setattr(
        sensor_monitor, "collect_sensor_statuses", lambda db=None: statuses or [_fake_status()]
    )
    monkeypatch.setattr(sensor_monitor, "_latest_reading", lambda db, device_id: reading)
    # run_monitor には DB_MOCK=False の実DBセッション相当のダミーを渡すため、
    # ui_settings 側は DB を読みに行かずファイル設定（data_dir 配下）を見るようにする
    monkeypatch.setattr(
        sensor_monitor.ui_settings,
        "get_settings",
        lambda db=None: ui_settings._load_file_settings(),
    )
    # Discord は実際には送らず、送った内容を記録する（既定は送信成功）
    monkeypatch.setattr(
        sensor_monitor.discord_notify,
        "send_sensor_stale_alert",
        lambda **kw: _discord_stale.append(kw) or True,
    )
    monkeypatch.setattr(
        sensor_monitor.discord_notify,
        "send_room_anomaly_alert",
        lambda **kw: _discord_anomaly.append(kw) or True,
    )
    _discord_stale.clear()
    _discord_anomaly.clear()

    dispatched = []
    monkeypatch.setattr(
        sensor_monitor.notify_events, "dispatch_push_event", lambda event: dispatched.append(event)
    )
    return dispatched


def _enable_room_anomaly(**overrides):
    settings = {ui_settings.SETTING_ROOM_ANOMALY_NOTIFY_ENABLED: True}
    settings.update(overrides)
    ui_settings.save_settings(settings)


def test_direction_for_value():
    thresholds = {"min": 16.0, "max": 30.0}
    assert sensor_monitor._direction_for_value(31.0, thresholds) == "high"
    assert sensor_monitor._direction_for_value(10.0, thresholds) == "low"
    assert sensor_monitor._direction_for_value(22.0, thresholds) is None


def test_has_recovered_respects_hysteresis():
    thresholds = {"min": 16.0, "max": 30.0}
    # 上限のすぐ内側（0.5未満）ではまだ「異常」のまま
    assert sensor_monitor._has_recovered(29.8, thresholds, "high", 0.5) is False
    assert sensor_monitor._has_recovered(29.5, thresholds, "high", 0.5) is True
    assert sensor_monitor._has_recovered(16.2, thresholds, "low", 0.5) is False
    assert sensor_monitor._has_recovered(16.5, thresholds, "low", 0.5) is True


def test_disabled_by_default_does_not_evaluate(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch, data_dir, reading=SimpleNamespace(temperature=35.0, humidity=50.0)
    )
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert dispatched == []


def test_enters_high_and_dispatches_push(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch, data_dir, reading=SimpleNamespace(temperature=35.0, humidity=50.0)
    )
    _enable_room_anomaly()

    sensor_monitor.run_monitor(db=object(), notify=True)

    kinds = [event.kind for event in dispatched]
    assert "room_anomaly_temperature_high" in kinds


def test_no_repeat_notification_within_reminder_interval(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch, data_dir, reading=SimpleNamespace(temperature=35.0, humidity=50.0)
    )
    _enable_room_anomaly(room_anomaly_reminder_minutes=60)

    sensor_monitor.run_monitor(db=object(), notify=True)
    first_count = len(dispatched)

    # 同じ異常が続いたまま、すぐ再評価しても再通知しない
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(dispatched) == first_count


def test_recovery_is_not_notified_anywhere(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch, data_dir, reading=SimpleNamespace(temperature=35.0, humidity=50.0)
    )
    _enable_room_anomaly()
    sensor_monitor.run_monitor(db=object(), notify=True)
    before = (len(dispatched), len(_discord_anomaly))

    # 上限(30.0) - ヒステリシス(0.5) 以下まで戻る
    monkeypatch.setattr(
        sensor_monitor,
        "_latest_reading",
        lambda db, device_id: SimpleNamespace(temperature=29.0, humidity=50.0),
    )
    sensor_monitor.run_monitor(db=object(), notify=True)

    assert (len(dispatched), len(_discord_anomaly)) == before
    assert not any("recovered" in event.kind for event in dispatched)


def test_normal_readings_send_nothing(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch, data_dir, reading=SimpleNamespace(temperature=24.0, humidity=50.0)
    )
    _enable_room_anomaly()
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert dispatched == []
    assert _discord_anomaly == [] and _discord_stale == []


def test_discord_sent_once_then_only_on_worsening(data_dir, monkeypatch):
    _setup(monkeypatch, data_dir, reading=SimpleNamespace(temperature=31.0, humidity=50.0))
    _enable_room_anomaly(room_anomaly_reminder_minutes=0)

    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(_discord_anomaly) == 1
    assert _discord_anomaly[0]["worsened"] is False

    # 同程度の超過が続いても（リマインド間隔が0でも）Discord へは繰り返さない
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(_discord_anomaly) == 1

    # 悪化（31.0 → 33.0 = 幅2.0）は見逃さない
    monkeypatch.setattr(
        sensor_monitor,
        "_latest_reading",
        lambda db, device_id: SimpleNamespace(temperature=33.0, humidity=50.0),
    )
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(_discord_anomaly) == 2
    assert _discord_anomaly[1]["worsened"] is True


def test_discord_delivery_failure_is_retried(data_dir, monkeypatch):
    _setup(monkeypatch, data_dir, reading=SimpleNamespace(temperature=35.0, humidity=50.0))
    _enable_room_anomaly()
    results = iter([False, True])
    calls = []
    monkeypatch.setattr(
        sensor_monitor.discord_notify,
        "send_room_anomaly_alert",
        lambda **kw: calls.append(kw) or next(results),
    )

    sensor_monitor.run_monitor(db=object(), notify=True)
    sensor_monitor.run_monitor(db=object(), notify=True)
    sensor_monitor.run_monitor(db=object(), notify=True)

    assert len(calls) == 2  # 失敗した1回目を2回目で送り直し、成功後は送らない


def test_stale_discord_alert_once_and_no_recovery(data_dir, monkeypatch):
    dispatched = _setup(monkeypatch, data_dir, statuses=[_fake_status(stale=True)])
    sensor_monitor.run_monitor(db=object(), notify=True)
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(_discord_stale) == 1

    monkeypatch.setattr(
        sensor_monitor, "collect_sensor_statuses", lambda db=None: [_fake_status()]
    )
    sensor_monitor.run_monitor(db=object(), notify=True)
    assert len(_discord_stale) == 1
    assert "sensor_recovered" not in [event.kind for event in dispatched]


def test_stale_device_is_not_evaluated_for_anomaly(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch,
        data_dir,
        statuses=[_fake_status(stale=True)],
        reading=SimpleNamespace(temperature=35.0, humidity=50.0),
    )
    _enable_room_anomaly()

    sensor_monitor.run_monitor(db=object(), notify=True)

    kinds = [event.kind for event in dispatched]
    assert not any(kind.startswith("room_anomaly_") for kind in kinds)
    # 鮮度の通知は従来どおり動く
    assert "sensor_stale" in kinds


def test_stale_alert_excluded_device_does_not_notify(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch,
        data_dir,
        statuses=[_fake_status(device_id=1, stale=True)],
    )
    ui_settings.save_settings({ui_settings.SETTING_STALE_ALERT_EXCLUDED: ["device:1"]})

    sensor_monitor.run_monitor(db=object(), notify=True)

    assert dispatched == []
    assert _discord_stale == []


def test_stale_alert_excluded_device_state_is_not_recorded(data_dir, monkeypatch):
    _setup(
        monkeypatch,
        data_dir,
        statuses=[_fake_status(device_id=1, stale=True)],
    )
    ui_settings.save_settings({ui_settings.SETTING_STALE_ALERT_EXCLUDED: ["device:1"]})

    sensor_monitor.run_monitor(db=object(), notify=True)

    # 状態遷移も記録されない（除外を解除した直後の状態遷移が混ざらないことの担保）
    state = sensor_monitor._load_state()
    assert state["devices"].get("1", {}).get("status", "ok") == "ok"


def test_other_device_still_notified_when_one_is_excluded(data_dir, monkeypatch):
    dispatched = _setup(
        monkeypatch,
        data_dir,
        statuses=[
            _fake_status(device_id=1, stale=True),
            _fake_status(device_id=2, name="寝室", stale=True),
        ],
    )
    ui_settings.save_settings({ui_settings.SETTING_STALE_ALERT_EXCLUDED: ["device:1"]})

    sensor_monitor.run_monitor(db=object(), notify=True)

    dedupe_keys = [event.dedupe_key for event in dispatched]
    assert "sensor-stale-1" not in dedupe_keys
    assert "sensor-stale-2" in dedupe_keys


def test_discord_notify_posts_embed_and_hides_url_on_failure(monkeypatch, caplog):
    from backend import discord_notify

    secret = "https://discord.example/api/webhooks/1/SECRET-TOKEN"
    monkeypatch.setenv("DISCORD_ALERT_WEBHOOK_URL", secret)
    posted = []

    class _Resp:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(
        discord_notify.requests, "post", lambda url, **kw: posted.append((url, kw)) or _Resp()
    )
    assert discord_notify.send_alert("t", [{"name": "a", "value": "b"}]) is True
    assert posted[0][0] == secret
    assert posted[0][1]["json"]["allowed_mentions"] == {"parse": []}

    def _boom(url, **kw):
        raise discord_notify.requests.ConnectionError(f"failed for {url}")

    monkeypatch.setattr(discord_notify.requests, "post", _boom)
    assert discord_notify.send_alert("t", []) is False
    assert "SECRET-TOKEN" not in caplog.text
    assert "delivery failed" in caplog.text


def test_discord_notify_unconfigured_returns_false(monkeypatch):
    from backend import discord_notify

    monkeypatch.delenv("DISCORD_ALERT_WEBHOOK_URL", raising=False)
    assert discord_notify.send_alert("t", []) is False
