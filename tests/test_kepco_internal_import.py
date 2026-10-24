"""AIDE向けの関西電力の時間別kWhの安全取込・照会（#823）。"""

import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

READ = {"Authorization": "Bearer read-token"}
CONTROL = {"Authorization": "Bearer control-token"}
BILLS = {"Authorization": "Bearer bills-token"}
WRITE = {"Authorization": "Bearer kepco-token"}
TODAY = datetime.date(2026, 10, 24)

SHARED = {
    "MYROOM_INTERNAL_BILLS_WRITE_API_KEY": "bills-token",
    "MYROOM_INTERNAL_KEPCO_WRITE_API_KEY": "kepco-token",
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    from backend import database, internal_auth, main

    engine = create_engine(f"sqlite:///{tmp_path / 'kepco.db'}")
    database.KepcoHourlyUsageRecord.__table__.create(engine)
    factory = sessionmaker(bind=engine)

    def get_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    monkeypatch.setattr(database, "DB_MOCK", False)
    monkeypatch.setenv("INTERNAL_API_KEY", "read-token")
    monkeypatch.setenv("INTERNAL_CONTROL_API_KEY", "control-token")
    monkeypatch.setattr(internal_auth, "get_shared_token", lambda name: SHARED.get(name))
    monkeypatch.setattr(main, "get_now_jst", lambda: datetime.datetime(2026, 10, 24, 12, 0))
    main.app.dependency_overrides[database.get_db] = get_db
    try:
        yield TestClient(main.app), factory
    finally:
        del main.app.dependency_overrides[database.get_db]
        engine.dispose()


def day_records(date, kwh=0.3, hours=range(24)):
    return [{"date": date, "hour": h, "kwh": kwh} for h in hours]


def body(records=None, start="2026-10-01", end="2026-10-02"):
    if records is None:
        records = day_records("2026-10-01") + day_records("2026-10-02")
    return {"period_start": start, "period_end": end, "records": records}


def post(client, payload=None, headers=WRITE):
    return client.post(
        "/api/internal/energy/kepco-hourly/import", json=payload or body(), headers=headers
    )


def stored(factory):
    from backend import database

    with factory() as db:
        return {
            (r.date.isoformat(), r.hour): r.kwh
            for r in db.query(database.KepcoHourlyUsageRecord).all()
        }


def test_tokens_are_separated(env, monkeypatch):
    client, _ = env
    assert post(client, headers={}).status_code == 401
    for headers in (READ, CONTROL, BILLS):
        assert post(client, headers=headers).status_code == 401
    assert post(client).status_code == 200

    # 照会は読み取り用だけ。取込用のトークンでは読めない
    url = "/api/internal/energy/kepco-hourly?start=2026-10-01&end=2026-10-01"
    assert client.get(url, headers=WRITE).status_code == 401
    assert client.get(url, headers=READ).status_code == 200


def test_unissued_token_is_503(env, monkeypatch):
    from backend import internal_auth

    client, _ = env
    monkeypatch.setattr(internal_auth, "get_shared_token", lambda name: None)
    response = post(client)
    assert response.status_code == 503


def test_created_then_unchanged(env):
    client, factory = env
    first = post(client).json()
    assert first["status"] == "created"
    assert first["created"] == 48
    assert first["missing"] == []
    assert len(stored(factory)) == 48

    again = post(client).json()
    assert again["status"] == "unchanged"
    assert again["created"] == 0
    assert again["unchanged"] == 48

    # CSVの丸め差の範囲は同値とみなす
    near = body(records=[{"date": "2026-10-01", "hour": 0, "kwh": 0.3000001}])
    assert post(client, near).json()["status"] == "unchanged"


def test_partial_overlap_adds_only_new_hours(env):
    client, factory = env
    post(client, body(records=day_records("2026-10-01"), end="2026-10-01"))
    result = post(client).json()
    assert result["status"] == "created"
    assert result["created"] == 24
    assert result["unchanged"] == 24
    assert len(stored(factory)) == 48


def test_conflict_writes_nothing(env):
    client, factory = env
    post(client, body(records=day_records("2026-10-01"), end="2026-10-01"))
    before = stored(factory)

    changed = day_records("2026-10-01") + day_records("2026-10-02")
    changed[5]["kwh"] = 0.9
    result = post(client, body(records=changed)).json()
    assert result["status"] == "conflict"
    assert result["created"] == 0
    assert result["conflict_count"] == 1
    assert result["conflicts"] == [
        {"date": "2026-10-01", "hour": 5, "existing_kwh": 0.3, "kwh": 0.9}
    ]
    # 2日目の新しい時間も足さない（部分取込をしない）
    assert stored(factory) == before


def test_missing_hours_are_not_filled_with_zero(env):
    client, factory = env
    # 公開前で 2026-10-02 の 20〜23時が空欄
    records = day_records("2026-10-01") + day_records("2026-10-02", hours=range(20))
    result = post(client, body(records=records)).json()
    assert result["status"] == "created"
    assert result["missing"] == [{"date": "2026-10-02", "hours": [20, 21, 22, 23]}]
    assert ("2026-10-02", 20) not in stored(factory)

    read = client.get(
        "/api/internal/energy/kepco-hourly?start=2026-10-01&end=2026-10-03", headers=READ
    ).json()
    assert read["count"] == 44
    assert read["expected_count"] == 72
    assert read["total_kwh"] == pytest.approx(44 * 0.3, abs=1e-3)
    assert read["days"][1] == {"date": "2026-10-02", "count": 20, "total_kwh": 6.0}
    assert read["missing"][0] == {"date": "2026-10-02", "hours": [20, 21, 22, 23]}
    assert read["missing"][1]["hours"] == list(range(24))
    assert read["records"][0]["date"] == "2026-10-01"
    assert read["records"][0]["hour"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        body(start="2026-10-02", end="2026-10-01"),
        body(start="2026-10-24", end="2026-10-25", records=day_records("2026-10-24")),
        body(start="2026-07-01", end="2026-10-01"),
        body(records=[{"date": "2026-10-03", "hour": 0, "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": 24, "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": -1, "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": "3", "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": 1.0, "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": 0, "kwh": -0.1}]),
        body(records=[{"date": "2026-10-01", "hour": 0, "kwh": 101}]),
        body(records=[{"date": "2026-10-01", "hour": 0, "kwh": "0.1"}]),
        body(records=[{"date": "10/01", "hour": 0, "kwh": 0.1}]),
        body(records=[{"date": "2026-10-01", "hour": 0, "kwh": 0.1}] * 2),
        body(records=[]),
        body(records=day_records("2026-10-01") * 3),
        {**body(), "customer_number": "x"},
        body(records=[{"date": "2026-10-01", "hour": 0, "kwh": 0.1, "label": "x"}]),
    ],
)
def test_invalid_input_is_422_and_writes_nothing(env, payload):
    client, factory = env
    assert post(client, payload).status_code == 422
    assert stored(factory) == {}


