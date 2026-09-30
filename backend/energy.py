"""日別の電力使用量（`daily_energy`）の保存と集計。

取得元は日ごとの使用量（kWh）しか返さないことが多いため、金額は
`ui_settings` の `energy_unit_price`（円/kWh）を掛けて出す。取得元が金額まで
返してきた場合だけ、その値（`cost_yen`）を優先する。

集計の区切りは日付そのもの（JST の暦日）で、時刻は持たない。同じ日を何度
送っても最後の値で上書きする（AirCloud Home の当日ぶんは1日のあいだ増えて
いくため、追記ではなく上書きでないと二重計上になる）。
"""

from __future__ import annotations

import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import database, ui_settings

DEFAULT_SOURCE = "aircon"

#: スマートプラグの `source` に付く前置き（`tapo:冷蔵庫`）。
#: 「種別:識別子」の形にしておくと、機器が増えても列を足さずに済む。
TAPO_SOURCE_PREFIX = "tapo:"

#: KEPCO実測とエアコン・スマートプラグ実測の差分（#302）に使う疑似 source。
#: 実体のある機器ではないため `daily_energy`/`energy_readings` には保存せず、
#: 時間ごと表示（`build_hourly`）と日別表示（`build_breakdown`、#319）が
#: 算出のたびに組み立てる。取り込み済みのCSVは `kepco_hourly_usage` の1つだけで、
#: 日別はそれを日ごとに合算して使う（日別用のテーブルは作らない）。
KEPCO_OTHER_SOURCE = "kepco_other"

#: ダッシュボードのカードが使う日別データの本数（直近30日ぶん）
DEFAULT_HISTORY_DAYS = 30


def source_label(source: str) -> str:
    """`source` を画面に出す既定の名前へ。

    `aircon` → `エアコン`、`tapo:冷蔵庫` → `冷蔵庫`。知らない取得元はそのまま返す
    （取得元が増えたときに、名前が出ないより生の値が出るほうが原因を追える）。

    スマートプラグの名前はTapoアプリで付けたものが収集スクリプト経由で `source` に
    入っている（`collectors/tapo_to_myroom.py` の `device.alias`）。画面から別名を
    付けた場合は `resolve_source_label()` がそちらを優先する。
    """
    if source == DEFAULT_SOURCE:
        return "エアコン"
    if source == KEPCO_OTHER_SOURCE:
        return "その他"
    if source.startswith(TAPO_SOURCE_PREFIX):
        return source[len(TAPO_SOURCE_PREFIX) :] or source
    return source


def resolve_source_label(source: str, overrides: Optional[Mapping[str, str]] = None) -> str:
    """画面に出す名前。画面から付けた別名があればそれを、無ければ既定を返す（#335）。

    **別名を付けても `source` は変えない。** `daily_energy` の主キーは
    `(date, source)` なので、`source` を書き換えると過去の使用量と切れる。
    """
    if overrides:
        name = overrides.get(source)
        if isinstance(name, str) and name.strip():
            return name.strip()
    return source_label(source)


def get_source_names(db: Optional[Session] = None) -> Dict[str, str]:
    """取得元に付けた別名。保存していなければ空の辞書。"""
    settings = ui_settings.get_settings(db)
    names = settings.get(ui_settings.SETTING_ENERGY_SOURCE_NAMES) or {}
    return dict(names) if isinstance(names, dict) else {}


def get_unit_price(db: Optional[Session] = None) -> float:
    settings = ui_settings.get_settings(db)
    return float(
        settings.get(
            ui_settings.SETTING_ENERGY_UNIT_PRICE,
            ui_settings.DEFAULT_ENERGY_UNIT_PRICE,
        )
    )


