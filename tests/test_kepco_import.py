"""KEPCO「みるでん」の時間ごとCSVの取り込み（`backend/kepco_import.py`、#302）。

**サンプルは実際にダウンロードしたCSVの書式をそのまま使う。** 個人情報にあたる
お客さま番号・ニックネーム・住所はダミー値に差し替えてある。
"""

import datetime

import pytest

from backend import database, kepco_import


HOURLY_CSV = (
    "お客さま番号：00-00-0000-000000,契約種別：なっトクでんき,ニックネーム：てすと さん\r\n"
    "ご使用場所住所：どこか市　どこか町　１－１\r\n"
    "データ抽出対象期間：2026年7月15日 ～ 2026年8月17日\r\n"
    "＊端数処理前で作成しています。\r\n"
    ",１時間ごとの電力量内訳,,,,,,,,,,,,,,,,,,,,,,,\r\n"
    ",0-1時,1-2時,2-3時,3-4時,4-5時,5-6時,6-7時,7-8時,8-9時,9-10時,10-11時,11-12時,"
    "12-13時,13-14時,14-15時,15-16時,16-17時,17-18時,18-19時,19-20時,20-21時,21-22時,"
    "22-23時,23-24時\r\n"
    "抽出期間合計,26.30,27.10,25.80,24.50,24.00,21.80,19.40,16.90,18.00,20.90,25.70,26.40,"
    "24.70,21.30,20.30,21.40,21.10,23.90,21.10,21.00,21.60,19.60,23.20,23.70\r\n"
    " 08/17,0.30,0.40,0.40,0.50,0.40,0.50,0.40,0.40,0.40,0.50,0.50,0.50,0.50,0.20,0.30,0.40,"
    "0.40,0.70,0.40,0.30,0.40,0.30,0.40,0.30\r\n"
    " 07/15,0.50,0.50,0.50,0.50,0.40,0.50,0.50,0.20,1.10,1.10,1.00,0.80,0.20,0.20,0.20,0.30,"
    "0.20,0.20,0.20,0.20,0.30,0.20,0.50,1.00\r\n"
    "\r\n"
)

YEAR_CROSSING_CSV = (
    "お客さま番号：00-00-0000-000000,契約種別：なっトクでんき,ニックネーム：てすと さん\r\n"
    "ご使用場所住所：どこか市　どこか町　１－１\r\n"
    "データ抽出対象期間：2025年12月20日 ～ 2026年1月5日\r\n"
    "＊端数処理前で作成しています。\r\n"
    ",１時間ごとの電力量内訳,,,,,,,,,,,,,,,,,,,,,,,\r\n"
    ",0-1時,1-2時,2-3時,3-4時,4-5時,5-6時,6-7時,7-8時,8-9時,9-10時,10-11時,11-12時,"
    "12-13時,13-14時,14-15時,15-16時,16-17時,17-18時,18-19時,19-20時,20-21時,21-22時,"
    "22-23時,23-24時\r\n"
    "抽出期間合計,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\r\n"
    " 01/03,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10,"
    "0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10\r\n"
    " 12/25,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20,"
    "0.20,0.20,0.20,0.20,0.20,0.20,0.20,0.20\r\n"
)


def test_parse_csv_reads_hourly_rows_and_skips_header_and_totals():
    records = kepco_import.parse_csv(HOURLY_CSV.encode("utf-8"))

    by_date = {}
    for r in records:
        by_date.setdefault(r["date"], {})[r["hour"]] = r["kwh"]

    assert set(by_date.keys()) == {datetime.date(2026, 8, 17), datetime.date(2026, 7, 15)}
    assert by_date[datetime.date(2026, 8, 17)][0] == 0.30
    assert by_date[datetime.date(2026, 8, 17)][23] == 0.30
    assert by_date[datetime.date(2026, 7, 15)][8] == 1.10
    # 「抽出期間合計」行・ヘッダー行は日付として拾わない
    assert len(records) == 48


def test_parse_csv_falls_back_to_cp932():
    raw = HOURLY_CSV.encode("cp932")
    records = kepco_import.parse_csv(raw)
    assert len(records) == 48


def test_parse_csv_resolves_year_across_year_boundary():
    records = kepco_import.parse_csv(YEAR_CROSSING_CSV.encode("utf-8"))
    dates = {r["date"] for r in records}
    assert datetime.date(2026, 1, 3) in dates
    assert datetime.date(2025, 12, 25) in dates


def test_parse_csv_rejects_csv_without_period_line():
    with pytest.raises(kepco_import.KepcoCsvError):
        kepco_import.parse_csv("なにか,別の,CSV\r\n".encode("utf-8"))


def test_parse_csv_rejects_non_hourly_export():
    broken = HOURLY_CSV.replace("１時間ごとの電力量内訳", "３０分ごとの電力量内訳")
    with pytest.raises(kepco_import.KepcoCsvError):
        kepco_import.parse_csv(broken.encode("utf-8"))


def test_summarize_reports_days_and_period():
    records = kepco_import.parse_csv(HOURLY_CSV.encode("utf-8"))
    summary = kepco_import.summarize(records)
    assert summary["imported_rows"] == 48
    assert summary["imported_days"] == 2
    assert summary["period_start"] == "2026-07-15"
    assert summary["period_end"] == "2026-08-17"


def test_import_kepco_csv_requires_auth(client):
    response = client.post(
        "/api/energy/kepco/import",
        files={"file": ("Hour__202608.csv", HOURLY_CSV.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 401


def test_import_kepco_csv_returns_mock_summary(authed_client):
    response = authed_client.post(
        "/api/energy/kepco/import",
        files={"file": ("Hour__202608.csv", HOURLY_CSV.encode("utf-8"), "text/csv")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "mock_ok"
    assert payload["imported_days"] == 2


def test_import_kepco_csv_rejects_invalid_csv(authed_client):
    response = authed_client.post(
        "/api/energy/kepco/import",
        files={"file": ("dummy.csv", b"not,a,kepco,csv", "text/csv")},
    )
    assert response.status_code == 400
    assert "CSV" in response.json()["detail"] or "データ抽出対象期間" in response.json()["detail"]


def test_import_kepco_csv_hides_db_error_detail_and_logs(authed_client, monkeypatch, caplog):
    def boom(*args, **kwargs):
        raise RuntimeError("INSERT INTO kepco_hourly_usage secret-table")

    class FakeDb:
        def rollback(self):
            pass

    from backend.main import app

    app.dependency_overrides[database.get_db] = lambda: FakeDb()
    monkeypatch.setattr(database, "DB_MOCK", False)
    monkeypatch.setattr(kepco_import, "upsert_kepco_hourly", boom)
    with caplog.at_level("ERROR"):
        response = authed_client.post(
            "/api/energy/kepco/import",
            files={"file": ("Hour__202608.csv", HOURLY_CSV.encode("utf-8"), "text/csv")},
        )
    del app.dependency_overrides[database.get_db]
    assert response.status_code == 500
    assert response.json()["detail"] == "internal error"
    assert "kepco importの保存に失敗" in caplog.text
    assert "secret-table" in caplog.text