def test_nan_and_infinity_are_rejected(env):
    client, factory = env
    for value in ("NaN", "Infinity"):
        raw = (
            '{"period_start":"2026-10-01","period_end":"2026-10-01",'
            f'"records":[{{"date":"2026-10-01","hour":0,"kwh":{value}}}]}}'
        )
        response = client.post(
            "/api/internal/energy/kepco-hourly/import",
            content=raw,
            headers={**WRITE, "Content-Type": "application/json"},
        )
        assert response.status_code == 422
    assert stored(factory) == {}


def test_query_validates_range(env):
    client, _ = env
    base = "/api/internal/energy/kepco-hourly"
    assert client.get(f"{base}?start=2026-10-02&end=2026-10-01", headers=READ).status_code == 422
    assert client.get(f"{base}?start=2026-07-01&end=2026-10-01", headers=READ).status_code == 422
    assert client.get(f"{base}?start=2026-10-01&end=2026-10-25", headers=READ).status_code == 422
    assert client.get(f"{base}?start=bad&end=2026-10-01", headers=READ).status_code == 422


def test_manual_import_and_internal_import_share_rows(env):
    """手動CSV取込（#302）と同じ行を指すので、重ねても二重計上しない。"""
    from backend import kepco_import

    client, factory = env
    with factory() as db:
        kepco_import.upsert_kepco_hourly(
            db,
            [{"date": datetime.date(2026, 10, 1), "hour": h, "kwh": 0.3} for h in range(24)],
        )
    result = post(client).json()
    assert result["status"] == "created"
    assert result["unchanged"] == 24
    assert len(stored(factory)) == 48

    # 手動取込で訂正した値は、内部APIからは上書きされず conflict になる
    with factory() as db:
        kepco_import.upsert_kepco_hourly(
            db, [{"date": datetime.date(2026, 10, 1), "hour": 0, "kwh": 0.5}]
        )
    assert post(client).json()["status"] == "conflict"
    assert stored(factory)[("2026-10-01", 0)] == 0.5


def test_mock_mode_validates_but_does_not_store(env, monkeypatch):
    from backend import database

    client, _ = env
    monkeypatch.setattr(database, "DB_MOCK", True)
    assert post(client).json() == {"status": "mock_ok"}
    assert post(client, body(records=[])).status_code == 422


@pytest.mark.parametrize("other_kwh, expected", [(0.9, "conflict"), (0.3, "created")])
def test_concurrent_manual_import_between_check_and_insert(env, monkeypatch, other_kwh, expected):
    """突き合わせのあと commit までに手動取込が同じ行を書いても、500にせず読み直して判定する。"""
    from backend import database, kepco_internal

    client, factory = env
    original = kepco_internal._load
    calls = {"n": 0}

    def load_then_interleave(db, start, end):
        result = original(db, start, end)
        calls["n"] += 1
        if calls["n"] == 1:
            with factory() as other:
                other.add(
                    database.KepcoHourlyUsageRecord(
                        date=datetime.date(2026, 10, 1), hour=0, kwh=other_kwh
                    )
                )
                other.commit()
        return result

    monkeypatch.setattr(kepco_internal, "_load", load_then_interleave)
    response = post(client)
    assert response.status_code == 200
    assert response.json()["status"] == expected
    assert calls["n"] == 2
    rows = stored(factory)
    assert rows[("2026-10-01", 0)] == other_kwh
    assert len(rows) == (1 if expected == "conflict" else 48)
