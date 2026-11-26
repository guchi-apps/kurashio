"""月ごとの確定請求（`utility_bills`）の保存と集計。

取得元は関西電力「はぴeみる電」が検針のたびに送ってくる
「ご使用量のお知らせ」メール（`collectors/kepco_bill_to_myroom.py`）。
はぴeみる電に公開APIは無く、サイトはCapyのパズル認証と2段階認証で守られているため、
画面を自動で読みに行くのではなく**届いているメールを読む**方式にしている。

`backend/energy.py`（日別の実測）とは意図的に分けている。あちらは機器ごとの使用量で、
こちらは電力会社が確定させた家全体の請求。粒度も出どころも違うので、足し合わせると
二重計上になる。画面では並べて「請求のうちどこまでを機器ごとに追えているか」を出す。

**取れるのは月合計だけ。** 日ごと・時間ごとの使用量はメールに載っていない。
使用期間も載らないので、電気は時間別データの合計が使用量と合うときだけ入れ、
それ以外は画面から手で入れる（#884）。
今月ぶんも検針が終わるまで確定しないため、最新は原則「先月分」になる。
"""

from __future__ import annotations

import datetime
import logging
import math
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import database, energy

logger = logging.getLogger(__name__)

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

    **安全取込（`import_bill`）が出典を記録した行は上書きしない**（#817）。AIDEが先に作った
    確定請求を、日次の収集が同じ契約・月・種別で置き換えると、取込が返した
    `created` / `duplicate` / `conflict` と実DBの内容が食い違うため。取込済みの行を直すのは人。
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
        elif _find_import_for_bill(db, month, kind, contract_key) is not None:
            continue
        row.plan_name = item.get("plan_name")
        row.amount_yen = int(item["amount_yen"])
        row.usage_value = item.get("usage_value")
        row.usage_unit = item.get("usage_unit")
        row.received_at = item.get("received_at")
        row.updated_at = datetime.datetime.utcnow()
        written += 1

    db.commit()
    return written


# ------------------------------------------------ 安全な取込（AIDE・#814）
#
# `upsert_records`（収集）は同じ (月, 種別, 契約) を無言で上書きする。こちらは**書き足すだけ**で、
# 既にある行は絶対に変えない。値が違えば `conflict` として返し、直すかどうかは人が決める。

#: 取込が受ける種別。水道は手入力だけ
IMPORT_KINDS = (KIND_ELECTRICITY, KIND_GAS)
IMPORT_UNITS = {KIND_ELECTRICITY: "kWh", KIND_GAS: "m3"}
CONTRACT_KEY_PATTERN = re.compile(r"^(?:[0-9a-f]{12}|default)$")
MAX_IMPORT_AMOUNT_YEN = 1_000_000
MAX_IMPORT_USAGE = 100_000
#: 使用量の一致は小数1桁の丸め（メールの表記）で見る
USAGE_TOLERANCE = 0.05

STATUS_CREATED = "created"
STATUS_DUPLICATE = "duplicate"
STATUS_CONFLICT = "conflict"

_UNIT_ALIASES = {"kwh": "kWh", "m3": "m3", "m³": "m3", "㎥": "m3"}


def normalize_usage_unit(kind: str, unit: Any) -> Optional[str]:
    """単位の揺れ（`m³`・`㎥`・`M3`・`kwh`）を正規形へ。種別に合わない単位は ValueError。"""
    text = str(unit or "").strip()
    if not text:
        return None
    normalized = _UNIT_ALIASES.get(text.lower())
    if normalized is None or normalized != IMPORT_UNITS[kind]:
        raise ValueError(f"Invalid usage_unit for {kind}: {unit}")
    return normalized


