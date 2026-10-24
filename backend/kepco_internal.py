"""AIDE からの関西電力の時間別kWhの安全取込と照会（#823）。

画面の手動CSV取込（`kepco_import.upsert_kepco_hourly`・#302）と同じ `kepco_hourly_usage` に書くが、
こちらは無人の経路なので**既存の値を書き換えない**。

- 入力は正規化済みの `date`・`hour`・`kwh` と抽出対象期間だけ。CSVの先頭行（お客さま番号・住所）は受けない
- 既存の行と1件でも値が違えば `conflict` を返して**1件も書かない**。訂正はログインした本人が
  画面の手動取込（上書き型）で行う
- 差が無ければ、まだ無い時間だけを1トランザクションで足す（`created`）。全件が既にあれば `unchanged`
- 公開前で空欄の時間は送られてこないだけで、0では埋めない。期間内で記録の無い時間は `missing` で返す

同じ `(date, hour)` を主キーにしているので、手動取込とこの経路が重なっても二重計上は起きない。
"""

from __future__ import annotations

import datetime
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import database

#: 1回で受ける期間の上限。みるでんの抽出は直近1か月強なので、2か月あれば足りる
MAX_PERIOD_DAYS = 62
MAX_RECORDS = MAX_PERIOD_DAYS * 24
#: 1時間あたりの上限。家庭の契約で超えることはなく、桁の取り違えを弾くための値
MAX_KWH = 100.0
#: CSVは小数2桁。保存値（Float）との比較で丸め差だけを同値とみなす幅
KWH_TOLERANCE = 0.0005
#: conflict の応答に並べる件数の上限（全件数は `conflict_count`）
MAX_CONFLICTS_IN_RESPONSE = 50

STATUS_CREATED = "created"
STATUS_UNCHANGED = "unchanged"
STATUS_CONFLICT = "conflict"

Key = Tuple[datetime.date, int]


def _parse_date(value: Any, field: str) -> datetime.date:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError as e:
        raise ValueError(f"{field} must be YYYY-MM-DD") from e
    if parsed.isoformat() != value:
        raise ValueError(f"{field} must be YYYY-MM-DD")
    return parsed


def _check_range(start: datetime.date, end: datetime.date, today: datetime.date, label: str) -> None:
    if start > end:
        raise ValueError(f"{label}: start is after end")
    if end > today:
        raise ValueError(f"{label}: end is in the future")
    if (end - start).days + 1 > MAX_PERIOD_DAYS:
        raise ValueError(f"{label}: longer than {MAX_PERIOD_DAYS} days")


def validate_import(raw: Dict[str, Any], today: datetime.date) -> Dict[str, Any]:
    """入力を検証して `{"period_start", "period_end", "records": [{date, hour, kwh}]}` にする。

    誤りは `ValueError`（呼ぶ側で422）。1件でも誤りがあれば全体を受けない。
    """
    start = _parse_date(raw.get("period_start"), "period_start")
    end = _parse_date(raw.get("period_end"), "period_end")
    _check_range(start, end, today, "period")

    items = raw.get("records")
    if not isinstance(items, list) or not items:
        raise ValueError("records must be a non-empty list")
    limit = min(MAX_RECORDS, ((end - start).days + 1) * 24)
    if len(items) > limit:
        raise ValueError(f"too many records (max {limit})")

    records: List[Dict[str, Any]] = []
    seen: set = set()
    for index, item in enumerate(items):
        label = f"records[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{label} must be an object")
        date = _parse_date(item.get("date"), f"{label}.date")
        if not start <= date <= end:
            raise ValueError(f"{label}.date is outside the period")
        hour = item.get("hour")
        if type(hour) is not int or not 0 <= hour <= 23:
            raise ValueError(f"{label}.hour must be an integer 0..23")
        kwh = item.get("kwh")
        if isinstance(kwh, bool) or not isinstance(kwh, (int, float)):
            raise ValueError(f"{label}.kwh must be a number")
        kwh = float(kwh)
        if not math.isfinite(kwh) or kwh < 0 or kwh > MAX_KWH:
            raise ValueError(f"{label}.kwh must be between 0 and {MAX_KWH:g}")
        key = (date, hour)
        if key in seen:
            raise ValueError(f"{label} duplicates {date.isoformat()} hour {hour}")
        seen.add(key)
        records.append({"date": date, "hour": hour, "kwh": kwh})

    return {"period_start": start, "period_end": end, "records": records}


