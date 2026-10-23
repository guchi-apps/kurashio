"""AIDE向けの月次請求の照会・安全取込（#814）。"""

import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

READ = {"Authorization": "Bearer read-token"}
CONTROL = {"Authorization": "Bearer control-token"}
WRITE = {"Authorization": "Bearer write-token"}
KEY = "0123456789ab"


@pytest.fixture
def env(tmp_path, monkeypatch):
    from backend import database, internal_auth, main

    engine = create_engine(f"sqlite:///{tmp_path / 'bills.db'}")
    database.UtilityBillRecord.__table__.create(engine)
    database.UtilityBillImport.__table__.create(engine)
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
    monkeypatch.setattr(
        internal_auth,
        "get_shared_token",
        lambda name: "write-token" if name == "MYROOM_INTERNAL_BILLS_WRITE_API_KEY" else None,
    )
    main.app.dependency_overrides[database.get_db] = get_db
    try:
        yield TestClient(main.app), factory
    finally:
        del main.app.dependency_overrides[database.get_db]
        engine.dispose()


def body(**over):
    data = {
        "billing_month": "2026-08",
        "kind": "gas",
        "contract_key": KEY,
        "amount_yen": 2060,
        "usage_value": 8.0,
        "usage_unit": "m³",
        "source_message_id": "msg-1",
        "source_label": "KEPCO",
        "confidence": 0.9,
    }
    data.update(over)
    return data


def post(client, **over):
    return client.post("/api/internal/bills/import", json=body(**over), headers=WRITE)


def rows(factory):
    from backend import database

    with factory() as db:
        return [
            (r.billing_month, r.kind, r.contract_key, r.amount_yen, r.updated_at)
            for r in db.query(database.UtilityBillRecord).all()
        ]


def test_created_duplicate_conflict(env):
    client, factory = env
    first = post(client)
    assert first.status_code == 200
    assert first.json()["status"] == "created"
    assert first.json()["record"]["usage_unit"] == "m3"
    assert first.json()["source"]["import_id"]
    before = rows(factory)

    dup = post(client)
    assert dup.json()["status"] == "duplicate"
    assert rows(factory) == before  # 行数・updated_at が変わらない

    diff = post(client, amount_yen=9999, source_message_id="msg-2")
    assert diff.json()["status"] == "conflict"
    assert diff.json()["fields"] == ["amount_yen"]
    assert diff.json()["record"]["amount_yen"] == 2060
    assert rows(factory) == before


def test_other_contract_and_same_message_for_two_kinds(env):
    client, factory = env
    assert post(client).json()["status"] == "created"
    assert post(client, contract_key="default", source_message_id="msg-9").json()["status"] == "created"
    electric = post(client, kind="electricity", usage_unit="kwh", usage_value=300, amount_yen=9000)
    assert electric.json()["status"] == "created"  # 同じ source_message_id でも別種別
    assert len(rows(factory)) == 3


def test_source_bound_to_other_month_is_conflict(env):
    client, factory = env
    post(client)
    moved = post(client, billing_month="2026-09")
    assert moved.json()["status"] == "conflict"
    assert moved.json()["fields"] == ["source"]
    assert len(rows(factory)) == 1


@pytest.mark.parametrize(
    "over",
    [
        {"kind": "water"},
        {"contract_key": "manual"},
        {"contract_key": "ABCDEF123456"},
        {"usage_unit": "kWh"},  # ガスに kWh
        {"amount_yen": -1},
        {"usage_value": -1.0},
        {"billing_month": "2026-13"},
        {"source_message_id": ""},
        {"confidence": 1.5},
        {"unknown": 1},
    ],
)
def test_invalid_inputs_are_422(env, over):
    client, factory = env
    assert post(client, **over).status_code == 422
    assert rows(factory) == []


def test_missing_amount_is_422(env):
    client, _ = env
    data = body()
    del data["amount_yen"]
    assert client.post("/api/internal/bills/import", json=data, headers=WRITE).status_code == 422