def validate_import(item: Dict[str, Any]) -> Dict[str, Any]:
    """取込の入力を検証して正規化する。誤りは ValueError（API側で422）。"""
    kind = normalize_kind(item.get("kind"), IMPORT_KINDS)
    month = parse_billing_month(item["billing_month"])
    contract_key = str(item.get("contract_key") or "")
    if not CONTRACT_KEY_PATTERN.match(contract_key):
        raise ValueError("Invalid contract_key")
    amount = item.get("amount_yen")
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ValueError("Invalid amount_yen")
    if amount < 0 or amount > MAX_IMPORT_AMOUNT_YEN:
        raise ValueError("Invalid amount_yen")
    usage = item.get("usage_value")
    if usage is not None and (usage < 0 or usage > MAX_IMPORT_USAGE):
        raise ValueError("Invalid usage_value")
    unit = normalize_usage_unit(kind, item.get("usage_unit"))
    if usage is not None and unit is None:
        unit = IMPORT_UNITS[kind]
    if usage is None:
        unit = None
    message_id = str(item.get("source_message_id") or "").strip()
    if not message_id or len(message_id) > 255:
        raise ValueError("Invalid source_message_id")
    confidence = item.get("confidence")
    if confidence is not None and not 0 <= confidence <= 1:
        raise ValueError("Invalid confidence")
    return {
        "billing_month": month,
        "kind": kind,
        "contract_key": contract_key,
        "amount_yen": amount,
        "usage_value": usage,
        "usage_unit": unit,
        "plan_name": (item.get("plan_name") or None),
        "received_at": item.get("received_at"),
        "source_message_id": message_id,
        "source_label": (item.get("source_label") or None),
        "confidence": confidence,
    }


