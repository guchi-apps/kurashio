"""`POST /api/energy` が `device_id` を受けるのは収集専用トークンがあるときだけ（#828）。"""

import pytest

import backend.main as main

BODY = {
    "records": [
        {"date": "2026-10-05", "source": "tapo:冷蔵庫", "kwh": 1.0, "device_id": "AABBCC112233"}
    ]
}


@pytest.fixture
def captured(client, monkeypatch):
    seen = []
    main.app.dependency_overrides[main.database.get_db] = lambda: None
    monkeypatch.setattr(main.database, "DB_MOCK", False)
    monkeypatch.setattr(main.energy, "upsert_records", lambda db, records, now=None: seen.extend(records) or len(records))
    monkeypatch.setenv("COLLECTOR_API_KEY", "collector-secret")
    yield seen
    del main.app.dependency_overrides[main.database.get_db]


def test_device_id_is_dropped_without_token(client, captured):
    assert client.post("/api/energy", json=BODY).status_code == 200
    assert captured[0]["device_id"] is None
    assert captured[0]["source"] == "tapo:冷蔵庫"


def test_device_id_is_dropped_with_wrong_token(client, captured):
    res = client.post("/api/energy", json=BODY, headers={"Authorization": "Bearer nope"})
    assert res.status_code == 200
    assert captured[0]["device_id"] is None


def test_device_id_is_kept_with_collector_token(client, captured):
    res = client.post("/api/energy", json=BODY, headers={"Authorization": "Bearer collector-secret"})
    assert res.status_code == 200
    assert captured[0]["device_id"] == "AABBCC112233"


def test_device_id_is_dropped_when_token_unset(client, captured, monkeypatch):
    monkeypatch.delenv("COLLECTOR_API_KEY")
    client.post("/api/energy", json=BODY, headers={"Authorization": "Bearer "})
    assert captured[0]["device_id"] is None
