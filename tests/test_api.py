import json

import pytest


def test_health_get(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "db_mock": True}


def test_health_head(client):
    response = client.head("/api/health")
    assert response.status_code == 200


def test_latest_requires_auth(client):
    response = client.get("/api/latest?device=1")
    assert response.status_code == 401


def test_latest_returns_mock_data(authed_client):
    response = authed_client.get("/api/latest?device=1")
    assert response.status_code == 200
    data = response.json()
    assert data["device_id"] == 1
    assert isinstance(data["temperature"], float)
    assert isinstance(data["illuminance"], float)
    assert data["outdoor_temperature"] == 25.0
    assert data["outdoor_weather_label"] == "晴れ"
    assert data["outdoor_weather_icon"] == "sun"


def test_latest_rejects_invalid_device(authed_client):
    response = authed_client.get("/api/latest?device=0")
    assert response.status_code == 400


def test_sensor_accepts_co2_only(client):
    response = client.post(
        "/api/sensor?device=2",
        json={"datetime": "2026-05-30 12:00:00", "co2": 400},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "mock_ok"


def test_sensor_accepts_illuminance_only(client):
    response = client.post(
        "/api/sensor?device=1",
        json={"datetime": "2026-05-31 12:00:00", "illuminance": 123.4},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "mock_ok"


def test_sensor_accepts_temperature_dht11(client):
    response = client.post(
        "/api/sensor?device=1",
        json={
            "datetime": "2026-05-31 12:00:00",
            "temperature": 25.3,
            "temperature_dht11": 25.0,
            "humidity": 60,
            "pressure": 1013,
            "illuminance": 123.4,
        },
    )
    assert response.status_code == 200
    received = response.json()["received"]
    assert received["temperature_dht11"] == 25.0
    assert received["temperature"] == 25.3


def test_sensor_rejects_empty_payload(client):
    response = client.post(
        "/api/sensor?device=1",
        json={"datetime": "2026-05-30 12:00:00"},
    )
    assert response.status_code == 422


def test_outdoor_history_day_returns_open_meteo_records(authed_client):
    response = authed_client.get("/api/outdoor-history?range=day")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert data[0]["outdoor_temperature"] == 22.0
    assert data[0]["outdoor_humidity"] == 55.0
    assert data[0]["outdoor_pressure"] == 1013


def test_history_day_returns_records(authed_client):
    response = authed_client.get("/api/history?range=day&device=1")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "temperature" in data[0]


def test_history_year_returns_daily_aggregation(authed_client):
    response = authed_client.get("/api/history?range=year&device=1")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 0
    sample = data[0]
    assert "temperature_min" in sample
    assert "temperature_max" in sample


def test_aircon_history_day_returns_records(authed_client):
    response = authed_client.get("/api/aircon/history?range=day&ac_id=1")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "temperature" in data[0]
    assert "target_temperature" in data[0]


def test_aircon_history_year_returns_daily_aggregation(authed_client):
    response = authed_client.get("/api/aircon/history?range=year&ac_id=1")
    assert response.status_code == 200
    data = response.json()
    assert len(data) > 0
    sample = data[0]
    assert "temperature_min" in sample
    assert "temperature_max" in sample
    assert any("target_temperature" in row for row in data)


def test_aircon_history_year_excludes_auto_shift_from_target_average(authed_client):
    """自動運転の設定温度は室温からのシフト量なので、年グラフの平均から外す。"""
    response = authed_client.get("/api/aircon/history?range=year&ac_id=1")
    assert response.status_code == 200
    data = response.json()
    targets = [row["target_temperature"] for row in data if "target_temperature" in row]
    assert targets
    # モックの固定設定温度は 24.0〜27.0。シフト量（1.0）が平均に混ざると 24.0 を割る
    assert all(24.0 <= target <= 27.0 for target in targets)


def test_is_aircon_auto_target_splits_shift_from_fixed_temperature():
    from backend.main import _is_aircon_auto_target

    assert _is_aircon_auto_target(0) is True
    assert _is_aircon_auto_target(1.0) is True
    assert _is_aircon_auto_target(-3.0) is True
    assert _is_aircon_auto_target(16.0) is False
    assert _is_aircon_auto_target(26.0) is False
    assert _is_aircon_auto_target(None) is False


def test_daily_stats_returns_list(authed_client):
    response = authed_client.get("/api/daily-stats?device=1")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "temp_max" in data[0]


def test_devices_list(authed_client):
    response = authed_client.get("/api/devices")
    assert response.status_code == 200
    devices = response.json()["devices"]
    assert any(device["id"] == 1 for device in devices)


def test_update_device_name(authed_client):
    response = authed_client.put(
        "/api/devices/1",
        json={"name": "テスト部屋"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "テスト部屋"

    listed = authed_client.get("/api/devices").json()["devices"]
    assert next(item for item in listed if item["id"] == 1)["name"] == "テスト部屋"


def test_update_device_inherits_from(authed_client):
    response = authed_client.put(
        "/api/devices/2",
        json={"name": "新リビング", "inherits_from": 1},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "新リビング"
    assert data["inherits_from"] == 1

    listed = authed_client.get("/api/devices").json()["devices"]
    device2 = next(item for item in listed if item["id"] == 2)
    assert device2["inherits_from"] == 1


def test_update_device_rejects_self_inheritance(authed_client):
    response = authed_client.put(
        "/api/devices/1",
        json={"name": "リビング", "inherits_from": 1},
    )
    assert response.status_code == 400


def test_update_device_name_rejects_empty(authed_client):
    response = authed_client.put(
        "/api/devices/1",
        json={"name": "   "},
    )
    assert response.status_code == 400


def test_outdoor_location_get(authed_client):
    response = authed_client.get("/api/outdoor-location")
    assert response.status_code == 200
    data = response.json()
    assert "latitude" in data
    assert "longitude" in data
    assert "name" in data


def test_outdoor_location_update(authed_client):
    response = authed_client.put(
        "/api/outdoor-location",
        json={"latitude": 35.0, "longitude": 135.5, "name": "大阪"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "大阪"


def test_outdoor_location_rejects_invalid_latitude(authed_client):
    response = authed_client.put(
        "/api/outdoor-location",
        json={"latitude": 999, "longitude": 135.5, "name": "bad"},
    )
    assert response.status_code == 400


def test_outdoor_location_search(authed_client):
    response = authed_client.get("/api/outdoor-location/search?q=大阪")
    assert response.status_code == 200
    results = response.json()["results"]
    assert len(results) == 1
    assert results[0]["name"] == "大阪"


def test_outdoor_locations_list_starts_with_one(authed_client):
    response = authed_client.get("/api/outdoor-locations")
    assert response.status_code == 200
    locations = response.json()["locations"]
    assert len(locations) == 1
    assert locations[0]["is_primary"] is True


def test_outdoor_locations_add_and_list(authed_client):
    response = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    )
    assert response.status_code == 200
    created = response.json()
    assert created["name"] == "実家"
    assert created["is_primary"] is False

    listed = authed_client.get("/api/outdoor-locations").json()["locations"]
    assert len(listed) == 2


def test_outdoor_locations_update(authed_client):
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()

    response = authed_client.put(
        f"/api/outdoor-locations/{created['id']}",
        json={"name": "実家（改名）", "latitude": 35.7, "longitude": 139.7},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "実家（改名）"


def test_outdoor_locations_update_missing_returns_404(authed_client):
    response = authed_client.put(
        "/api/outdoor-locations/does-not-exist",
        json={"name": "x", "latitude": 0, "longitude": 0},
    )
    assert response.status_code == 404


def test_outdoor_locations_cannot_delete_primary(authed_client):
    primary_id = authed_client.get("/api/outdoor-locations").json()["locations"][0]["id"]
    response = authed_client.delete(f"/api/outdoor-locations/{primary_id}")
    assert response.status_code == 400


def test_outdoor_locations_delete_non_primary(authed_client):
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()

    response = authed_client.delete(f"/api/outdoor-locations/{created['id']}")
    assert response.status_code == 200

    listed = authed_client.get("/api/outdoor-locations").json()["locations"]
    assert len(listed) == 1


def test_outdoor_locations_set_primary(authed_client):
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()

    response = authed_client.put(f"/api/outdoor-locations/{created['id']}/primary")
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]

    listed = authed_client.get("/api/outdoor-locations").json()["locations"]
    primary = next(loc for loc in listed if loc["is_primary"])
    assert primary["id"] == created["id"]

    # 基準地点が入れ替わったので、元の地点は削除できるようになる
    old_primary_id = next(loc for loc in listed if not loc["is_primary"])["id"]
    assert authed_client.delete(f"/api/outdoor-locations/{old_primary_id}").status_code == 200


def test_outdoor_location_weather_by_id(authed_client):
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()

    response = authed_client.get(f"/api/outdoor-locations/{created['id']}/weather")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "実家"
    assert data["temperature"] == 25.0
    assert data["weather_label"] == "晴れ"


def test_outdoor_locations_weather_returns_every_location(authed_client):
    """ダッシュボードは地点ごとにカードを出すため、まとめて取れる必要がある（#321）"""
    authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    )

    response = authed_client.get("/api/outdoor-locations/weather")
    assert response.status_code == 200
    locations = response.json()["locations"]

    listed = authed_client.get("/api/outdoor-locations").json()["locations"]
    assert [item["id"] for item in locations] == [item["id"] for item in listed]
    assert {item["name"] for item in locations} >= {"実家"}
    for item in locations:
        assert item["temperature"] == 25.0
        assert item["weather_label"] == "晴れ"


def test_outdoor_location_weather_missing_returns_404(authed_client):
    response = authed_client.get("/api/outdoor-locations/does-not-exist/weather")
    assert response.status_code == 404


def test_outdoor_history_accepts_location_id(authed_client):
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()

    response = authed_client.get(
        f"/api/outdoor-history?range=day&location_id={created['id']}"
    )
    assert response.status_code == 200


def test_aircon_latest_returns_mock_data(authed_client):
    response = authed_client.get("/api/aircon/latest")
    assert response.status_code == 200
    data = response.json()
    assert data["room_temperature"] is not None
    assert data["target_temperature"] is not None
    assert data["mode"] == "COOLING"


def test_aircon_post_accepts_status(client):
    response = client.post(
        "/api/aircon",
        json={
            "datetime": "2026-05-30 12:00:00",
            "ac_id": 1,
            "name": "リビング",
            "room_temperature": 24.5,
            "target_temperature": 26.0,
            "mode": "COOLING",
            "power": "ON",
            "online": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "mock_ok"


def test_aircon_units_list(authed_client):
    response = authed_client.get("/api/aircon/units")
    assert response.status_code == 200
    units = response.json()["units"]
    assert any(unit["ac_id"] == 1 for unit in units)


def test_update_aircon_unit_name(authed_client):
    response = authed_client.put(
        "/api/aircon/units/1",
        json={"name": "寝室エアコン"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "寝室エアコン"

    latest = authed_client.get("/api/aircon/latest").json()
    assert latest["name"] == "寝室エアコン"


def test_update_aircon_unit_name_rejects_empty(authed_client):
    response = authed_client.put(
        "/api/aircon/units/1",
        json={"name": "   "},
    )
    assert response.status_code == 400


def test_records_list_returns_mock_data(authed_client):
    response = authed_client.get("/api/records?device=1")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data["records"], list)
    assert len(data["records"]) > 0
    assert data["records"][0]["device_id"] == 1
    assert "datetime" in data["records"][0]


def test_records_delete_mock_ok(authed_client):
    response = authed_client.delete(
        "/api/records",
        params={"device": 1, "datetime": "2026-05-30 12:00:00"},
    )
    assert response.status_code == 200
    assert response.json()["deleted"] is True


def test_records_bulk_delete_mock_ok(authed_client):
    response = authed_client.post(
        "/api/records/bulk-delete",
        json={
            "device": 1,
            "datetimes": ["2026-05-30 12:00:00", "2026-05-30 11:00:00"],
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["deleted_count"] == 2


def test_records_bulk_delete_rejects_empty(authed_client):
    response = authed_client.post(
        "/api/records/bulk-delete",
        json={"device": 1, "datetimes": []},
    )
    assert response.status_code == 400


def test_records_rejects_invalid_device(authed_client):
    response = authed_client.get("/api/records?device=0")
    assert response.status_code == 400


def test_aircon_daily_stats_returns_mock_data(authed_client):
    response = authed_client.get("/api/aircon/daily-stats?ac_id=1")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "temp_min" in data[0]
    assert "temp_max" in data[0]
    assert "humid_min" not in data[0]


def test_ui_settings_keeps_per_location_outdoor_keys(authed_client):
    """屋外の並び・非表示は地点ごとのキーになる（#321）。DDLも正規化の追加も不要"""
    created = authed_client.post(
        "/api/outdoor-locations",
        json={"name": "実家", "latitude": 35.6895, "longitude": 139.6917},
    ).json()
    key = f"outdoor:{created['id']}"

    response = authed_client.put(
        "/api/ui-settings",
        json={"display_order": ["device:1", key, "aircon"], "hidden_devices": [key]},
    )
    assert response.status_code == 200

    data = authed_client.get("/api/ui-settings").json()
    assert key in data["display_order"]
    assert data["hidden_devices"] == [key]


def test_ui_settings_get_and_update(authed_client):
    response = authed_client.get("/api/ui-settings")
    assert response.status_code == 200
    data = response.json()
    assert "display_order" in data
    assert "chart_colors" in data
    assert "hidden_devices" in data

    updated = authed_client.put(
        "/api/ui-settings",
        json={
            "display_order": ["device:2", "device:1", "outdoor", "aircon"],
            "hidden_devices": ["device:2"],
            "chart_colors": {"device:1": "#3498db", "device:2": "#e67e22"},
        },
    )
    assert updated.status_code == 200
    saved = updated.json()
    assert saved["display_order"][0] == "device:2"
    assert "device:2" in saved["hidden_devices"]

    fetched = authed_client.get("/api/ui-settings").json()
    assert fetched["display_order"][0] == "device:2"
    assert "device:2" in fetched["hidden_devices"]


# --- 照明の点灯とみなす照度（#258） ---


def test_light_thresholds_default_is_empty(authed_client):
    """既定では判定しない。設定するまで画面の表示は増えない。"""
    data = authed_client.get("/api/ui-settings").json()
    assert data["light_thresholds"] == {}


def test_light_thresholds_saved_per_device(authed_client):
    saved = authed_client.put(
        "/api/ui-settings",
        json={"light_thresholds": {"1": 80}},
    ).json()
    assert saved["light_thresholds"] == {"1": 80.0}

    fetched = authed_client.get("/api/ui-settings").json()
    assert fetched["light_thresholds"] == {"1": 80.0}


def test_light_thresholds_drop_disabled_and_invalid_values(authed_client):
    """0以下・上限超え・数値でない値は「判定しない」として保存しない。"""
    saved = authed_client.put(
        "/api/ui-settings",
        json={
            "light_thresholds": {
                "1": 80,
                "2": 0,
                "3": -5,
                "4": 999999,
            }
        },
    ).json()
    assert saved["light_thresholds"] == {"1": 80.0}


def test_light_thresholds_kept_when_other_settings_change(authed_client):
    """別の設定だけを保存したときに、しきい値が消えない。"""
    authed_client.put("/api/ui-settings", json={"light_thresholds": {"1": 120.5}})
    authed_client.put("/api/ui-settings", json={"hidden_devices": ["device:2"]})

    fetched = authed_client.get("/api/ui-settings").json()
    assert fetched["light_thresholds"] == {"1": 120.5}


# --- 場所と照明の紐付け・点灯履歴（#368） ---


def test_light_sources_default_is_empty(authed_client):
    """既定では紐付けていない。詳細パネルの見た目は今までどおり。"""
    assert authed_client.get("/api/ui-settings").json()["light_sources"] == {}


def test_light_sources_saved_per_device(authed_client):
    saved = authed_client.put(
        "/api/ui-settings",
        json={
            "light_sources": {
                "1": {"kind": "illuminance"},
                "2": {"kind": "remo", "appliance_key": "d-1f2e3d4c5b"},
            }
        },
    ).json()
    assert saved["light_sources"] == {
        "1": {"kind": "illuminance"},
        "2": {"kind": "remo", "appliance_key": "d-1f2e3d4c5b"},
    }


def test_light_sources_drop_unknown_kind_and_keyless_remo(authed_client):
    """知らない種別・機器を指していない remo は「紐付けを外す」として保存しない。"""
    saved = authed_client.put(
        "/api/ui-settings",
        json={
            "light_sources": {
                "1": {"kind": "illuminance"},
                "2": {"kind": "remo"},
                "3": {"kind": "switchbot"},
            }
        },
    ).json()
    assert saved["light_sources"] == {"1": {"kind": "illuminance"}}


def test_light_sources_reject_non_object_entry(authed_client):
    """値がオブジェクトでない紐付けは、正規化まで届かず422で弾く。

    保存済みの壊れた値を読み飛ばすのは `_normalize_light_sources()` の役目だが、
    画面から送られてきた時点で形が違うなら、黙って落とすより理由を返すほうがよい。
    """
    response = authed_client.put(
        "/api/ui-settings", json={"light_sources": {"1": "illuminance"}}
    )
    assert response.status_code == 422


def test_light_sources_kept_when_other_settings_change(authed_client):
    """別の設定だけを保存したときに、紐付けが消えない（save_settings の merged 漏れ検知）。"""
    authed_client.put("/api/ui-settings", json={"light_sources": {"1": {"kind": "illuminance"}}})
    authed_client.put("/api/ui-settings", json={"hidden_devices": ["device:2"]})

    fetched = authed_client.get("/api/ui-settings").json()
    assert fetched["light_sources"] == {"1": {"kind": "illuminance"}}


def test_light_history_without_source_returns_null_source(authed_client):
    """紐付けていない場所は「履歴が空」ではなく「照明を持たない」として返す。"""
    data = authed_client.get("/api/light-history?device=1&range=day").json()
    assert data["source"] is None
    assert data["segments"] == []
    assert data["summary"] == {"on_count": 0, "on_minutes": 0}


def test_light_history_illuminance_needs_threshold(authed_client):
    """照度から判定する設定でも、しきい値が無ければ区間は作れない。"""
    authed_client.put("/api/ui-settings", json={"light_sources": {"1": {"kind": "illuminance"}}})

    data = authed_client.get("/api/light-history?device=1&range=day").json()
    assert data["source"] == {"kind": "illuminance", "name": "", "threshold": None}
    assert data["segments"] == []


def test_light_history_from_illuminance(authed_client):
    """しきい値を設定すると、モックの照度から点灯の区間が出る。"""
    authed_client.put("/api/ui-settings", json={"light_thresholds": {"1": 80}})
    authed_client.put("/api/ui-settings", json={"light_sources": {"1": {"kind": "illuminance"}}})

    data = authed_client.get("/api/light-history?device=1&range=day").json()
    assert data["source"]["kind"] == "illuminance"
    assert data["source"]["threshold"] == 80.0
    assert data["segments"], "モックの照度なら点灯の区間が1つ以上できる"
    assert data["summary"]["on_minutes"] > 0
    # 区間は必ず窓の中に収まる
    for segment in data["segments"]:
        assert data["start"] <= segment["start"] <= data["end"]
        assert data["start"] <= segment["end"] <= data["end"]


def test_light_history_from_remo_state(authed_client):
    """Nature Remo の記録から作る場合、日射の印は付けない。"""
    authed_client.put(
        "/api/ui-settings",
        json={"light_sources": {"1": {"kind": "remo", "appliance_key": "d-mock"}}},
    )

    data = authed_client.get("/api/light-history?device=1&range=day").json()
    assert data["source"]["kind"] == "remo"
    assert data["segments"], "モックの点灯・消灯なら区間ができる"
    assert all(segment["daylight"] is False for segment in data["segments"])


def test_light_history_events_are_newest_first(authed_client):
    authed_client.put(
        "/api/ui-settings",
        json={"light_sources": {"1": {"kind": "remo", "appliance_key": "d-mock"}}},
    )

    events = authed_client.get("/api/light-history?device=1&range=day").json()["events"]
    assert events == sorted(events, key=lambda row: row["datetime"], reverse=True)
    assert {row["status"] for row in events} <= {"on", "off"}


def test_light_source_candidates_empty_without_catalog(authed_client):
    """候補一覧を一度も取得していなければ空。画面はそちらへ案内する。"""
    data = authed_client.get("/api/light-sources").json()
    assert data["candidates"] == []
    assert data["catalog_fetched_at"] == ""


# --- 「電気の操作」のボタン名・表示の選択（#260） ---


@pytest.fixture
def remote_buttons_config(data_dir, monkeypatch):
    """ボタン定義を tmp_path 側へ向ける。リポジトリの data/remote.json は空なので見ない。"""
    path = data_dir / "remote.json"
    path.write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "id": "light",
                        "name": "照明",
                        "buttons": [
                            {"id": "light-on", "label": "点ける", "signal_id": "sig-on"},
                            {"id": "light-off", "label": "消す", "signal_id": "sig-off"},
                        ],
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("backend.remote.CONFIG_PATH", path)
    return path


def test_remote_buttons_start_from_remote_json(authed_client, remote_buttons_config):
    payload = authed_client.get("/api/remote/buttons").json()

    assert payload["configured"] is True
    assert [button["label"] for button in payload["groups"][0]["buttons"]] == [
        "点ける",
        "消す",
    ]
    assert all(button["hidden"] is False for button in payload["groups"][0]["buttons"])


def test_saved_names_and_hidden_flags_come_back_from_the_api(
    authed_client, remote_buttons_config
):
    """設定画面で保存した内容が、そのまま一覧APIに反映されるところまで通す。"""
    saved = authed_client.put(
        "/api/ui-settings",
        json={
            "remote_buttons": {
                "light-on": {"label": "あかりをつける"},
                "light-off": {"hidden": True},
            }
        },
    )
    assert saved.status_code == 200
    assert saved.json()["remote_buttons"]["light-on"] == {"label": "あかりをつける"}

    buttons = authed_client.get("/api/remote/buttons").json()["groups"][0]["buttons"]
    assert buttons[0]["label"] == "あかりをつける"
    # もとの名前は残る（設定画面が「もとの名前」を出すため）
    assert buttons[0]["default_label"] == "点ける"
    # 隠したボタンも一覧からは消えない。出さない判断は画面側で行う
    assert buttons[1]["hidden"] is True


def test_clearing_a_name_restores_the_one_from_remote_json(
    authed_client, remote_buttons_config
):
    authed_client.put(
        "/api/ui-settings",
        json={"remote_buttons": {"light-on": {"label": "あかりをつける"}}},
    )
    authed_client.put(
        "/api/ui-settings",
        json={"remote_buttons": {"light-on": {"label": "", "hidden": False}}},
    )

    settings = authed_client.get("/api/ui-settings").json()
    assert settings["remote_buttons"] == {}

    buttons = authed_client.get("/api/remote/buttons").json()["groups"][0]["buttons"]
    assert buttons[0]["label"] == "点ける"


# --- サーバー間参照用の内部API（AIDE 連携 / #161） ---


def test_internal_room_state_requires_configured_key(client, no_internal_api_key):
    """INTERNAL_API_KEY が未設定なら 503。401（値が違う）と切り分けられること。"""
    response = client.get(
        "/api/internal/room-state",
        headers={"Authorization": "Bearer anything"},
    )
    assert response.status_code == 503


def test_internal_room_state_rejects_missing_token(client, internal_api_key):
    response = client.get("/api/internal/room-state")
    assert response.status_code == 401


def test_internal_room_state_rejects_wrong_token(client, internal_api_key):
    response = client.get(
        "/api/internal/room-state",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert response.status_code == 401


def test_internal_room_state_rejects_non_bearer_scheme(client, internal_api_key):
    response = client.get(
        "/api/internal/room-state",
        headers={"Authorization": f"Token {internal_api_key}"},
    )
    assert response.status_code == 401


def test_internal_room_state_does_not_accept_login_session(authed_client, internal_api_key):
    """ログインセッションでは通さない（サーバー間専用）。"""
    response = authed_client.get("/api/internal/room-state")
    assert response.status_code == 401


def test_internal_room_state_returns_snapshot(client, internal_api_key):
    response = client.get(
        "/api/internal/room-state",
        headers={"Authorization": f"Bearer {internal_api_key}"},
    )
    assert response.status_code == 200
    data = response.json()

    # 日時はオフセット付き。VPS が UTC のため、付いていないと受け側で9時間ずれる。
    assert data["fetchedAt"].endswith("+09:00")
    assert data["staleThresholdMinutes"] == 15

    sensor = data["sensors"][0]
    assert sensor["deviceId"] == 1
    assert sensor["name"]
    assert sensor["measuredAt"].endswith("+09:00")
    assert sensor["stale"] is False
    assert isinstance(sensor["ageMinutes"], float)
    assert isinstance(sensor["temperature"], float)
    # 履歴・日別統計は載せない
    assert "history" not in sensor

    assert data["outdoor"]["temperature"] == 25.0
    assert data["outdoor"]["observedAt"] == "2026-08-19T21:00:00+09:00"

    aircon = data["aircons"][0]
    assert aircon["acId"] == 1
    assert aircon["power"] == "ON"
    assert aircon["targetTemperature"] == 26.0
    assert aircon["measuredAt"].endswith("+09:00")
    assert aircon["online"] is True


def test_internal_room_state_uses_camel_case_only(client, internal_api_key):
    """AIDE 側は camelCase を前提に実装済み。snake_case が混ざっていないこと。"""
    response = client.get(
        "/api/internal/room-state",
        headers={"Authorization": f"Bearer {internal_api_key}"},
    )
    data = response.json()
    keys = set(data) | set(data["sensors"][0]) | set(data["outdoor"]) | set(data["aircons"][0])
    assert not [key for key in keys if "_" in key]


def test_bills_summary_requires_auth(client):
    response = client.get("/api/bills/summary")
    assert response.status_code == 401


def test_bills_summary_returns_mock_months(authed_client):
    response = authed_client.get("/api/bills/summary?months=12")
    assert response.status_code == 200
    data = response.json()

    assert len(data["months"]) == 12
    # 今月ぶんは検針が終わるまで確定しないので、最新は先月分になる
    latest = data["latest"]
    assert latest["billing_month"] == data["months"][-1]["billing_month"]
    assert latest["electricity"]["usage_unit"] == "kWh"
    assert latest["gas"]["usage_unit"] == "m3"
    assert (
        latest["total_yen"]
        == latest["electricity"]["amount_yen"] + latest["gas"]["amount_yen"]
    )


def test_post_bills_is_accepted_in_mock_mode(client):
    response = client.post(
        "/api/bills",
        json={
            "records": [
                {
                    "billing_month": "2026-08",
                    "kind": "electricity",
                    "contract_key": "c1",
                    "plan_name": "なっトクでんき",
                    "amount_yen": 15760,
                    "usage_value": 540,
                    "usage_unit": "kWh",
                }
            ]
        },
    )
    assert response.status_code == 200
    assert response.json()["received"] == 1


def test_post_bills_rejects_a_missing_amount(client):
    response = client.post(
        "/api/bills",
        json={"records": [{"billing_month": "2026-08", "kind": "electricity"}]},
    )
    assert response.status_code == 422


def test_post_bills_rejects_an_unknown_kind_even_in_mock_mode(client):
    # モックの開発サーバー相手に試したときに書式の誤りを見逃さない
    response = client.post(
        "/api/bills",
        json={"records": [{"billing_month": "2026-08", "kind": "water", "amount_yen": 100}]},
    )
    assert response.status_code == 422


def test_post_bills_rejects_a_malformed_billing_month(client):
    response = client.post(
        "/api/bills",
        json={
            "records": [
                {"billing_month": "2026年8月", "kind": "electricity", "amount_yen": 100}
            ]
        },
    )
    assert response.status_code == 422


# --- 掃除した日の指定（#294） -------------------------------------------------


def _register_cleaning_task(authed_client):
    response = authed_client.put(
        "/api/cleaning/tasks",
        json={"tasks": [{"id": "sink", "name": "シンク", "interval_days": 3, "steps": []}]},
    )
    assert response.status_code == 200
    return response.json()["today"]


def test_cleaning_done_defaults_to_today(authed_client):
    today = _register_cleaning_task(authed_client)

    response = authed_client.post("/api/cleaning/tasks/sink/done")
    assert response.status_code == 200
    task = response.json()["tasks"][0]
    assert task["last_done"] == today
    assert task["history"][0]["date"] == today
    # 登録日時は掃除した日とは別に持つ（監査用）
    assert task["history"][0]["recorded_at"].startswith(today)


def test_cleaning_done_accepts_a_past_date(authed_client):
    """当日に押し忘れても、前日ぶんとして登録できる。"""
    _register_cleaning_task(authed_client)

    response = authed_client.post(
        "/api/cleaning/tasks/sink/done", json={"date": "2026-08-25"}
    )
    assert response.status_code == 200
    task = response.json()["tasks"][0]
    assert task["last_done"] == "2026-08-25"
    # 次にやる日は登録した日ではなく掃除した日から数える
    assert task["next_due"] == "2026-08-28"


def test_cleaning_done_rejects_a_future_date(authed_client):
    _register_cleaning_task(authed_client)

    response = authed_client.post(
        "/api/cleaning/tasks/sink/done", json={"date": "2099-01-01"}
    )
    assert response.status_code == 400
    assert "未来" in response.json()["detail"]


def test_cleaning_done_rejects_a_malformed_date(authed_client):
    _register_cleaning_task(authed_client)

    response = authed_client.post(
        "/api/cleaning/tasks/sink/done", json={"date": "2026/08/25"}
    )
    assert response.status_code == 400


def test_cleaning_done_can_be_deleted(authed_client):
    """日付を間違えて登録したときは、その1件を取り消して入れ直す。"""
    _register_cleaning_task(authed_client)
    authed_client.post("/api/cleaning/tasks/sink/done", json={"date": "2026-08-25"})

    response = authed_client.delete("/api/cleaning/tasks/sink/done/2026-08-25")
    assert response.status_code == 200
    task = response.json()["tasks"][0]
    assert task["history"] == []
    assert task["last_done"] is None


def test_cleaning_delete_reports_an_unknown_record(authed_client):
    _register_cleaning_task(authed_client)

    response = authed_client.delete("/api/cleaning/tasks/sink/done/2026-08-25")
    assert response.status_code == 404


def test_energy_source_names_reach_the_breakdown_label(authed_client):
    """画面から付けた別名が、そのまま消費電力の取得元のラベルになる（#335）"""
    before = authed_client.get("/api/energy/breakdown").json()
    plug = next(row for row in before["sources"] if row["source"].startswith("tapo:"))
    assert plug["label"] == plug["default_label"]

    saved = authed_client.put(
        "/api/ui-settings",
        json={"energy_source_names": {plug["source"]: "キッチンの冷蔵庫"}},
    )
    assert saved.status_code == 200
    assert saved.json()["energy_source_names"] == {plug["source"]: "キッチンの冷蔵庫"}

    after = authed_client.get("/api/energy/breakdown").json()
    renamed = next(row for row in after["sources"] if row["source"] == plug["source"])
    assert renamed["label"] == "キッチンの冷蔵庫"
    # 別名を付けても source と既定の名前は変えない（過去の使用量と切らないため）
    assert renamed["default_label"] == plug["default_label"]

    # 空にすると既定へ戻る
    authed_client.put("/api/ui-settings", json={"energy_source_names": {}})
    restored = authed_client.get("/api/energy/breakdown").json()
    back = next(row for row in restored["sources"] if row["source"] == plug["source"])
    assert back["label"] == plug["default_label"]


def test_ui_settings_room_layout_round_trip(authed_client):
    """部屋の3Dビューの対応表（#399）。`UiSettingsUpdate` にフィールドが無いと素通りする。"""
    initial = authed_client.get("/api/ui-settings").json()
    assert initial["room_layout"] == {"zones": []}

    updated = authed_client.put(
        "/api/ui-settings",
        json={
            "room_layout": {
                "zones": [
                    {
                        "key": "ldk",
                        "device_id": 1,
                        "ac_id": 1,
                        "cleaning_task_ids": ["yuka", "yuka"],
                    },
                    {"key": "bath", "device_id": None, "ac_id": None, "cleaning_task_ids": []},
                ]
            }
        },
    )
    assert updated.status_code == 200
    assert updated.json()["room_layout"]["zones"][0]["cleaning_task_ids"] == ["yuka"]

    # 別のキーだけを保存しても消えないこと（save_settings の merged 漏れを拾う）
    authed_client.put("/api/ui-settings", json={"energy_unit_price": 29.5})

    fetched = authed_client.get("/api/ui-settings").json()
    assert fetched["room_layout"]["zones"][0]["device_id"] == 1
    assert fetched["room_layout"]["zones"][1]["key"] == "bath"
    assert fetched["energy_unit_price"] == 29.5


def test_put_water_bill_requires_auth(client):
    response = client.put("/api/bills/water", json={"billing_month": "2026-08", "amount_yen": 5000})
    assert response.status_code == 401


def test_put_water_bill_is_accepted_in_mock_mode(authed_client):
    response = authed_client.put(
        "/api/bills/water",
        json={"billing_month": "2026-08", "amount_yen": 5000, "usage_m3": 20},
    )
    assert response.status_code == 200


def test_put_water_bill_rejects_bad_input_even_in_mock_mode(authed_client):
    for body in (
        {"billing_month": "2026-08", "amount_yen": -1},
        {"billing_month": "bad", "amount_yen": 5000},
        {"billing_month": "2026-08", "amount_yen": 5000, "extra": 1},
    ):
        assert authed_client.put("/api/bills/water", json=body).status_code == 422


def test_bills_summary_mock_has_latest_water(authed_client):
    data = authed_client.get("/api/bills/summary").json()
    assert data["latest_water"]["water"]["usage_unit"] == "m3"
