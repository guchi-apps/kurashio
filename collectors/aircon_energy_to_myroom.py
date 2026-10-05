#!/usr/bin/env python3
"""AirCloud Home（白くまくんアプリ）から日別の電力使用量を取り、MyRoom の `/api/energy` へ送る。

サブPCの systemd user timer から1時間ごとに実行する想定（`deployment/subpc/` を参照）。
`/api/energy` は同じ `(date, source)` を上書きするため、当日ぶんを何度送っても二重計上しない。

使い方:
  python3 collectors/aircon_energy_to_myroom.py
  python3 collectors/aircon_energy_to_myroom.py --dry-run --debug
  python3 collectors/aircon_energy_to_myroom.py --date 2026-08-21
  python3 collectors/aircon_energy_to_myroom.py --list-units
  python3 collectors/aircon_energy_to_myroom.py --dump-raw
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence

import requests

# スクリプトとしても（`python3 collectors/...`）、テストからのimportとしても
# `aircloudhome_client` を引けるようにする。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aircloudhome_client import (  # noqa: E402
    AirCloudHomeClient,
    AirCloudHomeError,
    AirCloudHomeRateLimitError,
)

JST = datetime.timezone(datetime.timedelta(hours=9))

DEFAULT_API_URL = "https://myroom.gucchii.com/api/energy"
DEFAULT_SOURCE = "aircon"

#: 既定で送り直す日数。当日ぶんは1日のあいだ増えていくので、前日ぶんも一緒に送って確定させる。
DEFAULT_DAYS = 2

#: 日付ごとにAPIを叩くため、レート制限に当たらないよう間隔を空ける。
REQUEST_INTERVAL_SEC = 2.0


def today_jst() -> datetime.date:
    return datetime.datetime.now(JST).date()


def load_env_file(path: str) -> Dict[str, str]:
    """`KEY=value` 形式を読む簡易パーサ。

    `python-dotenv` はサブPCのシステムPythonに入っていない。ここで要るのは数行の
    `KEY=value` だけなので、依存を増やさず自前で読む。
    """
    values: Dict[str, str] = {}
    if not os.path.isfile(path) or not os.access(path, os.R_OK):
        return values

    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            key, sep, value = line.partition("=")
            if not sep:
                continue
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key:
                values[key] = value
    return values


def apply_env_files(paths: Sequence[str]) -> None:
    """先に挙げたファイルを優先して環境変数へ載せる（既存の環境変数は上書きしない）。"""
    for path in paths:
        for key, value in load_env_file(path).items():
            os.environ.setdefault(key, value)


def target_dates(today: datetime.date, days: int) -> List[datetime.date]:
    """当日から遡って `days` 日ぶんの日付を、古い順に返す。"""
    if days < 1:
        raise ValueError("days must be >= 1")
    return [today - datetime.timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def select_racs(summary: Dict[str, Any], unit: Optional[str]) -> List[Dict[str, Any]]:
    """エネルギー取得APIの応答から、対象のエアコンぶんだけ取り出す。

    `unit` は `racName` か `vendorThingId` のどちらかと一致すればよい（大文字小文字を無視）。
    """
    racs = summary.get("individualRacsData")
    if not isinstance(racs, list):
        raise AirCloudHomeError(
            "Unexpected energy summary response (no 'individualRacsData'). "
            "Run with --dump-raw to inspect it."
        )

    if not unit:
        return racs

    wanted = unit.strip().lower()
    return [
        rac
        for rac in racs
        if str(rac.get("racName") or "").strip().lower() == wanted
        or str(rac.get("vendorThingId") or "").strip().lower() == wanted
    ]


def _sum_field(
    summary: Dict[str, Any],
    unit: Optional[str],
    field: str,
    digits: int,
) -> Optional[float]:
    """対象エアコンの `field` を合計する。1台も値が無ければ None。"""
    total: Optional[float] = None
    for rac in select_racs(summary, unit):
        value = rac.get(field)
        if value is None:
            continue
        try:
            total = (total or 0.0) + float(value)
        except (TypeError, ValueError):
            continue
    return None if total is None else round(total, digits)


def sum_energy(summary: Dict[str, Any], unit: Optional[str] = None) -> Optional[float]:
    """対象エアコンの `energyConsumed`（kWh）を合計する。1台も値が無ければ None。"""
    return _sum_field(summary, unit, "energyConsumed", 3)


def sum_cost(summary: Dict[str, Any], unit: Optional[str] = None) -> Optional[float]:
    """対象エアコンの `cost`（円）を合計する。1台も値が無ければ None。

    エネルギー取得APIは使用量だけでなく金額も返す。MyRoom側で単価を掛けた目安を出すより、
    白くまくんアプリと同じ実額をそのまま送るほうがずれない。

    ただし `currency` が `JPY` 以外なら円ではないので送らない（MyRoomは円で持つ）。
    """
    all_racs = summary.get("allRacsData")
    currency = all_racs.get("currency") if isinstance(all_racs, dict) else None
    if currency is not None and str(currency).upper() != "JPY":
        return None
    return _sum_field(summary, unit, "cost", 2)


def build_payload(records: Sequence[Dict[str, Any]], source: str = DEFAULT_SOURCE) -> Dict[str, Any]:
    return {"source": source, "records": list(records)}


def collect_records(
    client: AirCloudHomeClient,
    family_ids: Sequence[int],
    dates: Sequence[datetime.date],
    unit: Optional[str],
    debug: bool = False,
    sleep: float = REQUEST_INTERVAL_SEC,
) -> List[Dict[str, Any]]:
    """日付ごとに使用量と金額を引き、`/api/energy` の `records` の形にして返す。

    エネルギー取得APIは期間の合計しか返さないため、日別が要るなら1日ずつ引くしかない。
    金額は取得元が返す実額をそのまま載せる（`cost_yen`）。返らなかった日は載せず、
    MyRoom側で単価を掛けた目安になる。
    """
    records: List[Dict[str, Any]] = []
    first = True

    for date in dates:
        daily: Optional[float] = None
        daily_cost: Optional[float] = None
        for family_id in family_ids:
            if not first:
                time.sleep(sleep)
            first = False

            summary = client.get_energy_summary(family_id, date, date)
            value = sum_energy(summary, unit)
            cost = sum_cost(summary, unit)
            if debug:
                print(
                    "fetched: date={} familyId={} kwh={} cost={}".format(
                        date, family_id, value, cost
                    )
                )
            if value is not None:
                daily = (daily or 0.0) + value
            if cost is not None:
                daily_cost = (daily_cost or 0.0) + cost

        if daily is None:
            if debug:
                print("skip: date={} (no energy value)".format(date))
            continue
        record: Dict[str, Any] = {"date": date.isoformat(), "kwh": round(daily, 3)}
        if daily_cost is not None:
            record["cost_yen"] = round(daily_cost, 2)
        records.append(record)

    return records


def post_to_myroom(
    api_url: str,
    payload: Dict[str, Any],
    timeout: int,
    dry_run: bool,
) -> Dict[str, Any]:
    if dry_run:
        print("[dry-run] POST {}".format(api_url))
        print("[dry-run] payload: {}".format(json.dumps(payload, ensure_ascii=False)))
        return {"status": "dry_run", "payload": payload}

    response = requests.post(api_url, json=payload, timeout=timeout)
    response.raise_for_status()
    return response.json()


#: 再取得の依頼（#711）で `/api/energy/refetch/request` へ名乗る収集の名前
REFETCH_KIND = "aircon"

#: 再取得で遡る最大日数。日付ごとにAPIを叩く（間隔2秒）うえレート制限があるので短くする。
#: `backend/energy_refetch.py` の `MAX_DAYS_BY_KIND["aircon"]` と同じ値。
REFETCH_MAX_DAYS = 31


def refetch_url(api_url: str) -> str:
    return api_url.rstrip("/") + "/refetch"


def fetch_refetch_request(api_url: str, timeout: int) -> Optional[Dict[str, Any]]:
    """画面から「指定日以降を再取得」が依頼されていれば、その内容を返す。読めなければ None。"""
    try:
        response = requests.get(
            refetch_url(api_url) + "/request",
            params={"kind": REFETCH_KIND},
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:  # noqa: BLE001 - 依頼を読めなくても通常の収集は続ける
        print("warning: 再取得の依頼を確認できませんでした: {}".format(exc), file=sys.stderr)
        return None
    if not data.get("pending") or not data.get("since") or not data.get("requested_at"):
        return None
    return data


def refetch_days(today: datetime.date, since: str) -> int:
    """依頼の日付から、当日を含めて何日ぶん取り直すか（上限 REFETCH_MAX_DAYS）。"""
    start = datetime.date.fromisoformat(since)
    return max(1, min(REFETCH_MAX_DAYS, (today - start).days + 1))


def report_refetch_done(api_url: str, requested_at: str, timeout: int) -> None:
    """取り直して送れたことを知らせる。失敗しても次回また取り直すだけなので落とさない。"""
    try:
        requests.post(
            refetch_url(api_url) + "/done",
            json={"kind": REFETCH_KIND, "requested_at": requested_at},
            timeout=timeout,
        ).raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print("warning: 再取得の完了を報告できませんでした: {}".format(exc), file=sys.stderr)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AirCloud Home (白くまくん) の日別使用量 -> MyRoom /api/energy"
    )
    parser.add_argument("--email", default=os.getenv("AIRCON_EMAIL", ""))
    parser.add_argument("--password", default=os.getenv("AIRCON_PASSWORD", ""))
    parser.add_argument(
        "--api-url",
        default=os.getenv("MYROOM_ENERGY_API_URL", DEFAULT_API_URL),
        help="MyRoom の受け口URL",
    )
    parser.add_argument(
        "--source",
        default=os.getenv("MYROOM_ENERGY_SOURCE", DEFAULT_SOURCE),
        help="`/api/energy` の source（既定: aircon）",
    )
    parser.add_argument(
        "--unit",
        default=os.getenv("AIRCON_UNIT_NAME", ""),
        help="対象のエアコン名（racName）か vendorThingId。省略時は全台の合計",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=int(os.getenv("ENERGY_DAYS", str(DEFAULT_DAYS))),
        help="当日から遡って送り直す日数（既定: {}）".format(DEFAULT_DAYS),
    )
    parser.add_argument("--date", help="この日だけを送る（YYYY-MM-DD）。--days より優先")
    parser.add_argument(
        "--http-timeout",
        type=int,
        default=int(os.getenv("HTTP_TIMEOUT", "30")),
    )
    parser.add_argument("--debug", action="store_true", help="取得の内訳を表示する")
    parser.add_argument("--dry-run", action="store_true", help="取得のみ。POSTしない")
    parser.add_argument(
        "--list-units",
        action="store_true",
        help="登録されているエアコンを一覧して終了する",
    )
    parser.add_argument(
        "--dump-raw",
        action="store_true",
        help="エネルギー取得APIの未加工の応答（JSON）を表示して終了する",
    )

    args = parser.parse_args(argv)
    if not args.email or not args.password:
        parser.error("AIRCON_EMAIL and AIRCON_PASSWORD are required (env or CLI)")
    return args


def main(argv: Optional[Sequence[str]] = None) -> int:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    apply_env_files(
        [
            os.path.join(script_dir, ".env"),
            os.path.join(os.path.dirname(script_dir), ".env"),
        ]
    )

    try:
        args = parse_args(argv)

        refetch = None
        if args.date:
            dates = [datetime.date.fromisoformat(args.date)]
        else:
            days = args.days
            if not (args.dry_run or args.dump_raw or args.list_units):
                refetch = fetch_refetch_request(args.api_url, args.http_timeout)
            if refetch:
                try:
                    days = max(days, refetch_days(today_jst(), refetch["since"]))
                    print("refetch: {} 以降 {}日ぶん".format(refetch["since"], days))
                except ValueError:
                    refetch = None
            dates = target_dates(today_jst(), days)

        with AirCloudHomeClient(args.email, args.password, timeout=args.http_timeout) as client:
            family_ids = client.get_family_ids()
            if not family_ids:
                print("error: no family found in AirCloud Home account", file=sys.stderr)
                return 1
            if args.debug:
                print("familyIds: {}".format(family_ids))

            if args.dump_raw or args.list_units:
                summary = client.get_energy_summary(family_ids[0], dates[-1], dates[-1])
                if args.dump_raw:
                    print(json.dumps(summary, ensure_ascii=False, indent=2))
                    return 0
                for rac in select_racs(summary, None):
                    print(
                        "vendorThingId={} racName={!r} energyConsumed={}".format(
                            rac.get("vendorThingId"),
                            rac.get("racName"),
                            rac.get("energyConsumed"),
                        )
                    )
                return 0

            records = collect_records(
                client,
                family_ids,
                dates,
                args.unit or None,
                debug=args.debug,
            )

        if not records:
            print("no energy records to send", file=sys.stderr)
            return 1

        print(
            "read: {}".format(
                ", ".join(
                    "{} {}kWh{}".format(
                        r["date"],
                        r["kwh"],
                        "" if r.get("cost_yen") is None else "/{}円".format(r["cost_yen"]),
                    )
                    for r in records
                )
            )
        )
        result = post_to_myroom(
            api_url=args.api_url,
            payload=build_payload(records, args.source),
            timeout=args.http_timeout,
            dry_run=args.dry_run,
        )
        print("posted: {}".format(result))
        if refetch and not args.dry_run:
            # 一部の日付しか送れていないときは依頼を残し、次回の定期実行で再試行する。
            # 0 kWh は有効な取得結果。金額だけの欠損は再取得の完了を妨げない。
            missing_dates = {date.isoformat() for date in dates} - {
                record["date"] for record in records
            }
            if missing_dates:
                print(
                    "warning: 再取得が未完了の日付: {}".format(", ".join(sorted(missing_dates))),
                    file=sys.stderr,
                )
            else:
                report_refetch_done(args.api_url, refetch["requested_at"], args.http_timeout)
        return 0
    except AirCloudHomeRateLimitError as exc:
        # 1時間後の次回実行で取り直せばよいので、詳しく出して終わる。
        print("rate limited: {}".format(exc), file=sys.stderr)
        return 1
    except requests.HTTPError as exc:
        print(
            "API error: {} {}".format(exc.response.status_code, exc.response.text[:300]),
            file=sys.stderr,
        )
        return 1
    except AirCloudHomeError as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - systemdのジャーナルに理由を残す
        print("error: {}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
