"""月ごとの確定請求（`utility_bills`）の保存と集計。

取得元は関西電力「はぴeみる電」が検針のたびに送ってくる
「ご使用量のお知らせ」メール（`collectors/kepco_bill_to_myroom.py`）。
はぴeみる電に公開APIは無く、サイトはCapyのパズル認証と2段階認証で守られているため、
画面を自動で読みに行くのではなく**届いているメールを読む**方式にしている。

`backend/energy.py`（日別の実測）とは意図的に分けている。あちらは機器ごとの使用量で、
こちらは電力会社が確定させた家全体の請求。粒度も出どころも違うので、足し合わせると
二重計上になる。画面では並べて「請求のうちどこまでを機器ごとに追えているか」を出す。

**取れるのは月合計だけ。** 日ごと・時間ごとの使用量はメールに載っていない。
今月ぶんも検針が終わるまで確定しないため、最新は原則「先月分」になる。
"""

from __future__ import annotations

import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy.orm import Session

from . import database, energy

KIND_ELECTRICITY = "electricity"
KIND_GAS = "gas"
#: 水道。2か月に1回の検針の使用明細を**手入力**で記録する（#750）。
#: 電気・ガスのようにメールから取れる取得元が無い
KIND_WATER = "water"

#: 画面に出す並び。電気を先に置く（Issueの主題は電気代）
KIND_ORDER = (KIND_ELECTRICITY, KIND_GAS, KIND_WATER)

KIND_LABELS = {
    KIND_ELECTRICITY: "電気",
    KIND_GAS: "ガス",
    KIND_WATER: "水道",
}

#: 手入力の行の `contract_key`。収集（メール）由来の行とは混ざらない
MANUAL_CONTRACT_KEY = "manual"

#: 手入力で書いてよい種別。電気・ガスはメールから入るので、手で足すと二重計上になる
MANUAL_KINDS = (KIND_WATER,)

#: 手入力の上限。桁の打ち間違いを弾くだけの値
MAX_MANUAL_AMOUNT_YEN = 1_000_000
MAX_MANUAL_USAGE_M3 = 10_000

#: カードと詳細パネルが使う月数（直近12か月）
DEFAULT_HISTORY_MONTHS = 12


def parse_billing_month(value: Any) -> datetime.date:
    """`2026-08` / `2026-08-01` / date を、その月の1日へ落とす。

    請求は月単位なので、日にちの違いで別の行になってはいけない。
    """
    if isinstance(value, datetime.datetime):
        return value.date().replace(day=1)
    if isinstance(value, datetime.date):
        return value.replace(day=1)
    if isinstance(value, str):
        text = value.strip()
        try:
            if len(text) == 7:  # 2026-08
                return datetime.date(int(text[:4]), int(text[5:7]), 1)
            return datetime.date.fromisoformat(text[:10]).replace(day=1)
        except ValueError as exc:
            raise ValueError(f"Invalid billing month: {value}") from exc
    raise ValueError(f"Invalid billing month: {value}")


#: メール収集（`POST /api/bills`）が送ってよい種別。水道は手入力だけ
COLLECTED_KINDS = (KIND_ELECTRICITY, KIND_GAS)


def normalize_kind(value: Any, allowed: Sequence[str] = COLLECTED_KINDS) -> str:
    kind = str(value or "").strip().lower()
    if kind not in allowed:
        raise ValueError(f"Invalid kind: {value}")
    return kind


def format_billing_month(month: datetime.date) -> str:
    """`2026-08-01` → `2026-08`。画面もAPIも日にちは使わない。"""
    return f"{month.year:04d}-{month.month:02d}"


def upsert_records(
    db: Session,
    records: Sequence[Dict[str, Any]],
    allowed_kinds: Sequence[str] = COLLECTED_KINDS,
) -> int:
    """同じ (billing_month, kind, contract_key) は上書きする。書き込んだ件数を返す。

    送り直しても増えない。メールは何度読んでも同じ内容なので、収集スクリプトは
    受信箱に残っているぶんを毎回そのまま送ってよい。
    """
    written = 0
    for item in records:
        month = parse_billing_month(item["billing_month"])
        kind = normalize_kind(item.get("kind"), allowed_kinds)
        contract_key = (item.get("contract_key") or "default").strip() or "default"

        row = (
            db.query(database.UtilityBillRecord)
            .filter(
                database.UtilityBillRecord.billing_month == month,
                database.UtilityBillRecord.kind == kind,
                database.UtilityBillRecord.contract_key == contract_key,
            )
            .first()
        )
        if row is None:
            row = database.UtilityBillRecord(
                billing_month=month, kind=kind, contract_key=contract_key
            )
            db.add(row)
        row.plan_name = item.get("plan_name")
        row.amount_yen = int(item["amount_yen"])
        row.usage_value = item.get("usage_value")
        row.usage_unit = item.get("usage_unit")
        row.received_at = item.get("received_at")
        row.updated_at = datetime.datetime.utcnow()
        written += 1

    db.commit()
    return written


