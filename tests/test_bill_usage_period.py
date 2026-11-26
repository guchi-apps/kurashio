"""請求の使用期間（#884）。"""

import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend import bills, database, kepco_import

D = datetime.date
SEP = (D(2026, 8, 18), D(2026, 9, 14))


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    for model in (
        database.UtilityBillRecord,
        database.UtilityBillImport,
        database.KepcoHourlyUsageRecord,
    ):
        model.__table__.create(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _bill(db, month=D(2026, 9, 1), usage=368.0, contract="c1", kind="electricity"):
    bills.upsert_records(
        db,
        [
            {
                "billing_month": month,
                "kind": kind,
                "contract_key": contract,
                "amount_yen": 10000,
                "usage_value": usage,
                "usage_unit": "kWh",
            }
        ],
    )


def _hourly(db, period=SEP, total=367.7, stamp=datetime.datetime(2026, 10, 14, 1), skip=0):
    days = (period[1] - period[0]).days + 1
    records = [
        {"date": period[0] + datetime.timedelta(days=d), "hour": h, "kwh": total / (days * 24)}
        for d in range(days)
        for h in range(24)
    ]
    kepco_import.upsert_kepco_hourly(db, records[skip:], now=stamp)


def _period(db, contract="c1", month=D(2026, 9, 1)):
    db.expire_all()
    row = bills._find_bill(db, month, "electricity", contract)
    return (row.usage_start, row.usage_end)


def test_fills_when_rounded_total_matches(db):
    _bill(db)
    _hourly(db)
    assert bills.fill_usage_periods(db, [SEP]) == 1
    assert _period(db) == SEP


def test_fills_from_stored_batches(db):
    _hourly(db)
    _bill(db)
    assert bills.fill_usage_periods(db) == 1
    assert _period(db) == SEP


@pytest.mark.parametrize("total", [367.4, 368.6])
def test_does_not_fill_when_total_differs(db, total):
    _bill(db)
    _hourly(db, total=total)
    assert bills.fill_usage_periods(db, [SEP]) == 0
    assert _period(db) == (None, None)


def test_does_not_fill_when_an_hour_is_missing(db):
    _bill(db)
    _hourly(db, total=368.5, skip=1)
    assert bills.fill_usage_periods(db, [SEP]) == 0
    assert bills.fill_usage_periods(db) == 0


def test_does_not_fill_outside_billing_month_or_when_two_contracts_match(db):
    _hourly(db)
    _bill(db, month=D(2026, 10, 1))
    assert bills.fill_usage_periods(db, [SEP]) == 0
    _bill(db)
    _bill(db, contract="c2")
    assert bills.fill_usage_periods(db, [SEP]) == 0


def test_keeps_manual_period(db):
    _bill(db)
    _hourly(db)
    bills.set_usage_period(db, "2026-09", "electricity", "c1", D(2026, 8, 1), D(2026, 8, 31))
    assert bills.fill_usage_periods(db, [SEP]) == 0
    assert _period(db) == (D(2026, 8, 1), D(2026, 8, 31))


def test_daily_collection_keeps_the_period(db):
    _bill(db)
    bills.set_usage_period(db, "2026-09", "electricity", "c1", *SEP)
    _bill(db, usage=370.0)
    assert _period(db) == SEP


def test_set_period_targets_one_row_and_can_clear(db):
    _bill(db)
    _bill(db, contract="c2")
    assert bills.set_usage_period(db, "2026-09", "electricity", "c2", *SEP)
    assert _period(db) == (None, None)
    assert bills.set_usage_period(db, "2026-09", "electricity", "c2", None, None)
    assert _period(db, "c2") == (None, None)
    assert not bills.set_usage_period(db, "2026-09", "gas", "c1", *SEP)
    with pytest.raises(ValueError):
        bills.set_usage_period(db, "2026-09", "electricity", "c1", SEP[0], None)


def _row(month, usage_start=None, usage_end=None):
    # usage_start/end の無い行（列を足す前の形）も受ける
    row = {
        "billing_month": month,
        "kind": "electricity",
        "contract_key": "c1",
        "plan_name": None,
        "amount_yen": 10000,
        "usage_value": 368.0,
        "usage_unit": "kWh",
    }
    if usage_start:
        row.update(usage_start=usage_start, usage_end=usage_end)
    return row


def test_summary_uses_usage_period_for_measured():
    energy_rows = [
        {"date": D(2026, 8, 20), "kwh": 5.0, "cost_yen": 100.0},
        {"date": D(2026, 9, 20), "kwh": 7.0, "cost_yen": 200.0},
    ]
    month = D(2026, 9, 1)
    plain = bills.build_summary([_row(month)], energy_rows, 31.0)
    assert plain["measured"]["kwh"] == 7.0
    assert plain["measured"]["by_usage_period"] is False
    assert plain["latest"]["electricity"]["bills"][0]["usage_start"] is None

    with_period = bills.build_summary([_row(month, *SEP)], energy_rows, 31.0)
    assert with_period["measured"]["kwh"] == 5.0
    assert with_period["measured"]["start"] == "2026-08-18"
    assert with_period["latest"]["electricity"]["bills"][0]["usage_end"] == "2026-09-14"


def _hourly_payload():
    return {
        "period_start": SEP[0].isoformat(),
        "period_end": SEP[1].isoformat(),
        "records": [
            {"date": (SEP[0] + datetime.timedelta(days=d)).isoformat(), "hour": h, "kwh": 368 / 672}
            for d in range(28)
            for h in range(24)
        ],
    }


def test_internal_import_fills_period_and_keeps_response(db, monkeypatch):
    from backend import main

    monkeypatch.setattr(database, "DB_MOCK", False)
    monkeypatch.setattr(main, "get_now_jst", lambda: datetime.datetime(2026, 9, 20))
    _bill(db)
    result = main.import_internal_kepco_hourly(
        main.InternalKepcoHourlyImport(**_hourly_payload()), db=db, _=None
    )
    assert result["status"] == "created"
    assert _period(db) == SEP


def test_manual_csv_save_and_collection_endpoints_fill(db, monkeypatch):
    from backend import main

    monkeypatch.setattr(database, "DB_MOCK", False)
    _bill(db)
    records = [
        {"date": SEP[0] + datetime.timedelta(days=d), "hour": h, "kwh": 368 / 672}
        for d in range(28)
        for h in range(24)
    ]
    assert main._save_kepco_hourly(db, records, SEP)["status"] == "ok"
    assert _period(db) == SEP

    bills.set_usage_period(db, "2026-09", "electricity", "c1", None, None)
    payload = main.UtilityBillPayload(
        records=[
            {
                "billing_month": "2026-09",
                "kind": "electricity",
                "contract_key": "c1",
                "amount_yen": 10000,
                "usage_value": 368,
                "usage_unit": "kWh",
            }
        ]
    )
    assert main.create_utility_bills(payload, db=db)["status"] == "ok"
    assert _period(db) == SEP


def test_parse_period_reads_csv_header():
    raw = "データ抽出対象期間：2026年7月15日 ～ 2026年8月17日\r\n".encode("utf-8-sig")
    assert kepco_import.parse_period(raw) == (D(2026, 7, 15), D(2026, 8, 17))


PERIOD_BODY = {
    "billing_month": "2026-09",
    "kind": "gas",
    "contract_key": "c1",
    "usage_start": "2026-08-18",
    "usage_end": "2026-09-14",
}


def test_period_endpoint_requires_auth(client):
    assert client.put("/api/bills/period", json=PERIOD_BODY).status_code == 401


def test_period_endpoint_validates(authed_client):
    assert authed_client.put("/api/bills/period", json=PERIOD_BODY).json() == {"status": "mock_ok"}
    reversed_body = {**PERIOD_BODY, "usage_start": "2026-09-15"}
    assert authed_client.put("/api/bills/period", json=reversed_body).status_code == 422
