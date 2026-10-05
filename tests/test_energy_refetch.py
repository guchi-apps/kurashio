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
