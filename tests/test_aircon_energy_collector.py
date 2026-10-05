"""`collectors/aircon_energy_to_myroom.py` の変換まわり。

AirCloud Home へは実際に繋がないので、応答をモックして「何を送るか」だけを見る。
"""

import datetime
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "collectors"))

import aircon_energy_to_myroom as collector  # noqa: E402
from aircloudhome_client import AirCloudHomeError  # noqa: E402


def _summary(*racs, currency=None):
    summary = {"individualRacsData": list(racs)}
    if currency is not None:
        summary["allRacsData"] = {"currency": currency}
    return summary


def _rac(name, kwh, vendor_id="VT-1", cost=None):
    rac = {"racName": name, "vendorThingId": vendor_id, "energyConsumed": kwh}
    if cost is not None:
        rac["cost"] = cost
    return rac


class _FakeClient:
    """日付ごとの応答を辞書で持つだけのスタブ。"""

    def __init__(self, by_date):
        self.by_date = by_date
        self.calls = []

    def get_energy_summary(self, family_id, date_from, date_to):
        self.calls.append((family_id, date_from, date_to))
        return self.by_date[date_from]


def test_target_dates_returns_oldest_first():
    today = datetime.date(2026, 8, 22)
    assert collector.target_dates(today, 1) == [today]
    assert collector.target_dates(today, 3) == [
        datetime.date(2026, 8, 20),
        datetime.date(2026, 8, 21),
        today,
    ]
    with pytest.raises(ValueError):
        collector.target_dates(today, 0)


def test_sum_energy_adds_all_units_by_default():
    summary = _summary(_rac("リビング", 1.5, "A"), _rac("寝室", 2.25, "B"))
    assert collector.sum_energy(summary) == 3.75


def test_sum_energy_filters_by_name_or_vendor_id():
    summary = _summary(_rac("リビング", 1.5, "A"), _rac("寝室", 2.25, "B"))
    assert collector.sum_energy(summary, "寝室") == 2.25
    assert collector.sum_energy(summary, "a") == 1.5
    # 一致しない指定は合計対象が無いので None（0.0 にすると使っていない日と区別できない）
    assert collector.sum_energy(summary, "書斎") is None


def test_sum_energy_ignores_missing_and_broken_values():
    summary = _summary(_rac("リビング", None), _rac("寝室", "こわれた値", "B"))
    assert collector.sum_energy(summary) is None


def test_sum_energy_rejects_unexpected_response_shape():
    # api-kuma で形が違った場合に黙って0を送らず、--dump-raw へ誘導する
    with pytest.raises(AirCloudHomeError, match="dump-raw"):
        collector.sum_energy({"result": []})


def test_sum_cost_adds_all_units_by_default():
    # 取得元が金額まで返すので、単価を掛けた目安ではなくこの実額を送る
    summary = _summary(
        _rac("リビング", 1.5, "A", cost=45.0),
        _rac("寝室", 2.25, "B", cost=67.5),
        currency="JPY",
    )
    assert collector.sum_cost(summary) == 112.5
    assert collector.sum_cost(summary, "寝室") == 67.5


def test_sum_cost_returns_none_when_cost_is_absent():
    # 金額を返さない応答では None にして、MyRoom側の単価計算に任せる
    summary = _summary(_rac("リビング", 1.5), currency="JPY")
    assert collector.sum_cost(summary) is None


def test_sum_cost_rejects_non_jpy_currency():
    # MyRoomは円で持つので、円以外は送らない（そのまま入れると桁が狂う）
    summary = _summary(_rac("リビング", 1.5, cost=45.0), currency="USD")
    assert collector.sum_cost(summary) is None


def test_collect_records_queries_each_date_and_sums_families():
    d20 = datetime.date(2026, 8, 20)
    d21 = datetime.date(2026, 8, 21)
    client = _FakeClient({d20: _summary(_rac("リビング", 1.0)), d21: _summary(_rac("リビング", 2.5))})

    records = collector.collect_records(client, [7], [d20, d21], None, sleep=0)

    assert records == [
        {"date": "2026-08-20", "kwh": 1.0},
        {"date": "2026-08-21", "kwh": 2.5},
    ]
    # 期間の合計しか返らないため、日付ごとに from=to で引いている
    assert client.calls == [(7, d20, d20), (7, d21, d21)]


