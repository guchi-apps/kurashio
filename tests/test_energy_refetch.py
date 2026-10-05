"""消費電力の「指定日以降の再取得」の依頼と完了印（#711）。"""

import datetime

import pytest

from backend import energy_refetch as er

JST = er.JST
SINCE = datetime.date(2026, 10, 1)


@pytest.fixture(autouse=True)
def _mock_store(monkeypatch, tmp_path):
    monkeypatch.setattr(er.database, "DB_MOCK", True)
    monkeypatch.setattr(er, "STATE_PATH", tmp_path / "energy_refetch.json")


def at(minute, day=5):
    return datetime.datetime(2026, 10, day, 10, 0, tzinfo=JST) + datetime.timedelta(minutes=minute)


def test_initial_state_is_idle():
    state = er.get_state(now=at(0))
    assert state["pending"] is False
    assert state["since"] is None
    assert {k: v["status"] for k, v in state["sources"].items()} == {"tapo": "idle", "aircon": "idle"}


def test_request_makes_both_sources_waiting_and_visible_to_collectors():
    state = er.request_refetch(SINCE, now=at(0))
    assert state["pending"] is True
    assert state["since"] == "2026-10-01"
    assert er.get_request_for("tapo", now=at(1))["since"] == "2026-10-01"
    assert er.get_request_for("aircon", now=at(1))["pending"] is True


def test_done_is_per_source_and_pending_until_all_done():
    requested_at = er.request_refetch(SINCE, now=at(0))["requested_at"]
    state = er.mark_done("tapo", requested_at, now=at(3))
    assert state["sources"]["tapo"]["status"] == "done"
    assert state["sources"]["aircon"]["status"] == "waiting"
    assert state["pending"] is True
    assert er.get_request_for("tapo", now=at(4))["pending"] is False
    assert er.get_request_for("aircon", now=at(4))["pending"] is True

    state = er.mark_done("aircon", requested_at, now=at(40))
    assert state["pending"] is False


def test_stale_done_does_not_complete_a_newer_request():
    old = er.request_refetch(SINCE, now=at(0))["requested_at"]
    # 期限切れのあとで新しい依頼を立てる
    new = er.request_refetch(SINCE, now=at(100))["requested_at"]
    assert new != old
    state = er.mark_done("tapo", old, now=at(101))
    assert state["sources"]["tapo"]["status"] == "waiting"


def test_request_times_out_after_90_minutes():
    er.request_refetch(SINCE, now=at(0))
    state = er.get_state(now=at(91))
    assert state["pending"] is False
    assert state["sources"]["tapo"]["status"] == "timed_out"
    assert er.get_request_for("tapo", now=at(91))["pending"] is False


def test_second_request_while_pending_is_rejected():
    er.request_refetch(SINCE, now=at(0))
    with pytest.raises(er.RefetchBusyError):
        er.request_refetch(SINCE, now=at(5))


def test_rejects_future_and_too_old_dates():
    with pytest.raises(er.RefetchError):
        er.request_refetch(datetime.date(2026, 10, 6), now=at(0))
    with pytest.raises(er.RefetchError):
        er.request_refetch(datetime.date(2026, 10, 5) - datetime.timedelta(days=er.MAX_DAYS), now=at(0))
    # ちょうど上限の手前は通る
    er.request_refetch(datetime.date(2026, 10, 5) - datetime.timedelta(days=er.MAX_DAYS - 1), now=at(0))


def test_unknown_kind_is_not_pending_and_cannot_be_marked():
    er.request_refetch(SINCE, now=at(0))
    assert er.get_request_for("unknown", now=at(1))["pending"] is False
    with pytest.raises(er.RefetchError):
        er.mark_done("unknown", "x", now=at(1))


def test_broken_saved_state_reads_as_idle(tmp_path):
    er.STATE_PATH.write_text('{"requested_at": "x", "since": 1}', encoding="utf-8")
    assert er.get_state(now=at(0))["pending"] is False


