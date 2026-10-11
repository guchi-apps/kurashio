"""消費電力の取得元の同一性（#768）。Tapoの改名後も履歴を1台として扱う。"""

import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import database, energy, energy_links

D = datetime.date
NOW = datetime.datetime(2026, 10, 11, 12, 0)


class _Clock:
    """受信のたびに1分進む `now`（同じ時刻・同じ取得元の再送は主キー違反になるため）。"""

    def __init__(self):
        self.value = NOW

    def __call__(self):
        self.value += datetime.timedelta(minutes=1)
        return self.value


def _record(day, source, kwh, device_id=None, power_w=None):
    return {
        "date": day,
        "source": source,
        "kwh": kwh,
        "cost_yen": None,
        "power_w": power_w,
        "device_id": device_id,
    }


@pytest.fixture
def db(tmp_path, monkeypatch):
    """本番のDB経路（`app_settings`・`daily_energy`・`energy_readings`）をSQLiteで通す。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'energy.db'}")
    for table in (
        database.AppSetting,
        database.DailyEnergyRecord,
        database.EnergyReadingRecord,
        database.KepcoHourlyUsageRecord,
    ):
        table.__table__.create(engine)
    monkeypatch.setattr(database, "DB_MOCK", False)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _by_source(rows):
    return {(row["date"], row["source"]): row["kwh"] for row in rows}


# --- 対応表の検証 -------------------------------------------------------------


def test_device_id_is_normalized_from_mac():
    assert energy_links.normalize_device_id("aa-bb-cc-11-22-33") == "AABBCC112233"
    assert energy_links.normalize_device_id("") is None
    assert energy_links.normalize_device_id(None) is None


def test_resolve_stops_on_a_cycle():
    document = energy_links.normalize_document(
        {"links": {"tapo:A": "tapo:B", "tapo:B": "tapo:A"}}
    )
    # 循環していても無限ループにならない
    assert energy_links.resolve(document, "tapo:A") in {"tapo:A", "tapo:B"}


@pytest.mark.parametrize(
    "links, alias, canonical",
    [
        ({}, "tapo:A", "tapo:A"),  # 自己参照
        ({"tapo:B": "tapo:C"}, "tapo:A", "tapo:B"),  # 向き先が別名（連鎖）
        ({"tapo:B": "tapo:A"}, "tapo:A", "tapo:C"),  # 別名の向き先になっているものを別名にする
    ],
)
def test_link_rejects_chains_and_self_reference(db, links, alias, canonical):
    energy_links._update(db, lambda doc: doc["links"].update(links))
    with pytest.raises(energy_links.LinkError):
        energy_links.link(db, alias, canonical)


def test_link_rejects_alias_that_owns_a_device_id(db):
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 1.0, "AA")], now=NOW)
    with pytest.raises(energy_links.LinkError):
        energy_links.link(db, "tapo:PC", "tapo:サブPC")


# --- 改名の自動引き継ぎ（機器IDが根拠） ---------------------------------------


def test_rename_is_linked_by_device_id(db):
    energy.upsert_records(db, [_record(D(2026, 10, 10), "tapo:サブPC", 1.5, "AA11")], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 0.4, "AA11")], now=NOW)

    document = energy_links.get_document(db)
    assert document["devices"] == {"AA11": "tapo:サブPC"}
    assert document["links"] == {"tapo:PC": "tapo:サブPC"}

    rows = energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))
    # 1台として、過去から現在まで連続して並ぶ
    assert _by_source(rows) == {
        (D(2026, 10, 10), "tapo:サブPC"): 1.5,
        (D(2026, 10, 11), "tapo:サブPC"): 0.4,
    }


def test_same_name_on_a_different_device_is_not_mixed(db):
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 1.0, "AA11")], now=NOW)
    # 別の機器IDが同じ名前を名乗っても、結ばない（履歴は同じ取得元の名前を共有するが、
    # 自動では別機器の対応表を作らない）
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:冷蔵庫", 2.0, "BB22")], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 9.0, "BB22")], now=NOW + datetime.timedelta(minutes=1))

    document = energy_links.get_document(db)
    assert document["devices"] == {"AA11": "tapo:PC", "BB22": "tapo:冷蔵庫"}
    assert document["links"] == {}


def test_receiving_again_is_idempotent(db):
    clock = _Clock()
    for _ in range(3):
        energy.upsert_records(db, [_record(D(2026, 10, 10), "tapo:サブPC", 1.5, "AA11")], now=clock())
        energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 0.4, "AA11")], now=clock())
    document = energy_links.get_document(db)
    assert document["links"] == {"tapo:PC": "tapo:サブPC"}
    rows = energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))
    assert len(rows) == 2


def test_legacy_collector_without_device_id_still_works(db):
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 1.0)], now=NOW)
    assert energy_links.get_document(db) == {"devices": {}, "links": {}}
    assert len(energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))) == 1


# --- 二重計上しない -----------------------------------------------------------


def test_same_day_under_old_and_new_name_is_not_added_twice(db):
    # 改名当日: 旧名で朝の累計、新名で夕方の累計。同じ機器の累計なので足さない
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:サブPC", 0.5, "AA11")], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 1.2, "AA11")], now=NOW)
    summary = energy.build_breakdown(
        energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11)),
        D(2026, 10, 11),
        30.0,
    )
    assert summary["this_month"]["kwh"] == 1.2
    assert summary["daily"][-1]["by_source"] == {"tapo:サブPC": 1.2}


def test_refetch_of_past_days_does_not_double_count(db):
    energy.upsert_records(db, [_record(D(2026, 10, 9), "tapo:サブPC", 1.0, "AA11")], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 0.4, "AA11")], now=NOW)
    # 改名後の再取得で、過去の日が新名でも届く
    energy.upsert_records(db, [_record(D(2026, 10, 9), "tapo:PC", 1.0, "AA11")], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 9), "tapo:PC", 1.0, "AA11")], now=NOW)
    rows = energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))
    assert _by_source(rows)[(D(2026, 10, 9), "tapo:サブPC")] == 1.0
    assert sum(row["kwh"] for row in rows) == 1.4


def test_newer_row_fills_missing_values_from_older_row():
    document = energy_links.normalize_document({"links": {"tapo:B": "tapo:A"}})
    older = datetime.datetime(2026, 10, 11, 1)
    newer = datetime.datetime(2026, 10, 11, 2)
    rows = [
        {"date": D(2026, 10, 11), "source": "tapo:A", "kwh": 1.0, "cost_yen": None, "power_w": 20.0, "updated_at": older},
        {"date": D(2026, 10, 11), "source": "tapo:B", "kwh": 1.5, "cost_yen": None, "power_w": None, "updated_at": newer},
    ]
    merged = energy_links.merge_daily_rows(rows, document)
    assert len(merged) == 1
    assert merged[0]["kwh"] == 1.5 and merged[0]["power_w"] == 20.0
    assert merged[0]["origin"] == "tapo:B"


def test_hourly_readings_continue_across_a_rename(db):
    t = lambda h, m=0: datetime.datetime(2026, 10, 11, h, m)  # noqa: E731
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:サブPC", 0.5, "AA11")], now=t(9, 30))
    energy.upsert_records(db, [_record(D(2026, 10, 11), "tapo:PC", 0.9, "AA11")], now=t(10, 30))
    readings = energy._fetch_readings(db, D(2026, 10, 11))
    assert {row["source"] for row in readings} == {"tapo:サブPC"}
    hourly = energy.build_hourly(readings, D(2026, 10, 11), 30.0)
    assert hourly["sources"] == ["tapo:サブPC"]
    assert hourly["hours"][10]["by_source"] == {"tapo:サブPC": 0.4}


# --- 旧データの関連付け（利用者が確認） ---------------------------------------


def test_legacy_split_is_not_merged_automatically_but_offered_as_candidate(db):
    energy.upsert_records(db, [_record(D(2026, 10, 9), "tapo:サブPC", 1.0)], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 10), "tapo:PC", 2.0)], now=NOW)

    assert energy_links.get_document(db)["links"] == {}
    overview = energy.get_links_overview(db, D(2026, 10, 11))
    assert [(c["source"], c["canonical"]) for c in overview["candidates"]] == [
        ("tapo:サブPC", "tapo:PC")
    ]
    assert overview["candidates"][0]["old_kwh_total"] == 1.0


def test_manual_link_joins_history_and_unlink_restores_it(db):
    energy.upsert_records(db, [_record(D(2026, 10, 9), "tapo:サブPC", 1.0)], now=NOW)
    energy.upsert_records(db, [_record(D(2026, 10, 10), "tapo:PC", 2.0)], now=NOW)

    energy.link_sources(db, "tapo:サブPC", "tapo:PC")
    rows = energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))
    assert {row["source"] for row in rows} == {"tapo:PC"}
    summary = energy.get_summary(db, D(2026, 10, 11), source="tapo:サブPC")
    assert summary["source"] == "tapo:PC"

    energy_links.unlink(db, "tapo:サブPC")
    rows = energy.fetch_all_rows(db, D(2026, 10, 1), D(2026, 10, 11))
    assert {row["source"] for row in rows} == {"tapo:PC", "tapo:サブPC"}  # 生データは無加工


def test_link_requires_known_tapo_sources(db):
    energy.upsert_records(db, [_record(D(2026, 10, 10), "tapo:PC", 2.0)], now=NOW)
    with pytest.raises(energy_links.LinkError):
        energy.link_sources(db, "tapo:存在しない", "tapo:PC")
    with pytest.raises(energy_links.LinkError):
        energy.link_sources(db, "aircon", "tapo:PC")


def test_alias_names_follow_the_linked_source_without_rewriting():
    document = energy_links.normalize_document({"links": {"tapo:PC": "tapo:サブPC"}})
    names = energy._names_for_canonical({"tapo:サブPC": "作業用PC"}, document)
    assert names["tapo:サブPC"] == "作業用PC"
    # 旧名にだけ別名があるときは、正規側へ引き継ぐ
    names = energy._names_for_canonical({"tapo:PC": "作業用PC"}, document)
    assert names["tapo:サブPC"] == "作業用PC"
    # 正規側に別名があれば、そちらを優先する
    names = energy._names_for_canonical({"tapo:PC": "古い名", "tapo:サブPC": "新しい名"}, document)
    assert names["tapo:サブPC"] == "新しい名"


def test_breakdown_label_follows_the_latest_name():
    document = energy_links.normalize_document({"links": {"tapo:PC": "tapo:サブPC"}})
    rows = energy_links.merge_daily_rows(
        [
            {"date": D(2026, 10, 10), "source": "tapo:サブPC", "kwh": 1.0, "cost_yen": None, "power_w": None, "updated_at": None},
            {"date": D(2026, 10, 11), "source": "tapo:PC", "kwh": 0.4, "cost_yen": None, "power_w": None, "updated_at": None},
        ],
        document,
    )
    breakdown = energy.build_breakdown(rows, D(2026, 10, 11), 30.0)
    assert breakdown["sources"][0]["source"] == "tapo:サブPC"
    assert breakdown["sources"][0]["default_label"] == "PC"
