"""Tapo 候補の更新依頼と一覧の保存（#692）。"""

import datetime

import pytest

from backend import tapo_candidates

JST = tapo_candidates.JST


@pytest.fixture(autouse=True)
def _mock_store(monkeypatch, tmp_path):
    monkeypatch.setattr(tapo_candidates.database, "DB_MOCK", True)
    monkeypatch.setattr(tapo_candidates, "STATE_PATH", tmp_path / "tapo_candidates.json")


def at(minute):
    return datetime.datetime(2026, 10, 2, 10, minute, tzinfo=JST)


DEVICE = {"host": "192.168.2.24", "name": "サーキュレーター", "model": "P110", "measurable": True}


def test_initial_state_is_empty_and_not_pending():
    state = tapo_candidates.get_state()
    assert state == {
        "requested_at": None, "updated_at": None, "devices": [],
        "pending": False, "timed_out": False,
    }


def test_request_marks_pending_until_devices_arrive():
    assert tapo_candidates.request_refresh(now=at(0))["pending"] is True
    assert tapo_candidates.get_state(now=at(1))["pending"] is True

    state = tapo_candidates.save_devices([DEVICE], now=at(3))
    assert state["pending"] is False
    assert state["devices"] == [DEVICE]


def test_pressing_again_while_waiting_keeps_the_first_request_time():
    tapo_candidates.request_refresh(now=at(0))
    state = tapo_candidates.request_refresh(now=at(4))
    assert state["requested_at"] == at(0).isoformat()


def test_request_after_answer_is_pending_again():
    tapo_candidates.request_refresh(now=at(0))
    tapo_candidates.save_devices([DEVICE], now=at(1))
    assert tapo_candidates.request_refresh(now=at(10))["pending"] is True


def test_empty_result_still_finishes_the_request():
    tapo_candidates.request_refresh(now=at(0))
    state = tapo_candidates.save_devices([], now=at(1))
    assert state["pending"] is False
    assert state["devices"] == []


def test_request_expires_and_can_be_retried_without_losing_previous_devices():
    tapo_candidates.save_devices([DEVICE], now=at(0))
    tapo_candidates.request_refresh(now=at(1))

    assert tapo_candidates.get_state(now=at(15))["pending"] is True
    expired = tapo_candidates.get_state(now=at(16))
    assert expired["pending"] is False
    assert expired["timed_out"] is True
    assert expired["devices"] == [DEVICE]

    retried = tapo_candidates.request_refresh(now=at(17))
    assert retried["requested_at"] == at(17).isoformat()
    assert retried["pending"] is True
    assert retried["timed_out"] is False

    received = tapo_candidates.save_devices([DEVICE], now=at(18))
    assert received["pending"] is False
    assert received["timed_out"] is False


def test_normalize_drops_bad_rows_and_duplicates():
    devices = tapo_candidates.normalize_devices(
        [
            DEVICE,
            {**DEVICE, "name": "重複"},
            "not a dict",
            {"name": "hostなし"},
            {"host": "192.168.2.30", "measurable": 0},
        ]
    )
    assert [d["host"] for d in devices] == ["192.168.2.24", "192.168.2.30"]
    assert devices[1] == {"host": "192.168.2.30", "name": "192.168.2.30", "model": None, "measurable": False}


def test_endpoints_roundtrip():
    from fastapi.testclient import TestClient

    from backend.main import app
    from backend.auth import get_current_user

    app.dependency_overrides[get_current_user] = lambda: {"sub": "u"}
    try:
        client = TestClient(app)
        assert client.get("/api/energy/tapo-candidates/request").json() == {"pending": False}
        assert client.post("/api/energy/tapo-candidates/refresh").json()["pending"] is True
        assert client.get("/api/energy/tapo-candidates/request").json() == {"pending": True}
        res = client.post("/api/energy/tapo-candidates", json={"devices": [DEVICE]})
        assert res.json() == {"status": "ok", "devices": 1}
        body = client.get("/api/energy/tapo-candidates").json()
        assert body["pending"] is False and body["devices"] == [DEVICE]
    finally:
        app.dependency_overrides.clear()