def test_collect_records_skips_dates_without_value():
    d20 = datetime.date(2026, 8, 20)
    d21 = datetime.date(2026, 8, 21)
    client = _FakeClient({d20: _summary(_rac("リビング", None)), d21: _summary(_rac("リビング", 2.0))})

    records = collector.collect_records(client, [7], [d20, d21], None, sleep=0)

    assert records == [{"date": "2026-08-21", "kwh": 2.0}]


def test_collect_records_carries_cost_yen_when_returned():
    d20 = datetime.date(2026, 8, 20)
    d21 = datetime.date(2026, 8, 21)
    client = _FakeClient(
        {
            d20: _summary(_rac("リビング", 1.0, cost=30.5), currency="JPY"),
            # 金額が返らない日は cost_yen を載せず、MyRoom側の単価計算に任せる
            d21: _summary(_rac("リビング", 2.5), currency="JPY"),
        }
    )

    records = collector.collect_records(client, [7], [d20, d21], None, sleep=0)

    assert records == [
        {"date": "2026-08-20", "kwh": 1.0, "cost_yen": 30.5},
        {"date": "2026-08-21", "kwh": 2.5},
    ]


def test_build_payload_matches_api_energy_contract():
    records = [{"date": "2026-08-22", "kwh": 2.4}]
    assert collector.build_payload(records) == {
        "source": "aircon",
        "records": [{"date": "2026-08-22", "kwh": 2.4}],
    }


def test_load_env_file_reads_quotes_export_and_comments(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "\n".join(
            [
                "# コメント",
                "",
                "AIRCON_EMAIL=a@example.com",
                'AIRCON_PASSWORD="pa ss#word"',
                "export ENERGY_DAYS=3",
                "壊れた行",
            ]
        ),
        encoding="utf-8",
    )

    assert collector.load_env_file(str(env)) == {
        "AIRCON_EMAIL": "a@example.com",
        "AIRCON_PASSWORD": "pa ss#word",
        "ENERGY_DAYS": "3",
    }


def test_load_env_file_returns_empty_when_missing(tmp_path):
    assert collector.load_env_file(str(tmp_path / "none.env")) == {}


class TestRefetch:
    """画面からの「指定日以降の再取得」依頼（#711）。"""

    def test_days_count_from_since_including_today(self):
        today = datetime.date(2026, 10, 5)
        assert collector.refetch_days(today, "2026-10-01") == 5

    def test_days_are_capped_to_protect_the_rate_limit(self):
        assert (
            collector.refetch_days(datetime.date(2026, 10, 5), "2026-01-01")
            == collector.REFETCH_MAX_DAYS
        )


@pytest.mark.parametrize("values, expected_done", [
    ([1.0, 2.0], True),
    ([0.0, 0.0], True),
    ([None, 2.0], False),
    ([None, None], False),
])
def test_main_refetch_completes_only_after_all_dates_are_sent(monkeypatch, values, expected_done):
    today = datetime.date(2026, 10, 5)
    dates = collector.target_dates(today, 2)
    client = _FakeClient(dict(zip(dates, [_summary(_rac("リビング", v)) for v in values])))
    client.get_family_ids = lambda: [7]

    class Context:
        def __enter__(self):
            return client

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(collector, "AirCloudHomeClient", lambda *a, **kw: Context())
    monkeypatch.setattr(collector, "apply_env_files", lambda paths: None)
    monkeypatch.setattr(collector, "today_jst", lambda: today)
    monkeypatch.setattr(collector.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(collector, "fetch_refetch_request", lambda *a: {
        "since": dates[0].isoformat(), "requested_at": "request-1", "pending": True,
    })
    posted = []
    completed = []
    monkeypatch.setattr(collector, "post_to_myroom", lambda **kw: posted.append(kw["payload"]) or {})
    monkeypatch.setattr(collector, "report_refetch_done", lambda *a: completed.append(a))

    result = collector.main(["--email", "test@example.com", "--password", "test", "--days", "2"])
    assert result == (0 if any(v is not None for v in values) else 1)
    assert bool(completed) is expected_done
    if completed:
        assert posted
        assert completed[0][1] == "request-1"
    if posted:
        assert len(posted[0]["records"]) == sum(v is not None for v in values)