def test_primary_key_race_does_not_overwrite(env, monkeypatch):
    from backend import bills

    client, factory = env
    post(client)
    before = rows(factory)

    real = bills._find_bill
    calls = {"n": 0}

    def blind_first(db, month, kind, key):
        calls["n"] += 1
        return None if calls["n"] == 1 else real(db, month, kind, key)

    monkeypatch.setattr(bills, "_find_bill", blind_first)
    raced = post(client, amount_yen=5000, source_message_id="msg-race")
    assert raced.json()["status"] == "conflict"  # 先に書かれた行を再読込して倒す
    assert raced.json()["record"]["amount_yen"] == 2060
    assert rows(factory) == before


def test_tokens(env):
    client, _ = env
    for headers in (READ, CONTROL, {}):
        assert client.post("/api/internal/bills/import", json=body(), headers=headers).status_code == 401
    # 書込トークンが読み取りの判定を通る必要は無い
    assert client.get("/api/internal/bills/contracts?kind=gas", headers=WRITE).status_code == 401


def test_write_token_unconfigured_is_503(env, monkeypatch):
    from backend import internal_auth

    client, _ = env
    monkeypatch.setattr(internal_auth, "get_shared_token", lambda name: None)
    assert client.post("/api/internal/bills/import", json=body(), headers=WRITE).status_code == 503


def test_record_lookup_by_month_and_by_source(env):
    client, _ = env
    q = f"kind=gas&contract_key={KEY}"
    assert client.get(f"/api/internal/bills/record?billing_month=2026-08&{q}", headers=READ).status_code == 404
    post(client)
    by_month = client.get(f"/api/internal/bills/record?billing_month=2026-08&{q}", headers=READ)
    by_source = client.get(f"/api/internal/bills/record?source_message_id=msg-1&{q}", headers=READ)
    assert by_month.status_code == by_source.status_code == 200
    assert by_month.json() == by_source.json()
    assert by_month.json()["record"]["revision"] == by_month.json()["record"]["updated_at"]
    assert by_month.json()["source"]["source_message_id"] == "msg-1"
    missing = client.get(f"/api/internal/bills/record?source_message_id=nope&{q}", headers=READ)
    assert missing.status_code == 404 and missing.json() == {"detail": "not_found"}
    assert client.get(f"/api/internal/bills/record?{q}", headers=READ).status_code == 422


def test_contracts(env):
    client, _ = env
    post(client)
    post(client, billing_month="2026-07", source_message_id="m0", amount_yen=1000)
    got = client.get("/api/internal/bills/contracts?kind=gas", headers=READ).json()
    assert got == {
        "contracts": [{"contract_key": KEY, "plan_name": None, "latest_billing_month": "2026-08"}]
    }
    assert client.get("/api/internal/bills/contracts?kind=water", headers=READ).status_code == 422


def test_legacy_upsert_still_overwrites(env):
    from backend import bills

    _, factory = env
    with factory() as db:
        for amount in (100, 200):
            bills.upsert_records(
                db,
                [{"billing_month": "2026-08", "kind": "gas", "contract_key": KEY, "amount_yen": amount}],
            )
    assert [r[3] for r in rows(factory)] == [200]


def test_legacy_upsert_does_not_overwrite_imported_row(env):
    """安全取込が出典を記録した行は、日次の収集（旧upsert）が送り直しても変わらない（#817）。"""
    from backend import bills

    client, factory = env
    post(client)
    before = rows(factory)
    with factory() as db:
        written = bills.upsert_records(
            db,
            [{"billing_month": "2026-08", "kind": "gas", "contract_key": KEY, "amount_yen": 999999}],
        )
    assert written == 0
    assert rows(factory) == before


def test_legacy_upsert_still_writes_other_rows_next_to_imported(env):
    from backend import bills

    client, factory = env
    post(client)
    with factory() as db:
        written = bills.upsert_records(
            db,
            [
                {"billing_month": "2026-08", "kind": "gas", "contract_key": KEY, "amount_yen": 1},
                {"billing_month": "2026-07", "kind": "gas", "contract_key": KEY, "amount_yen": 777},
            ],
        )
    assert written == 1