def validate_manual_water(
    billing_month: Any, amount_yen: int, usage_m3: Optional[float]
) -> datetime.date:
    """手入力の水道料金を検証して、検針月（月の1日）を返す。"""
    month = parse_billing_month(billing_month)
    if month > datetime.date.today().replace(day=1) + datetime.timedelta(days=31):
        raise ValueError("Billing month is in the future")
    if amount_yen < 0 or amount_yen > MAX_MANUAL_AMOUNT_YEN:
        raise ValueError("Invalid amount")
    if usage_m3 is not None and (usage_m3 < 0 or usage_m3 > MAX_MANUAL_USAGE_M3):
        raise ValueError("Invalid usage")
    return month


def upsert_manual_water(
    db: Session,
    billing_month: Any,
    amount_yen: int,
    usage_m3: Optional[float] = None,
) -> Dict[str, Any]:
    """水道料金を1件、手入力で記録する。同じ月は上書き（直し方は入れ直すだけ）。

    `billing_month` は検針の月（明細に書かれた「検針月」）。2か月分をまとめて請求する
    ので、使用期間ではなく検針月で1行にする。
    """
    month = validate_manual_water(billing_month, amount_yen, usage_m3)

    upsert_records(
        db,
        [
            {
                "billing_month": month,
                "kind": KIND_WATER,
                "contract_key": MANUAL_CONTRACT_KEY,
                "amount_yen": amount_yen,
                "usage_value": usage_m3,
                "usage_unit": "m3" if usage_m3 is not None else None,
                "received_at": None,
            }
        ],
        allowed_kinds=MANUAL_KINDS,
    )
    return {"billing_month": format_billing_month(month), "kind": KIND_WATER}


def delete_manual_water(db: Session, billing_month: Any) -> bool:
    """手入力の水道料金を1件消す。無ければ False。"""
    month = parse_billing_month(billing_month)
    deleted = (
        db.query(database.UtilityBillRecord)
        .filter(
            database.UtilityBillRecord.billing_month == month,
            database.UtilityBillRecord.kind == KIND_WATER,
            database.UtilityBillRecord.contract_key == MANUAL_CONTRACT_KEY,
        )
        .delete()
    )
    db.commit()
    return deleted > 0


