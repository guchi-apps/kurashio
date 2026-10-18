import re
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _issue(authed_client):
    response = authed_client.post("/api/device-tokens", json={"label": "Apple Watch"})
    assert response.status_code == 200
    return response.json()


def test_device_sensors_requires_valid_token(client):
    assert client.get("/api/device/sensors").status_code == 401
    wrong = client.get("/api/device/sensors", headers={"Authorization": "Bearer kdt_nope"})
    assert wrong.status_code == 401


def test_issued_token_reads_sensors_with_co2_level(authed_client):
    issued = _issue(authed_client)
    assert issued["token"].startswith("kdt_")

    response = authed_client.get(
        "/api/device/sensors", headers={"Authorization": f"Bearer {issued['token']}"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["staleThresholdMinutes"] > 0
    assert body["sensors"]
    for sensor in body["sensors"]:
        assert "co2Level" in sensor
        if sensor["co2"] is None:
            assert sensor["co2Level"] is None


def test_list_never_exposes_token_and_revoke_blocks_it(authed_client):
    issued = _issue(authed_client)
    listing = authed_client.get("/api/device-tokens").json()["tokens"]
    assert [t["id"] for t in listing] == [issued["id"]]
    assert "token" not in listing[0] and "hash" not in listing[0]

    assert authed_client.delete(f"/api/device-tokens/{issued['id']}").status_code == 200
    again = authed_client.get(
        "/api/device/sensors", headers={"Authorization": f"Bearer {issued['token']}"}
    )
    assert again.status_code == 401
    assert authed_client.delete(f"/api/device-tokens/{issued['id']}").status_code == 404


def test_internal_api_key_and_user_jwt_do_not_pass(authed_client, internal_api_key):
    response = authed_client.get(
        "/api/device/sensors", headers={"Authorization": f"Bearer {internal_api_key}"}
    )
    assert response.status_code == 401


def test_issuing_requires_login(client):
    assert client.post("/api/device-tokens", json={}).status_code in (401, 403)


def test_co2_thresholds_match_frontend():
    from backend.main import CO2_ELEVATED_PPM, CO2_HIGH_PPM, _co2_level

    source = (Path(__file__).resolve().parent.parent / "frontend/lib/device-metrics.ts").read_text()
    elevated = int(re.search(r"CO2_ELEVATED_PPM = (\d+)", source).group(1))
    high = int(re.search(r"CO2_HIGH_PPM = (\d+)", source).group(1))
    assert (CO2_ELEVATED_PPM, CO2_HIGH_PPM) == (elevated, high)
    assert [_co2_level(v) for v in (None, 999, 1000, 1499, 1500)] == [
        None, "good", "elevated", "elevated", "high"
    ]


def test_issue_reports_evicted_tokens_and_list_has_no_last_used(authed_client):
    from backend.device_tokens import MAX_TOKENS

    first = _issue(authed_client)
    assert first["revoked_ids"] == []
    for _ in range(MAX_TOKENS - 1):
        assert _issue(authed_client)["revoked_ids"] == []
    overflow = _issue(authed_client)
    assert overflow["revoked_ids"] == [first["id"]]
    listing = authed_client.get("/api/device-tokens").json()["tokens"]
    assert len(listing) == MAX_TOKENS
    assert all("last_used_at" not in t for t in listing)


@pytest.fixture
def db_mode_client(authed_client, tmp_path, monkeypatch):
    """本番と同じく `app_settings`（DB）へ保存する経路。DB_MOCK のファイル経路だけでは #802 を拾えない。"""
    from backend import database, main

    engine = create_engine(f"sqlite:///{tmp_path / 'device_tokens.db'}")
    database.AppSetting.__table__.create(engine)
    factory = sessionmaker(bind=engine)

    def get_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    monkeypatch.setattr(database, "DB_MOCK", False)
    # センサー一覧の組み立ては別のテーブルを読むので、ここでは照合だけを見る
    monkeypatch.setattr(main, "_build_room_state_sensors", lambda db: [])
    main.app.dependency_overrides[database.get_db] = get_db
    try:
        yield authed_client
    finally:
        del main.app.dependency_overrides[database.get_db]
        engine.dispose()


def test_issued_token_reads_sensors_in_db_mode(db_mode_client):
    """発行したトークンで、閉じている間の取得（ウィジェット・Watch）が通る（#802）。"""
    issued = _issue(db_mode_client)
    headers = {"Authorization": f"Bearer {issued['token']}"}
    assert db_mode_client.get("/api/device/sensors", headers=headers).status_code == 200

    assert db_mode_client.delete(f"/api/device-tokens/{issued['id']}").status_code == 200
    assert db_mode_client.get("/api/device/sensors", headers=headers).status_code == 401