def _load(db: Session, start: datetime.date, end: datetime.date) -> Dict[Key, Any]:
    rows = (
        db.query(database.KepcoHourlyUsageRecord)
        .filter(
            database.KepcoHourlyUsageRecord.date >= start,
            database.KepcoHourlyUsageRecord.date <= end,
        )
        .all()
    )
    return {(row.date, row.hour): row for row in rows}


def _days(start: datetime.date, end: datetime.date) -> Iterable[datetime.date]:
    for offset in range((end - start).days + 1):
        yield start + datetime.timedelta(days=offset)


def _missing(stored: Iterable[Key], start: datetime.date, end: datetime.date) -> List[Dict[str, Any]]:
    """期間内で記録の無い時間を日ごとに並べる（0で埋めない）。"""
    present = set(stored)
    result = []
    for day in _days(start, end):
        hours = [hour for hour in range(24) if (day, hour) not in present]
        if hours:
            result.append({"date": day.isoformat(), "hours": hours})
    return result


def _same(a: float, b: float) -> bool:
    return abs(a - b) <= KWH_TOLERANCE


def import_hourly(
    db: Session,
    raw: Dict[str, Any],
    today: datetime.date,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """検証済みでない入力を受け、上書きせずに取り込む。判定は上から:

    1. 既存の行と値が違う時間が1つでもある → conflict（何も書かない）
    2. まだ無い時間がある → その分だけ1トランザクションで insert → created
    3. 全件が既に同じ値である → unchanged

    同時に書かれて主キーが衝突したときは rollback して読み直し、1〜3をやり直す。
    """
    item = validate_import(raw, today)
    start, end, records = item["period_start"], item["period_end"], item["records"]

    for _ in range(3):
        existing = _load(db, start, end)
        conflicts = []
        new_records = []
        for record in records:
            row = existing.get((record["date"], record["hour"]))
            if row is None:
                new_records.append(record)
            elif not _same(row.kwh, record["kwh"]):
                conflicts.append(
                    {
                        "date": record["date"].isoformat(),
                        "hour": record["hour"],
                        "existing_kwh": row.kwh,
                        "kwh": record["kwh"],
                    }
                )

        if conflicts:
            return _result(STATUS_CONFLICT, start, end, records, existing.keys(), 0, conflicts)
        if not new_records:
            return _result(STATUS_UNCHANGED, start, end, records, existing.keys(), 0, [])

        try:
            stamp = now or datetime.datetime.utcnow()
            for record in new_records:
                db.add(
                    database.KepcoHourlyUsageRecord(
                        date=record["date"],
                        hour=record["hour"],
                        kwh=record["kwh"],
                        imported_at=stamp,
                    )
                )
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        stored = list(existing.keys()) + [(r["date"], r["hour"]) for r in new_records]
        return _result(STATUS_CREATED, start, end, records, stored, len(new_records), [])

    raise RuntimeError("kepco hourly import kept colliding with concurrent writes")


def _result(
    status: str,
    start: datetime.date,
    end: datetime.date,
    records: Sequence[Dict[str, Any]],
    stored: Iterable[Key],
    created: int,
    conflicts: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "status": status,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "received": len(records),
        "created": created,
        "unchanged": len(records) - created - len(conflicts),
        "conflict_count": len(conflicts),
        "conflicts": conflicts[:MAX_CONFLICTS_IN_RESPONSE],
        "missing": _missing(stored, start, end),
    }


def query_hourly(db: Optional[Session], start_raw: str, end_raw: str, today: datetime.date) -> Dict[str, Any]:
    """期間内の保存値を返す。取込の応答を受け取れなかったときに結果を判別するための照会。"""
    start = _parse_date(start_raw, "start")
    end = _parse_date(end_raw, "end")
    _check_range(start, end, today, "range")

    rows = [] if db is None else sorted(_load(db, start, end).values(), key=lambda r: (r.date, r.hour))
    by_day: Dict[datetime.date, List[float]] = {}
    for row in rows:
        by_day.setdefault(row.date, []).append(row.kwh)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "count": len(rows),
        "expected_count": ((end - start).days + 1) * 24,
        "total_kwh": round(sum(row.kwh for row in rows), 3),
        "days": [
            {"date": day.isoformat(), "count": len(values), "total_kwh": round(sum(values), 3)}
            for day, values in sorted(by_day.items())
        ],
        "records": [
            {
                "date": row.date.isoformat(),
                "hour": row.hour,
                "kwh": row.kwh,
                "imported_at": row.imported_at.isoformat() if row.imported_at else None,
            }
            for row in rows
        ],
        "missing": _missing(((row.date, row.hour) for row in rows), start, end),
    }