def _serialize_rows(rows: Sequence[Any]) -> List[Dict[str, Any]]:
    return [
        {
            "billing_month": row.billing_month,
            "kind": row.kind,
            "contract_key": row.contract_key,
            "plan_name": row.plan_name,
            "amount_yen": row.amount_yen,
            "usage_value": row.usage_value,
            "usage_unit": row.usage_unit,
            "received_at": row.received_at,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


def _fetch_rows(db: Session, start: datetime.date) -> List[Dict[str, Any]]:
    rows = (
        db.query(database.UtilityBillRecord)
        .filter(database.UtilityBillRecord.billing_month >= start)
        .order_by(
            database.UtilityBillRecord.billing_month.asc(),
            database.UtilityBillRecord.kind.asc(),
        )
        .all()
    )
    return _serialize_rows(rows)


def _shift_months(month: datetime.date, back: int) -> datetime.date:
    """`month` から `back` か月さかのぼった月の1日。"""
    total = month.year * 12 + (month.month - 1) - back
    return datetime.date(total // 12, total % 12 + 1, 1)


def _month_end(month: datetime.date) -> datetime.date:
    return _shift_months(month, -1) - datetime.timedelta(days=1)


# --------------------------------------------------------------- 集計（DBを触らない）


def _sum_kind(rows: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """同じ月・同じ種別の行をまとめる。

    引越しの月は契約が2つあるため、**金額も使用量も足す**（どちらも支払う）。
    契約種別は、契約ごとに違っても1つに絞らず全部並べる。
    """
    items = list(rows)
    if not items:
        return None

    usages = [item["usage_value"] for item in items if item.get("usage_value") is not None]
    units = [item["usage_unit"] for item in items if item.get("usage_unit")]
    plans = []
    for item in items:
        plan = item.get("plan_name")
        if plan and plan not in plans:
            plans.append(plan)

    return {
        "amount_yen": sum(int(item["amount_yen"]) for item in items),
        "usage_value": round(sum(usages), 1) if usages else None,
        "usage_unit": units[0] if units else None,
        "plan_name": " / ".join(plans) if plans else None,
        "contracts": len(items),
    }


def _month_payload(
    month: datetime.date, rows: Sequence[Dict[str, Any]]
) -> Dict[str, Any]:
    in_month = [row for row in rows if row["billing_month"] == month]
    electricity = _sum_kind(row for row in in_month if row["kind"] == KIND_ELECTRICITY)
    gas = _sum_kind(row for row in in_month if row["kind"] == KIND_GAS)
    water = _sum_kind(row for row in in_month if row["kind"] == KIND_WATER)
    total = sum(
        entry["amount_yen"] for entry in (electricity, gas, water) if entry is not None
    )
    return {
        "billing_month": format_billing_month(month),
        "electricity": electricity,
        "gas": gas,
        "water": water,
        "total_yen": total,
    }


def build_comparison(
    latest: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """最新の請求月を1つ前の請求月と比べる。

    比べるのは**合計**ではなく電気だけ。ガスは契約が無い月があり、
    合計で比べると「ガスを解約した月」が「安くなった月」に見えてしまう。
    """
    if latest is None or previous is None:
        return None
    current = latest.get("electricity")
    base = previous.get("electricity")
    if current is None or base is None or base["amount_yen"] <= 0:
        return None

    diff = current["amount_yen"] - base["amount_yen"]
    return {
        "cheaper": diff <= 0,
        "percent": round(abs(diff) / base["amount_yen"] * 100),
        "base_amount_yen": base["amount_yen"],
        "base_billing_month": previous["billing_month"],
    }


def build_measured(
    energy_rows: Sequence[Dict[str, Any]],
    month: Optional[datetime.date],
    unit_price: float,
    electricity_amount_yen: Optional[int],
) -> Optional[Dict[str, Any]]:
    """請求月の暦月ぶんの実測（エアコン＋スマートプラグ）と、請求に対する割合。

    **目安であって内訳ではない。** 請求の対象期間は検針日から検針日までで、暦月とは
    ずれる。それでも「請求のうちどのくらいを機器ごとに追えているか」は桁で分かれば
    足りるので、暦月で数えたうえで画面側に「目安」と書く。
    """
    if month is None:
        return None

    start = month
    end = _month_end(month)
    rows = [row for row in energy_rows if start <= row["date"] <= end]
    if not rows:
        return None

    kwh = sum(float(row["kwh"]) for row in rows if row.get("kwh") is not None)
    cost = sum(
        value
        for value in (
            energy.resolve_cost(row.get("kwh"), row.get("cost_yen"), unit_price)
            for row in rows
        )
        if value is not None
    )

    share = None
    if electricity_amount_yen and electricity_amount_yen > 0:
        share = round(cost / electricity_amount_yen * 100)

    return {
        "kwh": round(kwh, 1),
        "cost_yen": round(cost),
        "share_percent": share,
        "start": start.isoformat(),
        "end": end.isoformat(),
    }


def build_summary(
    rows: Sequence[Dict[str, Any]],
    energy_rows: Sequence[Dict[str, Any]],
    unit_price: float,
    months: int = DEFAULT_HISTORY_MONTHS,
) -> Dict[str, Any]:
    """カードと詳細パネルが必要とするものをまとめて作る。DBアクセスを含まない。"""
    known_months = sorted({row["billing_month"] for row in rows})
    # 「最新」と「1つ前」は電気・ガスの月で決める。水道は2か月に1回で、検針の月も
    # 電気とずれるため、水道だけの月が最新になると電気の欄が空になってしまう（#750）
    main_months = sorted(
        {row["billing_month"] for row in rows if row["kind"] != KIND_WATER}
    )
    latest_month = main_months[-1] if main_months else None

    # 記録のある月だけを並べる。届いていない月に0円の棒を立てると
    # 「その月は使わなかった」に見えてしまう
    history_months = known_months[-months:] if known_months else []
    history = [_month_payload(month, rows) for month in history_months]

    by_month = {entry["billing_month"]: entry for entry in history}
    main_history = [
        by_month[format_billing_month(month)]
        for month in main_months
        if format_billing_month(month) in by_month
    ]
    latest = main_history[-1] if main_history else None
    previous = main_history[-2] if len(main_history) >= 2 else None
    latest_water = next(
        (entry for entry in reversed(history) if entry["water"] is not None), None
    )

    electricity_amount = (
        latest["electricity"]["amount_yen"]
        if latest and latest.get("electricity")
        else None
    )

    updated_at = max(
        (row["updated_at"] for row in rows if row.get("updated_at") is not None),
        default=None,
    )

    return {
        "latest": latest,
        "latest_water": latest_water,
        "previous": previous,
        "comparison": build_comparison(latest, previous),
        "months": history,
        "total_yen": sum(entry["total_yen"] for entry in history),
        "measured": build_measured(
            energy_rows, latest_month, unit_price, electricity_amount
        ),
        "unit_price": unit_price,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def get_summary(
    db: Optional[Session],
    today: datetime.date,
    months: int = DEFAULT_HISTORY_MONTHS,
) -> Dict[str, Any]:
    unit_price = energy.get_unit_price(db)

    if database.DB_MOCK or db is None:
        rows = database.generate_mock_utility_bills(months)
        energy_rows = database.generate_mock_energy_rows()
    else:
        # 1つ前の月とも比べるので、要求された月数より1か月ぶん多く引く
        start = _shift_months(today.replace(day=1), months)
        rows = _fetch_rows(db, start)
        # 実測との対比は最新の請求月（原則は先月）ぶんだけ要る。
        # 検針のずれを吸収できるよう2か月ぶん引いておく
        energy_rows = energy.fetch_all_rows(
            db, _shift_months(today.replace(day=1), 2), today
        )

    return build_summary(rows, energy_rows, unit_price, months=months)
