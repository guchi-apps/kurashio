import datetime

from backend import bills


def _bill(month, kind, amount, usage=None, unit=None, contract="c1", plan="なっトクでんき"):
    return {
        "billing_month": datetime.date.fromisoformat(month),
        "kind": kind,
        "contract_key": contract,
        "plan_name": plan,
        "amount_yen": amount,
        "usage_value": usage,
        "usage_unit": unit,
        "received_at": None,
        "updated_at": None,
    }


def _energy_rows(values):
    """(日付文字列, kWh) の並びから `daily_energy` 相当の行を作る。"""
    return [
        {
            "date": datetime.date.fromisoformat(date),
            "source": "aircon",
            "kwh": kwh,
            "cost_yen": None,
            "power_w": None,
            "updated_at": None,
        }
        for date, kwh in values
    ]


def test_parse_billing_month_normalizes_to_first_of_month():
    assert bills.parse_billing_month("2026-08") == datetime.date(2026, 8, 1)
    assert bills.parse_billing_month("2026-08-20") == datetime.date(2026, 8, 1)
    assert bills.parse_billing_month(datetime.date(2026, 8, 31)) == datetime.date(2026, 8, 1)


def test_summary_puts_latest_month_last_and_exposes_it():
    rows = [
        _bill("2026-06-01", "electricity", 9100, 312.0, "kWh"),
        _bill("2026-07-01", "electricity", 12900, 441.0, "kWh"),
        _bill("2026-08-01", "electricity", 15760, 540.0, "kWh"),
        _bill("2026-08-01", "gas", 2060, 8.0, "m3", plan="なっトクプラン"),
    ]

    summary = bills.build_summary(rows, [], 31.0)

    assert [entry["billing_month"] for entry in summary["months"]] == [
        "2026-06",
        "2026-07",
        "2026-08",
    ]
    assert summary["latest"]["billing_month"] == "2026-08"
    assert summary["latest"]["electricity"]["amount_yen"] == 15760
    assert summary["latest"]["gas"]["amount_yen"] == 2060
    # 電気とガスを足したものが合計
    assert summary["latest"]["total_yen"] == 17820
    assert summary["previous"]["billing_month"] == "2026-07"


def test_months_without_records_are_not_filled_with_zero():
    # 5月と7月しか届いていなければ、間の6月は棒を立てない
    rows = [
        _bill("2026-05-01", "electricity", 7600),
        _bill("2026-07-01", "electricity", 12900),
    ]

    summary = bills.build_summary(rows, [], 31.0)

    assert [entry["billing_month"] for entry in summary["months"]] == ["2026-05", "2026-07"]


def test_two_contracts_in_one_month_are_summed():
    # 引越しの月は旧契約と新契約の2通が届く。どちらも支払うので足す
    rows = [
        _bill("2026-04-01", "gas", 2177, 13.0, "m3", contract="old", plan="なっトクプラン"),
        _bill("2026-04-01", "gas", 2598, 12.0, "m3", contract="new", plan="なっトクプラン"),
    ]

    summary = bills.build_summary(rows, [], 31.0)
    gas = summary["latest"]["gas"]

    assert gas["amount_yen"] == 4775
    assert gas["usage_value"] == 25.0
    assert gas["contracts"] == 2
    # 契約種別が同じなら重ねて並べない
    assert gas["plan_name"] == "なっトクプラン"


def test_comparison_uses_electricity_only():
    # ガスの解約を「電気が安くなった」と読ませない
    rows = [
        _bill("2026-07-01", "electricity", 10000),
        _bill("2026-07-01", "gas", 5000, plan="なっトクプラン"),
        _bill("2026-08-01", "electricity", 11000),
    ]

    comparison = bills.build_summary(rows, [], 31.0)["comparison"]

    assert comparison["cheaper"] is False
    assert comparison["percent"] == 10
    assert comparison["base_billing_month"] == "2026-07"


def test_comparison_is_none_without_a_previous_month():
    rows = [_bill("2026-08-01", "electricity", 11000)]
    assert bills.build_summary(rows, [], 31.0)["comparison"] is None


def test_measured_counts_only_the_calendar_month_of_the_latest_bill():
    rows = [_bill("2026-08-01", "electricity", 15760, 540.0, "kWh")]
    energy_rows = _energy_rows(
        [
            ("2026-07-31", 100.0),  # 請求月の外なので数えない
            ("2026-08-01", 100.0),
            ("2026-08-31", 100.0),
            ("2026-09-01", 100.0),  # 同上
        ]
    )

    measured = bills.build_summary(rows, energy_rows, 31.0)["measured"]

    assert measured["kwh"] == 200.0
    assert measured["cost_yen"] == 6200
    assert measured["share_percent"] == 39
    assert measured["start"] == "2026-08-01"
    assert measured["end"] == "2026-08-31"


def test_measured_is_none_without_matching_energy_rows():
    rows = [_bill("2026-08-01", "electricity", 15760)]
    assert bills.build_summary(rows, [], 31.0)["measured"] is None


def test_summary_is_empty_when_no_bills_arrived():
    summary = bills.build_summary([], [], 31.0)

    assert summary["latest"] is None
    assert summary["months"] == []
    assert summary["comparison"] is None
    assert summary["measured"] is None


def test_summary_includes_water_in_the_month_total():
    rows = [
        _bill("2026-07-01", "electricity", 8000, 270, "kWh"),
        _bill("2026-08-01", "electricity", 9000, 300, "kWh"),
        _bill("2026-08-01", "water", 5000, 20, "m3", contract="manual", plan=None),
    ]
    summary = bills.build_summary(rows, [], 31.0)
    latest = summary["latest"]
    assert latest["water"]["amount_yen"] == 5000
    assert latest["total_yen"] == 14000
    assert summary["latest_water"]["billing_month"] == "2026-08"


def test_water_only_month_does_not_become_the_latest_month():
    # 水道は検針の月が電気とずれる。水道だけの月が最新になると電気の欄が空になる
    rows = [
        _bill("2026-08-01", "electricity", 9000, 300, "kWh"),
        _bill("2026-09-01", "water", 5000, 20, "m3", contract="manual", plan=None),
    ]
    summary = bills.build_summary(rows, [], 31.0)
    assert summary["latest"]["billing_month"] == "2026-08"
    assert summary["latest_water"]["billing_month"] == "2026-09"
    assert [m["billing_month"] for m in summary["months"]] == ["2026-08", "2026-09"]


def test_summary_without_water_has_no_latest_water():
    summary = bills.build_summary([_bill("2026-08-01", "gas", 2000, 9, "m3")], [], 31.0)
    assert summary["latest_water"] is None
    assert summary["latest"]["water"] is None


def test_collected_kinds_reject_water_but_manual_accepts_it():
    import pytest

    with pytest.raises(ValueError):
        bills.normalize_kind("water")
    assert bills.normalize_kind("water", bills.MANUAL_KINDS) == "water"


def test_validate_manual_water_rejects_bad_values():
    import pytest

    assert bills.validate_manual_water("2026-08", 5000, 20) == datetime.date(2026, 8, 1)
    with pytest.raises(ValueError):
        bills.validate_manual_water("2026-08", -1, None)
    with pytest.raises(ValueError):
        bills.validate_manual_water("2026-08", 5000, -3)
    with pytest.raises(ValueError):
        bills.validate_manual_water("2999-01", 5000, None)
    with pytest.raises(ValueError):
        bills.validate_manual_water("bad", 5000, None)