def parse_date(value: Any) -> datetime.date:
    """`2026-08-22` 形式、または date/datetime を日付へ落とす。"""
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if isinstance(value, str):
        text = value.strip()
        try:
            return datetime.date.fromisoformat(text[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid date: {value}") from exc
    raise ValueError(f"Invalid date: {value}")


def resolve_cost(kwh: Optional[float], cost_yen: Optional[float], unit_price: float) -> Optional[float]:
    """取得元が金額を返していればそれを、無ければ単価から計算する。"""
    if cost_yen is not None:
        return float(cost_yen)
    if kwh is None:
        return None
    return round(float(kwh) * unit_price, 1)


def upsert_records(
    db: Session,
    records: Sequence[Dict[str, Any]],
    now: Optional[datetime.datetime] = None,
) -> int:
    """同じ (date, source) は上書きする。書き込んだ件数を返す。

    `now`（JSTのnaive datetime）を渡すと、当日ぶんの行だけ`energy_readings`へも
    追記する。収集スクリプトは当日ぶんを何度も送り直す作りなので、その受信のたびが
    そのまま「時間ごと」表示のためのポーリングになる（収集スクリプト自体は変更不要）。
    """
    written = 0
    today = now.date() if now is not None else None
    for item in records:
        date = parse_date(item["date"])
        source = (item.get("source") or DEFAULT_SOURCE).strip() or DEFAULT_SOURCE
        row = (
            db.query(database.DailyEnergyRecord)
            .filter(
                database.DailyEnergyRecord.date == date,
                database.DailyEnergyRecord.source == source,
            )
            .first()
        )
        if row is None:
            row = database.DailyEnergyRecord(date=date, source=source)
            db.add(row)
        row.kwh = item.get("kwh")
        row.cost_yen = item.get("cost_yen")
        row.power_w = item.get("power_w")
        row.updated_at = datetime.datetime.utcnow()
        written += 1

        if now is not None and date == today:
            db.add(
                database.EnergyReadingRecord(
                    recorded_at=now,
                    source=source,
                    kwh=item.get("kwh"),
                    cost_yen=item.get("cost_yen"),
                    power_w=item.get("power_w"),
                )
            )

    db.commit()
    return written


def _fetch_rows(
    db: Session,
    source: str,
    start: datetime.date,
    end: datetime.date,
) -> List[Dict[str, Any]]:
    rows = (
        db.query(database.DailyEnergyRecord)
        .filter(
            database.DailyEnergyRecord.source == source,
            database.DailyEnergyRecord.date >= start,
            database.DailyEnergyRecord.date <= end,
        )
        .order_by(database.DailyEnergyRecord.date.asc())
        .all()
    )
    return _serialize_rows(rows)


def _serialize_rows(rows: Sequence[Any]) -> List[Dict[str, Any]]:
    return [
        {
            "date": row.date,
            "source": row.source,
            "kwh": row.kwh,
            "cost_yen": row.cost_yen,
            "power_w": row.power_w,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


def fetch_all_rows(
    db: Session, start: datetime.date, end: datetime.date
) -> List[Dict[str, Any]]:
    """取得元を絞らずに引く。消費電力カードはエアコンとプラグを1枚にまとめるため。

    `backend/bills.py` も、請求額に対して実測がどのくらいを占めるかを出すのに使う。
    """
    rows = (
        db.query(database.DailyEnergyRecord)
        .filter(
            database.DailyEnergyRecord.date >= start,
            database.DailyEnergyRecord.date <= end,
        )
        .order_by(
            database.DailyEnergyRecord.date.asc(),
            database.DailyEnergyRecord.source.asc(),
        )
        .all()
    )
    return _serialize_rows(rows)


def _total(rows: Sequence[Dict[str, Any]], unit_price: float) -> Dict[str, Any]:
    kwh = sum(float(row["kwh"]) for row in rows if row.get("kwh") is not None)
    cost = sum(
        cost
        for cost in (
            resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price) for row in rows
        )
        if cost is not None
    )
    return {
        "kwh": round(kwh, 2),
        "cost_yen": round(cost),
        "days": len(rows),
    }


def _month_start(date: datetime.date) -> datetime.date:
    return date.replace(day=1)


def _previous_month_start(date: datetime.date) -> datetime.date:
    return (date.replace(day=1) - datetime.timedelta(days=1)).replace(day=1)


def _same_day_of_previous_month(date: datetime.date) -> datetime.date:
    """先月の「同じ日」。月末の日数差は先月末で頭打ちにする。"""
    prev_start = _previous_month_start(date)
    last_day = (date.replace(day=1) - datetime.timedelta(days=1)).day
    return prev_start.replace(day=min(date.day, last_day))


def build_summary(
    rows: Sequence[Dict[str, Any]],
    today: datetime.date,
    unit_price: float,
    source: str,
    history_days: int = DEFAULT_HISTORY_DAYS,
) -> Dict[str, Any]:
    """カードが必要とする集計をまとめて作る。DBアクセスを含まない（テストしやすくするため）。"""
    by_date = {row["date"]: row for row in rows}

    def day_payload(date: datetime.date) -> Optional[Dict[str, Any]]:
        row = by_date.get(date)
        if row is None:
            return None
        return {
            "date": date.isoformat(),
            "kwh": round(float(row["kwh"]), 2) if row.get("kwh") is not None else None,
            "cost_yen": resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price),
        }

    yesterday = today - datetime.timedelta(days=1)
    month_start = _month_start(today)
    prev_month_start = _previous_month_start(today)
    prev_month_end = month_start - datetime.timedelta(days=1)
    prev_month_same_day = _same_day_of_previous_month(today)

    this_month_rows = [row for row in rows if month_start <= row["date"] <= today]
    last_month_rows = [row for row in rows if prev_month_start <= row["date"] <= prev_month_end]
    last_month_to_date_rows = [
        row for row in rows if prev_month_start <= row["date"] <= prev_month_same_day
    ]

    history_start = today - datetime.timedelta(days=history_days - 1)
    daily = [
        {
            "date": row["date"].isoformat(),
            "kwh": round(float(row["kwh"]), 2) if row.get("kwh") is not None else None,
            "cost_yen": resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price),
        }
        for row in rows
        if history_start <= row["date"] <= today
    ]

    latest = max((row["date"] for row in rows), default=None)
    updated_at = max(
        (row["updated_at"] for row in rows if row.get("updated_at") is not None),
        default=None,
    )

    return {
        "source": source,
        "unit_price": unit_price,
        "today": day_payload(today),
        "yesterday": day_payload(yesterday),
        "this_month": {
            **_total(this_month_rows, unit_price),
            "start": month_start.isoformat(),
            "end": today.isoformat(),
        },
        "last_month": {
            **_total(last_month_rows, unit_price),
            "start": prev_month_start.isoformat(),
            "end": prev_month_end.isoformat(),
        },
        "last_month_to_date": {
            **_total(last_month_to_date_rows, unit_price),
            "start": prev_month_start.isoformat(),
            "end": prev_month_same_day.isoformat(),
        },
        "daily": daily,
        "latest_date": latest.isoformat() if latest else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def get_summary(
    db: Optional[Session],
    today: datetime.date,
    source: str = DEFAULT_SOURCE,
    history_days: int = DEFAULT_HISTORY_DAYS,
) -> Dict[str, Any]:
    unit_price = get_unit_price(db)

    if database.DB_MOCK or db is None:
        rows = database.generate_mock_daily_energy(source)
    else:
        # 先月ぶんの集計にも足りるよう、月初より前から引く
        start = min(
            _previous_month_start(today),
            today - datetime.timedelta(days=history_days - 1),
        )
        rows = _fetch_rows(db, source, start, today)

    return build_summary(rows, today, unit_price, source, history_days=history_days)


# --------------------------------------------------------------- 取得元をまたぐ集計
#
# 消費電力カードはエアコン（`aircon`）とスマートプラグ（`tapo:*`）を1枚にまとめる。
# 知りたいのは「家全体で今月いくらか」で、取得元ごとにカードを分けると足し算が
# 読み手の仕事になるため。`daily_energy` が取得元非依存の1テーブルなのに合わせて、
# 画面へ渡す集計もここで1つに畳む。


def _period_total(
    rows: Sequence[Dict[str, Any]], unit_price: float
) -> Dict[str, Any]:
    """期間合計。`days` は**行数ではなく日数**を数える。

    取得元が複数あると1日につき複数行あるため、`len(rows)` を日数として使うと
    「4台つないだ月は日数が4倍」になってしまう。
    """
    kwh = sum(float(row["kwh"]) for row in rows if row.get("kwh") is not None)
    cost = sum(
        cost
        for cost in (
            resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price) for row in rows
        )
        if cost is not None
    )
    return {
        "kwh": round(kwh, 2),
        "cost_yen": round(cost),
        "days": len({row["date"] for row in rows}),
    }


def _source_order_key(entry: Dict[str, Any]) -> Any:
    """エアコンを先頭に、あとは今月の使用量が多い順。

    毎回同じ並びにしたいので、使用量が並んだときは取得元の名前で決める。
    """
    return (
        0 if entry["source"] == DEFAULT_SOURCE else 1,
        -entry["this_month_kwh"],
        entry["source"],
    )


def build_breakdown(
    rows: Sequence[Dict[str, Any]],
    today: datetime.date,
    unit_price: float,
    history_days: int = DEFAULT_HISTORY_DAYS,
    kepco_daily: Optional[Sequence[Dict[str, Any]]] = None,
    source_names: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    """カードと詳細パネルが必要とするものをまとめて作る。DBアクセスを含まない。

    `source_names` は画面から付けた別名（#335）。渡すと `label` がそちらになる。
    `default_label` には別名を当てる前の名前を入れて返すので、設定画面は
    「Tapoの名前」を出せるし、上書き中かどうかも2つを見比べれば分かる。

    `kepco_daily`（KEPCO CSV由来の実測を日ごとに合算したもの、#319）を渡すと、
    その日のエアコン・スマートプラグ実測との差分を `KEPCO_OTHER_SOURCE`（「その他」）
    として `daily` へ積む。考え方は時間ごと（`build_hourly`）と同じで、KEPCO実測の
    ほうが小さいときは0に丸め、マイナスにはしない。

    **積むのは `daily` だけで、期間合計（`today`/`this_month`/`last_month`/
    `last_month_to_date`）と取得元一覧（`sources`）には入れない。** CSVは直近1か月強
    しか落とせないため、月合計へ混ぜると取り込んだ範囲によって「先月」の金額が動く。
    `sources` は押すと機器ごとの推移が開く一覧で、「その他」には開く先が無い。
    """
    month_start = _month_start(today)
    prev_month_start = _previous_month_start(today)
    prev_month_end = month_start - datetime.timedelta(days=1)
    prev_month_same_day = _same_day_of_previous_month(today)
    history_start = today - datetime.timedelta(days=history_days - 1)

    def in_range(row: Dict[str, Any], start: datetime.date, end: datetime.date) -> bool:
        return start <= row["date"] <= end

    # --- 取得元ごとの行 -------------------------------------------------
    sources: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        entry = sources.setdefault(
            row["source"],
            {
                "source": row["source"],
                "label": resolve_source_label(row["source"], source_names),
                "default_label": source_label(row["source"]),
                "today_kwh": None,
                "today_cost_yen": None,
                "power_w": None,
                # `power_w` を受け取った時刻（#410）。動作中判定の鮮度チェックに使う。
                # スマートプラグが応答しなくなると `daily_energy` は最後の値を上書きしないまま
                # 残り続けるため、値だけでは「いま動いているか」を保証できない
                "power_updated_at": None,
                "this_month_kwh": 0.0,
                "latest_date": None,
            },
        )
        if row["date"] == today:
            entry["today_kwh"] = (
                round(float(row["kwh"]), 2) if row.get("kwh") is not None else None
            )
            entry["today_cost_yen"] = resolve_cost(
                row.get("kwh"), row.get("cost_yen"), unit_price
            )
            entry["power_w"] = row.get("power_w")
            entry["power_updated_at"] = row.get("updated_at")
        if in_range(row, month_start, today) and row.get("kwh") is not None:
            entry["this_month_kwh"] += float(row["kwh"])
        if entry["latest_date"] is None or row["date"] > entry["latest_date"]:
            entry["latest_date"] = row["date"]

    source_rows = sorted(sources.values(), key=_source_order_key)
    for entry in source_rows:
        entry["this_month_kwh"] = round(entry["this_month_kwh"], 2)
        entry["latest_date"] = (
            entry["latest_date"].isoformat() if entry["latest_date"] else None
        )
        # `row.updated_at` は `datetime.utcnow()`（naive・UTC）。フロントの `new Date()` に
        # タイムゾーン無しの文字列を渡すとローカル時刻として誤解釈されるため、`Z` を明示する
        entry["power_updated_at"] = (
            entry["power_updated_at"].isoformat() + "Z" if entry["power_updated_at"] else None
        )

    # --- 日別（取得元ごとの内訳つき） -----------------------------------
    daily_map: Dict[datetime.date, Dict[str, Any]] = {}
    for row in rows:
        if not in_range(row, history_start, today):
            continue
        day = daily_map.setdefault(
            row["date"], {"date": row["date"], "kwh": 0.0, "cost_yen": 0.0, "by_source": {}}
        )
        if row.get("kwh") is not None:
            day["kwh"] += float(row["kwh"])
            day["by_source"][row["source"]] = round(float(row["kwh"]), 2)
        cost = resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price)
        if cost is not None:
            day["cost_yen"] += cost

    # KEPCO実測（家全体）との差分を「その他」として積む（#319）。
    # 機器の記録が1件も無い日でも、KEPCOだけで1日ぶんの棒が立つ。
    for item in kepco_daily or []:
        date = item["date"]
        if item.get("kwh") is None or not in_range({"date": date}, history_start, today):
            continue
        day = daily_map.get(date)
        other_kwh = max(0.0, float(item["kwh"]) - (day["kwh"] if day else 0.0))
        if other_kwh <= 0:
            continue
        if day is None:
            day = daily_map.setdefault(
                date, {"date": date, "kwh": 0.0, "cost_yen": 0.0, "by_source": {}}
            )
        # 内訳の丸めは機器の行（小数2桁）に揃える。時間ごとは値が小さいので3桁だが、
        # 日別で3桁にすると「内訳を足すと合計になる」がずれて見える
        day["by_source"][KEPCO_OTHER_SOURCE] = round(other_kwh, 2)
        day["kwh"] += other_kwh
        other_cost = resolve_cost(other_kwh, None, unit_price)
        if other_cost is not None:
            day["cost_yen"] += other_cost

    daily = [
        {
            "date": day["date"].isoformat(),
            "kwh": round(day["kwh"], 2),
            "cost_yen": round(day["cost_yen"]),
            "by_source": day["by_source"],
        }
        for day in sorted(daily_map.values(), key=lambda item: item["date"])
    ]

    today_rows = [row for row in rows if row["date"] == today]
    latest = max((row["date"] for row in rows), default=None)
    updated_at = max(
        (row["updated_at"] for row in rows if row.get("updated_at") is not None),
        default=None,
    )

    return {
        "unit_price": unit_price,
        "sources": source_rows,
        "today": {
            "date": today.isoformat(),
            **_period_total(today_rows, unit_price),
        },
        "this_month": {
            **_period_total(
                [row for row in rows if in_range(row, month_start, today)], unit_price
            ),
            "start": month_start.isoformat(),
            "end": today.isoformat(),
        },
        "last_month": {
            **_period_total(
                [row for row in rows if in_range(row, prev_month_start, prev_month_end)],
                unit_price,
            ),
            "start": prev_month_start.isoformat(),
            "end": prev_month_end.isoformat(),
        },
        "last_month_to_date": {
            **_period_total(
                [
                    row
                    for row in rows
                    if in_range(row, prev_month_start, prev_month_same_day)
                ],
                unit_price,
            ),
            "start": prev_month_start.isoformat(),
            "end": prev_month_same_day.isoformat(),
        },
        "daily": daily,
        "latest_date": latest.isoformat() if latest else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def _fetch_kepco_daily(
    db: Session, start: datetime.date, end: datetime.date
) -> List[Dict[str, Any]]:
    """`kepco_hourly_usage` を日ごとに合算して引く（#319）。

    時間ごと（`_fetch_kepco_hours`）は1日ぶんを時間の並びで返すが、日別が要るのは
    「その日いくら使ったか」だけなので、SQL側で合計してしまう。
    """
    rows = (
        db.query(
            database.KepcoHourlyUsageRecord.date,
            func.sum(database.KepcoHourlyUsageRecord.kwh),
        )
        .filter(
            database.KepcoHourlyUsageRecord.date >= start,
            database.KepcoHourlyUsageRecord.date <= end,
        )
        .group_by(database.KepcoHourlyUsageRecord.date)
        .order_by(database.KepcoHourlyUsageRecord.date.asc())
        .all()
    )
    return [{"date": date, "kwh": float(total)} for date, total in rows if total is not None]


def get_breakdown(
    db: Optional[Session],
    today: datetime.date,
    history_days: int = DEFAULT_HISTORY_DAYS,
) -> Dict[str, Any]:
    unit_price = get_unit_price(db)
    # 「その他」を積むのは日別の一覧だけなので、KEPCO は履歴の範囲だけ引けばよい
    history_start = today - datetime.timedelta(days=history_days - 1)

    if database.DB_MOCK or db is None:
        rows = database.generate_mock_energy_rows()
        kepco_daily = database.generate_mock_kepco_daily(history_start, today)
    else:
        # 先月ぶんの集計にも足りるよう、月初より前から引く
        start = min(_previous_month_start(today), history_start)
        rows = fetch_all_rows(db, start, today)
        kepco_daily = _fetch_kepco_daily(db, history_start, today)

    return build_breakdown(
        rows,
        today,
        unit_price,
        history_days=history_days,
        kepco_daily=kepco_daily,
        source_names=get_source_names(db),
    )


# --------------------------------------------------------------- 時間ごと（#300）
#
# `energy_readings` は上書きの `daily_energy` と違い、収集を受け付けるたびに
# 「その時点までの当日累計」を追記した時系列。時間帯の使用量は隣接する2件の
# 差分から出す（境界はポーリング時刻に依存する近似値）。


def _fetch_readings(
    db: Session, date: datetime.date
) -> List[Dict[str, Any]]:
    start = datetime.datetime.combine(date, datetime.time.min)
    end = datetime.datetime.combine(date, datetime.time.max)
    rows = (
        db.query(database.EnergyReadingRecord)
        .filter(
            database.EnergyReadingRecord.recorded_at >= start,
            database.EnergyReadingRecord.recorded_at <= end,
        )
        .order_by(database.EnergyReadingRecord.recorded_at.asc())
        .all()
    )
    return [
        {
            "recorded_at": row.recorded_at,
            "source": row.source,
            "kwh": row.kwh,
            "cost_yen": row.cost_yen,
        }
        for row in rows
    ]


def _value_at_or_before(
    sorted_rows: Sequence[Dict[str, Any]],
    boundary: datetime.datetime,
    field: str,
) -> Optional[float]:
    """`boundary`時点までに届いていた最新の値（累計）。無ければ None。"""
    value: Optional[float] = None
    for row in sorted_rows:
        if row["recorded_at"] > boundary:
            break
        if row.get(field) is not None:
            value = float(row[field])
    return value


def build_hourly(
    readings: Sequence[Dict[str, Any]],
    date: datetime.date,
    unit_price: float,
    kepco_hours: Optional[Sequence[Dict[str, Any]]] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """1日ぶんの時系列スナップショットから時間帯ごとの内訳を組み立てる。DBアクセスを含まない。

    `kepco_hours`（KEPCO CSV由来の時間ごと実測、#302）を渡すと、その時間帯の
    エアコン・スマートプラグ実測との差分を `KEPCO_OTHER_SOURCE`（「その他」）として
    積み増す。KEPCO実測のほうが小さい（測定誤差・端数処理由来）ときは0に丸め、
    マイナスにはしない。

    `now`（JSTのnaive datetime）を渡すと、開始時刻が`now`より後の時間帯
    （当日のまだ来ていない時間帯）は 0 kWh ではなく `kwh: None`（記録なし）にする。
    過去の日の夜間が 0 になるのは意図どおりなので、過去日には影響しない。
    """
    by_source: Dict[str, List[Dict[str, Any]]] = {}
    for row in readings:
        by_source.setdefault(row["source"], []).append(row)
    for source, rows in by_source.items():
        by_source[source] = sorted(rows, key=lambda r: r["recorded_at"])

    kepco_by_hour: Dict[int, float] = {
        row["hour"]: float(row["kwh"]) for row in (kepco_hours or []) if row.get("kwh") is not None
    }

    has_data = any(by_source.values()) or bool(kepco_by_hour)
    sources = sorted(by_source.keys())
    if kepco_by_hour:
        sources.append(KEPCO_OTHER_SOURCE)

    hours: List[Dict[str, Any]] = []
    for hour in range(24):
        if now is not None and datetime.datetime.combine(date, datetime.time(hour)) > now:
            hours.append({"hour": hour, "kwh": None, "cost_yen": None, "by_source": {}})
            continue
        boundary_end = datetime.datetime.combine(date, datetime.time(hour, 59, 59))
        boundary_start = boundary_end - datetime.timedelta(hours=1)

        by_source_kwh: Dict[str, float] = {}
        hour_kwh = 0.0
        hour_cost = 0.0
        any_value = False

        for source, rows in by_source.items():
            end_kwh = _value_at_or_before(rows, boundary_end, "kwh")
            if end_kwh is None:
                continue
            start_kwh = _value_at_or_before(rows, boundary_start, "kwh")
            delta_kwh = max(0.0, end_kwh - (start_kwh or 0.0))

            end_cost = _value_at_or_before(rows, boundary_end, "cost_yen")
            delta_cost: Optional[float] = None
            if end_cost is not None:
                start_cost = _value_at_or_before(rows, boundary_start, "cost_yen")
                delta_cost = max(0.0, end_cost - (start_cost or 0.0))

            cost = resolve_cost(delta_kwh, delta_cost, unit_price)
            by_source_kwh[source] = round(delta_kwh, 3)
            hour_kwh += delta_kwh
            if cost is not None:
                hour_cost += cost
            any_value = True

        kepco_kwh = kepco_by_hour.get(hour)
        if kepco_kwh is not None:
            other_kwh = max(0.0, kepco_kwh - hour_kwh)
            if other_kwh > 0:
                by_source_kwh[KEPCO_OTHER_SOURCE] = round(other_kwh, 3)
                hour_kwh += other_kwh
                other_cost = resolve_cost(other_kwh, None, unit_price)
                if other_cost is not None:
                    hour_cost += other_cost
            any_value = True

        hours.append(
            {
                "hour": hour,
                "kwh": round(hour_kwh, 3) if any_value else None,
                "cost_yen": round(hour_cost) if any_value else None,
                "by_source": by_source_kwh,
            }
        )

    return {
        "date": date.isoformat(),
        "unit_price": unit_price,
        "sources": sources,
        "has_data": has_data,
        "hours": hours,
    }


def _fetch_kepco_hours(db: Session, date: datetime.date) -> List[Dict[str, Any]]:
    rows = (
        db.query(database.KepcoHourlyUsageRecord)
        .filter(database.KepcoHourlyUsageRecord.date == date)
        .order_by(database.KepcoHourlyUsageRecord.hour.asc())
        .all()
    )
    return [{"hour": row.hour, "kwh": row.kwh} for row in rows]


def get_hourly(
    db: Optional[Session],
    date: datetime.date,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    unit_price = get_unit_price(db)

    if database.DB_MOCK or db is None:
        readings = database.generate_mock_energy_readings(date)
        kepco_hours = database.generate_mock_kepco_hourly(date)
    else:
        readings = _fetch_readings(db, date)
        kepco_hours = _fetch_kepco_hours(db, date)

    return build_hourly(readings, date, unit_price, kepco_hours=kepco_hours, now=now)