def _iso(value: Optional[datetime.datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def serialize_record(row: Any) -> Dict[str, Any]:
    """照会・取込の応答に載せる請求1件。

    `revision` は `updated_at` のISO文字列。MySQL の DATETIME は小数秒を持たないので、
    同じ秒内の更新は区別できない。将来の更新APIが照合に使うなら粗い点に注意する。
    """
    return {
        "billing_month": format_billing_month(row.billing_month),
        "kind": row.kind,
        "contract_key": row.contract_key,
        "plan_name": row.plan_name,
        "amount_yen": row.amount_yen,
        "usage_value": row.usage_value,
        "usage_unit": row.usage_unit,
        "received_at": _iso(row.received_at),
        "updated_at": _iso(row.updated_at),
        "revision": _iso(row.updated_at),
    }


def serialize_source(imp: Any) -> Optional[Dict[str, Any]]:
    if imp is None:
        return None
    return {
        "source_message_id": imp.source_message_id,
        "source_label": imp.source_label,
        "confidence": imp.confidence,
        "imported_at": _iso(imp.imported_at),
        "import_id": imp.import_id,
    }


def _find_bill(db: Session, month: datetime.date, kind: str, contract_key: str):
    return (
        db.query(database.UtilityBillRecord)
        .filter(
            database.UtilityBillRecord.billing_month == month,
            database.UtilityBillRecord.kind == kind,
            database.UtilityBillRecord.contract_key == contract_key,
        )
        .first()
    )


def _find_import_by_source(db: Session, message_id: str, kind: str, contract_key: str):
    return (
        db.query(database.UtilityBillImport)
        .filter(
            database.UtilityBillImport.source_message_id == message_id,
            database.UtilityBillImport.kind == kind,
            database.UtilityBillImport.contract_key == contract_key,
        )
        .first()
    )


def _find_import_for_bill(db: Session, month: datetime.date, kind: str, contract_key: str):
    return (
        db.query(database.UtilityBillImport)
        .filter(
            database.UtilityBillImport.billing_month == month,
            database.UtilityBillImport.kind == kind,
            database.UtilityBillImport.contract_key == contract_key,
        )
        .order_by(database.UtilityBillImport.import_id.asc())
        .first()
    )


def get_record(
    db: Session,
    kind: str,
    contract_key: str,
    billing_month: Any = None,
    source_message_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """請求1件と出典を引く。月・種別・契約か、出典・種別・契約で。無ければ None。"""
    imp = None
    if billing_month is not None:
        month = parse_billing_month(billing_month)
    else:
        imp = _find_import_by_source(db, source_message_id or "", kind, contract_key)
        if imp is None:
            return None
        month = imp.billing_month
    row = _find_bill(db, month, kind, contract_key)
    if row is None:
        return None
    if imp is None:
        imp = _find_import_for_bill(db, month, kind, contract_key)
    return {"record": serialize_record(row), "source": serialize_source(imp)}


def list_contracts(db: Session, kind: str) -> List[Dict[str, Any]]:
    """契約候補。`utility_bills` の既存行から作る（お客さま番号は持っていないので返さない）。"""
    rows = (
        db.query(database.UtilityBillRecord)
        .filter(database.UtilityBillRecord.kind == kind)
        .order_by(database.UtilityBillRecord.billing_month.desc())
        .all()
    )
    seen: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if row.contract_key == MANUAL_CONTRACT_KEY or row.contract_key in seen:
            continue
        seen[row.contract_key] = {
            "contract_key": row.contract_key,
            "plan_name": row.plan_name,
            "latest_billing_month": format_billing_month(row.billing_month),
        }
    return list(seen.values())


def _same_usage(a: Optional[float], b: Optional[float]) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return math.isclose(a, b, abs_tol=USAGE_TOLERANCE)


def diff_fields(row: Any, item: Dict[str, Any]) -> List[str]:
    """既存行と入力で食い違う主要項目名（金額・使用量・単位）。"""
    fields = []
    if row.amount_yen != item["amount_yen"]:
        fields.append("amount_yen")
    if not _same_usage(row.usage_value, item["usage_value"]):
        fields.append("usage_value")
    if (row.usage_unit or None) != item["usage_unit"] and not (
        row.usage_value is None and item["usage_value"] is None
    ):
        fields.append("usage_unit")
    return fields


def _result(status: str, row: Any, imp: Any, fields: Optional[List[str]] = None):
    result: Dict[str, Any] = {
        "status": status,
        "record": serialize_record(row) if row is not None else None,
        "source": serialize_source(imp),
    }
    if fields is not None:
        result["fields"] = fields
    return result


def import_bill(db: Session, raw: Dict[str, Any]) -> Dict[str, Any]:
    """請求を1件、上書きせずに登録する。判定は上から:

    1. 出典が別の月に結び付いている → conflict
    2. (月, 種別, 契約) の行が無い → 請求行と出典行を1トランザクションで insert → created
    3. 行がある → 主要項目が一致で duplicate、違えば conflict（どちらも何も書かない）

    同時実行で先に書かれたときは主キー／UNIQUE の IntegrityError を rollback して再読込し、
    1・3へ倒す。
    """
    item = validate_import(raw)
    month, kind, key = item["billing_month"], item["kind"], item["contract_key"]
    message_id = item["source_message_id"]

    for _ in range(3):
        imp = _find_import_by_source(db, message_id, kind, key)
        if imp is not None and imp.billing_month != month:
            other = _find_bill(db, imp.billing_month, kind, key)
            return _result(STATUS_CONFLICT, other, imp, ["source"])

        row = _find_bill(db, month, kind, key)
        if row is not None:
            fields = diff_fields(row, item)
            if fields:
                return _result(STATUS_CONFLICT, row, _find_import_for_bill(db, month, kind, key), fields)
            return _result(STATUS_DUPLICATE, row, _find_import_for_bill(db, month, kind, key))

        try:
            now = datetime.datetime.utcnow()
            received_at = item["received_at"]
            if isinstance(received_at, datetime.datetime) and received_at.tzinfo:
                received_at = received_at.astimezone(datetime.timezone.utc).replace(tzinfo=None)
            row = database.UtilityBillRecord(
                billing_month=month,
                kind=kind,
                contract_key=key,
                plan_name=item["plan_name"],
                amount_yen=item["amount_yen"],
                usage_value=item["usage_value"],
                usage_unit=item["usage_unit"],
                received_at=received_at,
                updated_at=now,
            )
            db.add(row)
            if imp is None:
                imp = database.UtilityBillImport(
                    source_message_id=message_id,
                    kind=kind,
                    contract_key=key,
                    billing_month=month,
                    source_label=item["source_label"],
                    confidence=item["confidence"],
                    imported_at=now,
                )
                db.add(imp)
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        return _result(STATUS_CREATED, row, imp)

    raise RuntimeError("bill import kept conflicting with concurrent writes")


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
            "usage_start": row.usage_start,
            "usage_end": row.usage_end,
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


# ------------------------------------------------------------ 使用期間（#884）
#
# `usage_start`・`usage_end` を書くのはここだけ。収集（`upsert_records`）も取込（`import_bill`）も
# 触らないので、入れた期間は日次収集で消えない。

#: 自動で入れる期間の長さ。1か月ぶんの検針期間に収まらないものは候補にしない
AUTO_PERIOD_MIN_DAYS = 25
AUTO_PERIOD_MAX_DAYS = 40
#: 手入力の上限。水道は2か月分をまとめて請求する
MAX_MANUAL_PERIOD_DAYS = 100

Period = Tuple[datetime.date, datetime.date]


def validate_usage_period(
    start: Optional[datetime.date], end: Optional[datetime.date]
) -> None:
    """手入力の期間。両方入れるか、両方空（消去）。誤りは ValueError。"""
    if start is None and end is None:
        return
    if start is None or end is None:
        raise ValueError("Specify both usage_start and usage_end")
    if start > end:
        raise ValueError("usage_start is after usage_end")
    if (end - start).days + 1 > MAX_MANUAL_PERIOD_DAYS:
        raise ValueError("Usage period is too long")


def set_usage_period(
    db: Session,
    billing_month: Any,
    kind: str,
    contract_key: str,
    start: Optional[datetime.date],
    end: Optional[datetime.date],
) -> bool:
    """請求1行の使用期間を書き換える（None で消去）。行が無ければ False。"""
    validate_usage_period(start, end)
    row = _find_bill(db, parse_billing_month(billing_month), kind, contract_key)
    if row is None:
        return False
    row.usage_start = start
    row.usage_end = end
    db.commit()
    return True


def _period_days(period: Period) -> int:
    return (period[1] - period[0]).days + 1


def _stored_batches(db: Session) -> List[Period]:
    """同じ取込時刻の行が、隙間なく24時間ずつ並んでいる範囲。

    抽出対象期間は保存していないので、その代わりに使う。後の取込で一部が上書きされた回は
    行が欠けるか合計が合わなくなり、候補から外れる。
    """
    table = database.KepcoHourlyUsageRecord
    rows = (
        db.query(func.min(table.date), func.max(table.date), func.count())
        .filter(table.imported_at.isnot(None))
        .group_by(table.imported_at)
        .all()
    )
    return [
        (start, end) for start, end, count in rows if count == _period_days((start, end)) * 24
    ]


def _period_total(db: Session, period: Period) -> Optional[float]:
    """期間の時間別kWhの合計。長さが対象外か、1時間でも欠けていれば None。"""
    days = _period_days(period)
    if not AUTO_PERIOD_MIN_DAYS <= days <= AUTO_PERIOD_MAX_DAYS:
        return None
    table = database.KepcoHourlyUsageRecord
    count, total = (
        db.query(func.count(), func.sum(table.kwh))
        .filter(table.date >= period[0], table.date <= period[1])
        .one()
    )
    return float(total) if count == days * 24 else None


def _usage_matches(total: float, usage: float) -> bool:
    """CSVは端数処理前なので、四捨五入して請求の使用量と比べる。"""
    return abs(math.floor(round(total, 3) + 0.5) - usage) < USAGE_TOLERANCE


def fill_usage_periods(db: Session, periods: Optional[Sequence[Period]] = None) -> int:
    """使用期間が空の電気の請求へ、合計が一致する期間を入れる。入れた件数を返す。

    `periods` はCSVの抽出対象期間。省略すると保存済みの取込のまとまりを候補にする。
    条件は、期間の終了日が請求月の中にあり、合計の四捨五入が使用量と一致し、
    期間と請求が1対1であること。**入力済みの期間は変えない。**
    日付をずらして合う期間を探すことはしない（偶然の一致がいくつも出る）。
    """
    candidates = set(periods) if periods is not None else set(_stored_batches(db))
    table = database.UtilityBillRecord
    bill_rows = (
        db.query(table)
        .filter(table.kind == KIND_ELECTRICITY, table.usage_value.isnot(None))
        .all()
    )

    matches = []
    for period in candidates:
        end_month = period[1].replace(day=1)
        in_month = [row for row in bill_rows if row.billing_month == end_month]
        if not in_month:
            continue
        total = _period_total(db, period)
        if total is None:
            continue
        # 入力済みの行も含めて数える（同じ期間が2契約に合うときはどちらにも入れない）
        matched = [row for row in in_month if _usage_matches(total, row.usage_value)]
        if len(matched) == 1:
            matches.append((period, matched[0]))

    targets = []
    for period, row in matches:
        if sum(1 for _, other in matches if other is row) != 1:
            continue
        if row.usage_start is None and row.usage_end is None:
            targets.append((period, row.billing_month, row.contract_key))

    filled = 0
    for period, month, contract_key in targets:
        # 同時に手入力されたぶんを潰さないよう、空欄であることを更新の条件にする
        filled += (
            db.query(table)
            .filter(
                table.billing_month == month,
                table.kind == KIND_ELECTRICITY,
                table.contract_key == contract_key,
                table.usage_start.is_(None),
                table.usage_end.is_(None),
            )
            .update(
                {table.usage_start: period[0], table.usage_end: period[1]},
                synchronize_session=False,
            )
        )
    db.commit()
    return filled


def try_fill_usage_periods(db: Session, periods: Optional[Sequence[Period]] = None) -> None:
    """取込・収集の保存が済んだあとに呼ぶ。失敗しても呼び出し元の結果は変えない。"""
    try:
        filled = fill_usage_periods(db, periods)
    except Exception:
        db.rollback()
        logger.exception("請求の使用期間の自動入力に失敗")
        return
    if filled:
        logger.info("請求の使用期間を%d件入れました", filled)


# --------------------------------------------------------------- 集計（DBを触らない）


def _iso_date(value: Optional[datetime.date]) -> Optional[str]:
    return value.isoformat() if value else None


def _electricity_periods(
    rows: Sequence[Dict[str, Any]], month: Optional[datetime.date]
) -> Optional[List[Period]]:
    """その請求月の電気の使用期間。1行でも期間が無ければ None（暦月で数える）。"""
    items = [
        row for row in rows if row["billing_month"] == month and row["kind"] == KIND_ELECTRICITY
    ]
    if not items or any(
        not row.get("usage_start") or not row.get("usage_end") for row in items
    ):
        return None
    return [(row["usage_start"], row["usage_end"]) for row in items]


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
        # 使用期間は契約ごとに違うので、合算せず請求1行ずつ持つ（#884）
        "bills": [
            {
                "contract_key": item["contract_key"],
                "plan_name": item.get("plan_name"),
                "amount_yen": int(item["amount_yen"]),
                "usage_start": _iso_date(item.get("usage_start")),
                "usage_end": _iso_date(item.get("usage_end")),
            }
            for item in items
        ],
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
    periods: Optional[Sequence[Period]] = None,
) -> Optional[Dict[str, Any]]:
    """請求に対応する期間の実測（エアコン＋スマートプラグ）と、請求に対する割合。

    `periods`（使用期間・#884）があればその日を数える。複数契約なら各期間の日を合わせる。
    無ければ請求月の暦月で数える。請求の対象期間は検針日から検針日までで暦月とはずれるので、
    暦月で数えたぶんは画面側に「目安」と書く。**どちらでも内訳ではない。**
    """
    if month is None:
        return None

    spans = list(periods) if periods else [(month, _month_end(month))]
    start = min(span[0] for span in spans)
    end = max(span[1] for span in spans)
    rows = [
        row for row in energy_rows if any(a <= row["date"] <= b for a, b in spans)
    ]
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
        "by_usage_period": bool(periods),
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
            energy_rows,
            latest_month,
            unit_price,
            electricity_amount,
            _electricity_periods(rows, latest_month),
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
        # 使用期間がさらに前から始まる請求もあるので、そのぶんは広げる
        latest_month = max(
            (row["billing_month"] for row in rows if row["kind"] != KIND_WATER), default=None
        )
        periods = _electricity_periods(rows, latest_month) or []
        energy_start = min(
            [_shift_months(today.replace(day=1), 2)] + [period[0] for period in periods]
        )
        energy_rows = energy.fetch_all_rows(db, energy_start, today)

    return build_summary(rows, energy_rows, unit_price, months=months)