def test_accepts_naive_jst_now_like_main_get_now_jst():
    naive = datetime.datetime(2026, 10, 5, 10, 0)
    state = er.request_refetch(SINCE, now=naive)
    assert state["pending"] is True
    assert er.get_request_for("tapo", now=naive + datetime.timedelta(minutes=1))["pending"] is True


# --------------------------- 収集向けの2口の認証（#714）


@pytest.fixture
def api(client, authed_client, monkeypatch):
    """依頼を1件立てたうえで、未認証の収集クライアントとログイン済みクライアントを返す。"""
    import backend.main as main

    monkeypatch.setattr(main, "get_now_jst", lambda: at(0))
    requested_at = authed_client.post(
        "/api/energy/refetch", json={"since": SINCE.isoformat()}
    ).json()["requested_at"]
    return client, requested_at


def _state(client_):
    return client_.get("/api/energy/refetch").json()["sources"]["tapo"]["status"]


def _done_body(requested_at):
    return {"kind": "tapo", "requested_at": requested_at}


def test_collector_endpoints_reject_missing_and_wrong_token(api, collector_api_key, authed_client):
    client_, requested_at = api
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": f"Token {collector_api_key}"}):
        assert client_.get("/api/energy/refetch/request?kind=tapo", headers=headers).status_code == 401
        res = client_.post("/api/energy/refetch/done", json=_done_body(requested_at), headers=headers)
        assert res.status_code == 401
    assert _state(authed_client) == "waiting"


def test_collector_endpoints_fail_closed_when_key_unset(api, no_collector_api_key, authed_client):
    client_, requested_at = api
    headers = {"Authorization": "Bearer anything"}
    assert client_.get("/api/energy/refetch/request?kind=tapo", headers=headers).status_code == 503
    assert (
        client_.post("/api/energy/refetch/done", json=_done_body(requested_at), headers=headers).status_code
        == 503
    )
    # 空のトークンでも通らない
    assert client_.get("/api/energy/refetch/request?kind=tapo", headers={"Authorization": "Bearer "}).status_code == 503
    assert _state(authed_client) == "waiting"


def test_other_internal_keys_do_not_open_collector_endpoints(
    api, collector_api_key, internal_api_key, internal_control_api_key, authed_client
):
    client_, requested_at = api
    for key in (internal_api_key, internal_control_api_key):
        headers = {"Authorization": f"Bearer {key}"}
        assert client_.get("/api/energy/refetch/request?kind=tapo", headers=headers).status_code == 401
        assert (
            client_.post("/api/energy/refetch/done", json=_done_body(requested_at), headers=headers).status_code
            == 401
        )
    assert _state(authed_client) == "waiting"


def test_collector_can_fetch_and_complete_with_token(api, collector_api_key, authed_client):
    client_, requested_at = api
    headers = {"Authorization": f"Bearer {collector_api_key}"}
    request = client_.get("/api/energy/refetch/request?kind=tapo", headers=headers).json()
    assert request["pending"] is True and request["requested_at"] == requested_at
    res = client_.post("/api/energy/refetch/done", json=_done_body(requested_at), headers=headers)
    assert res.status_code == 200
    assert _state(authed_client) == "done"


def test_stale_requested_at_does_not_complete_new_request(api, collector_api_key, authed_client, monkeypatch):
    import backend.main as main

    client_, old = api
    headers = {"Authorization": f"Bearer {collector_api_key}"}
    # 依頼を完了させてから新しい依頼を立て、古い requested_at で完了を報告する
    client_.post("/api/energy/refetch/done", json=_done_body(old), headers=headers)
    client_.post("/api/energy/refetch/done", json={"kind": "aircon", "requested_at": old}, headers=headers)
    monkeypatch.setattr(main, "get_now_jst", lambda: at(100))
    new = authed_client.post("/api/energy/refetch", json={"since": SINCE.isoformat()}).json()["requested_at"]
    assert new != old
    client_.post("/api/energy/refetch/done", json=_done_body(old), headers=headers)
    assert _state(authed_client) == "waiting"
