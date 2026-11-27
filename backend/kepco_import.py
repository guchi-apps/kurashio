"""KEPCO「みるでん」の時間ごとCSVの取り込み（#302）。

ダウンロードできるCSVは以下の形（実サンプルで確認済み）:

    1行目: お客さま番号：..., 契約種別：..., ニックネーム：...
    2行目: ご使用場所住所：...
    3行目: データ抽出対象期間：2026年7月15日 ～ 2026年8月17日
    4行目: ＊端数処理前で作成しています。
    5行目: ,１時間ごとの電力量内訳,,,,,,,,,,,,,,,,,,,,,,,
    6行目: ,0-1時,1-2時,...,23-24時
    7行目: 抽出期間合計,26.30,27.10,...
    8行目〜: " 08/17",0.30,0.40,...  （日付降順、年なしのMM/DD）

年が書かれていないので「データ抽出対象期間」から復元する。行の選別は
`MM/DD` にマッチするかどうかだけで判定するため、ヘッダー行・集計行・
先頭の説明行は自然に読み飛ばせる。
"""

from __future__ import annotations

import csv
import datetime
import io
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from . import database

_PERIOD_RE = re.compile(
    r"データ抽出対象期間[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*[~〜～]\s*"
    r"(\d{4})年(\d{1,2})月(\d{1,2})日"
)
_DAY_RE = re.compile(r"^(\d{2})/(\d{2})$")
_HOURLY_TITLE_MARK = "１時間ごと"


class KepcoCsvError(ValueError):
    """CSVの形式が想定と違うときに送出する。"""


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise KepcoCsvError("CSVの文字コードを判別できませんでした。")


def _find_period(rows: Sequence[Sequence[str]]) -> Tuple[datetime.date, datetime.date]:
    for row in rows[:6]:
        m = _PERIOD_RE.search(",".join(row))
        if m:
            return (
                datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))),
                datetime.date(int(m.group(4)), int(m.group(5)), int(m.group(6))),
            )
    raise KepcoCsvError(
        "データ抽出対象期間を読み取れませんでした。"
        "KEPCO「みるでん」からダウンロードしたCSVをそのまま指定してください。"
    )


def parse_period(raw: bytes) -> Tuple[datetime.date, datetime.date]:
    """CSVの「データ抽出対象期間」。請求の使用期間の判定に使う（#884）。保存はしない。"""
    return _find_period(list(csv.reader(io.StringIO(_decode(raw)))))


def parse_csv(raw: bytes) -> List[Dict[str, Any]]:
    """CSVのバイト列から `{"date": date, "hour": int, "kwh": float}` の一覧を作る。"""
    text = _decode(raw)
    rows = list(csv.reader(io.StringIO(text)))

    period_start, period_end = _find_period(rows)
    hourly_title_found = any(_HOURLY_TITLE_MARK in ",".join(row) for row in rows[:6])

    if not hourly_title_found:
        raise KepcoCsvError(
            "1時間ごとの電力量のCSVではないようです。"
            "「みるでん」で時間ごとの内訳をダウンロードしてください。"
        )

    records: List[Dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        label = row[0].strip()
        m = _DAY_RE.match(label)
        if not m:
            continue

        month, day = int(m.group(1)), int(m.group(2))
        date = _resolve_date(month, day, period_start, period_end)
        if date is None:
            continue

        for hour, cell in enumerate(row[1:25]):
            cell = cell.strip()
            if not cell:
                continue
            try:
                kwh = float(cell)
            except ValueError:
                continue
            records.append({"date": date, "hour": hour, "kwh": kwh})

    if not records:
        raise KepcoCsvError("読み取れる時間ごとのデータがありませんでした。")

    return records


def _resolve_date(
    month: int,
    day: int,
    period_start: datetime.date,
    period_end: datetime.date,
) -> Optional[datetime.date]:
    """年なしの MM/DD を、抽出期間内に収まる年へ復元する（年またぎのCSVでも安全にする）。"""
    for year in {period_start.year, period_end.year}:
        try:
            candidate = datetime.date(year, month, day)
        except ValueError:
            continue
        if period_start <= candidate <= period_end:
            return candidate
    return None


def summarize(records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """取り込み結果の件数・日数・期間をまとめる。DB取り込み前後どちらでも使える。"""
    dates = {item["date"] for item in records}
    return {
        "imported_rows": len(records),
        "imported_days": len(dates),
        "period_start": min(dates).isoformat() if dates else None,
        "period_end": max(dates).isoformat() if dates else None,
    }


def upsert_kepco_hourly(
    db: Session,
    records: Sequence[Dict[str, Any]],
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """`(date, hour)` で upsert する。同じ日付を再取り込みしても二重計上しない。"""
    now = now or datetime.datetime.utcnow()
    for item in records:
        date = item["date"]
        hour = item["hour"]
        row = (
            db.query(database.KepcoHourlyUsageRecord)
            .filter(
                database.KepcoHourlyUsageRecord.date == date,
                database.KepcoHourlyUsageRecord.hour == hour,
            )
            .first()
        )
        if row is None:
            row = database.KepcoHourlyUsageRecord(date=date, hour=hour)
            db.add(row)
        row.kwh = item["kwh"]
        row.imported_at = now

    db.commit()
    return summarize(records)
