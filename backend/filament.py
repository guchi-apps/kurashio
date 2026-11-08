"""3Dプリンターのフィラメント（スプール）の在庫と、残量の計算（#445）。

Notion の「3Dプリンター フィラメント在庫」でやっていた計算をアプリへ移したもの。
Notion では「現在の全体重量 − 空スプールの重さ」を手で出していたが、ここでは
**最後の計量を基準にして、そのあとの使用量を引く**。

残量の出し方
------------
    残量 = （最後の計量の全体重量 − 空スプールの重さ） − 計量より後の使用量の合計
    計量がまだ無いとき:  残量 = 初期フィラメント量 − 使用量の合計

- **秤で量ったら、その値が正**になり、それ以前の使用量は数えない（誤差が溜まり続けないため）。
  計量の全体重量が「初期フィラメント量 + 空スプール」を超えても、割合は100%で止める
- **使用量が計量より後かは `(date, recorded_at)` の組で比べる。** 計量した後に前日の印刷を
  入れ忘れて登録しても、その分は計量の値にすでに含まれているので数えない
- 空スプールの重さが未設定なら計量は受けない（残量を出せないため）

MQTT（`backend/bambu.py`）には使用グラム数が無い。使用量は次の2経路で入る。

- **自動（#454）**: サブPCの収集がプリンターSDの3mf（`slice_info.config` の `used_g`）から読み、
  造形の完了・停止の遷移で `record_auto_usage()` が**使用中のスプール**へ記録する。完了は予定値そのまま
  （`source: "auto"`）、停止は進捗率で按分した概算（`"auto_estimate"`）。`job_key` で二重に引かない
- **手入力**: スライサーが出す「フィラメント使用量」を印刷のあとに人が1回入れる（`"manual"`）。
  自動で入らなかった造形（3mfが読めない・使用中のスプールが無い・複数色）の直し方もこれ

保存先
------
**`app_settings` の `filament_spools` 1行。** スプールは数本〜数十本で1行のJSONに収まるため、
DDL（`migrate_db.py`）は要らない（本番のアプリ用DBユーザーにはCREATE権限が無い・#193）。
DB_MOCK のときは `data/filament.json` へ書く（本番は `app_settings`、モックはファイルの二本立て）。

**Notionの既存データは自動では移さない。** 値が古く使い切りも混ざっているため、画面から
登録する。使用中のスプールは、登録時に「いまの全体重量」を入れればその値が最初の計量になる。

排他
----
**保存する操作はすべて `_update()` を通す。** 読み込み・加工・書き戻しを別々に呼ぶと、別の
リクエストの変更を古い内容で上書きして消す（lost update）。1つのドキュメントに全スプールが
入っているので、別のスプールへの操作同士でも起きる。DB_MOCK は `atomic_json.update_json`、
本番は行ロック（`SELECT ... FOR UPDATE`）とプロセス内のロックで囲む。

使用量の履歴は各スプール直近 `MAX_USAGES` 件まで。溢れたときは、計量に含まれていて
残量に影響しない古い記録から落とし、それでも溢れるなら追加を断る（残量が狂うため）。
"""

from __future__ import annotations

import datetime
import json
import re
import secrets
import threading
import unicodedata
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import atomic_json, database

JST = datetime.timezone(datetime.timedelta(hours=9))

FILE_PATH = Path(__file__).resolve().parent.parent / "data" / "filament.json"

#: app_settings のキー。スプールと「使用中」の指定をまとめて1行に持つ
SETTING_KEY = "filament_spools"

#: Notion の「素材」と同じ選択肢。知らない値は「その他」へ倒す
MATERIALS = ("PLA", "PETG", "ABS", "TPU", "その他")

#: 使用量の記録の出どころ。`auto` は造形の完了、`auto_estimate` は途中停止の概算（#454）
USAGE_SOURCES = ("manual", "auto", "auto_estimate")

#: 1本あたりの既定の中身（1kgスプール）
DEFAULT_NET_G = 1000.0

MAX_SPOOLS = 50
MAX_USAGES = 200
MAX_WEIGHINGS = 30
MAX_NAME_LENGTH = 60
MAX_NOTE_LENGTH = 60

#: 重さの範囲（g）。超えるのは入力の桁間違いとして弾く
MAX_NET_G = 10000.0
MAX_TARE_G = 2000.0
MAX_GROSS_G = 12000.0
MAX_USAGE_G = 5000.0

#: 残量がこの割合（%）を下回ったら「残りわずか」
LOW_PERCENT = 10

_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


class FilamentError(ValueError):
    """入力を受けられないとき。メッセージはそのまま画面へ出す。"""


class SpoolNotFound(LookupError):
    """指定されたスプールが無い。"""


# --- 値の読み取り -------------------------------------------------------------


def get_today_jst() -> datetime.date:
    return datetime.datetime.now(JST).date()


def get_now_jst() -> datetime.datetime:
    """登録日時に入れる「いま」。秒より細かい値は要らないので落とす。"""
    return datetime.datetime.now(JST).replace(microsecond=0)


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(unicodedata.normalize("NFKC", value).split())[:limit]


def _number(value: Any, low: float, high: float) -> Optional[float]:
    """`low` 以上 `high` 以下の数値だけを返す（真偽値・NaN・範囲外は None）。小数1桁へ丸める。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    if number != number or number < low or number > high:
        return None
    return round(number, 1)


def _parse_date(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def _parse_recorded_at(value: Any) -> str:
    """登録日時。読めないときは空文字（並べ替えでいちばん古い扱い）。"""
    if not isinstance(value, str) or not value:
        return ""
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST).isoformat(timespec="seconds")


def _new_id(prefix: str) -> str:
    return f"{prefix}{secrets.token_hex(4)}"


def _unique_id(raw: Any, prefix: str, used: set) -> str:
    candidate = _clean_text(raw, 64)
    while not candidate or candidate in used:
        candidate = _new_id(prefix)
    used.add(candidate)
    return candidate


# --- 正規化 -------------------------------------------------------------------


def _normalize_weighings(raw: Any) -> List[Dict[str, Any]]:
    used: set = set()
    entries: List[Dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        date = _parse_date(item.get("date"))
        gross = _number(item.get("gross_g"), 0, MAX_GROSS_G)
        if date is None or gross is None:
            continue
        entries.append(
            {
                "id": _unique_id(item.get("id"), "w", used),
                "date": date,
                "gross_g": gross,
                "recorded_at": _parse_recorded_at(item.get("recorded_at")),
            }
        )
    entries.sort(key=lambda entry: (entry["date"], entry["recorded_at"]))
    return entries[-MAX_WEIGHINGS:]


def _normalize_usages(raw: Any) -> List[Dict[str, Any]]:
    used: set = set()
    entries: List[Dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        date = _parse_date(item.get("date"))
        grams = _number(item.get("grams"), 0.1, MAX_USAGE_G)
        if date is None or grams is None:
            continue
        entries.append(
            {
                "id": _unique_id(item.get("id"), "u", used),
                "date": date,
                "grams": grams,
                "note": _clean_text(item.get("note"), MAX_NOTE_LENGTH),
                "recorded_at": _parse_recorded_at(item.get("recorded_at")),
                # 古い記録には無い。無ければ手入力として読む（移行は要らない）
                "source": item.get("source") if item.get("source") in USAGE_SOURCES else "manual",
                "job_key": _clean_text(item.get("job_key"), 200) or None,
            }
        )
    entries.sort(key=lambda entry: (entry["date"], entry["recorded_at"]))
    return entries


def _normalize_material(value: Any) -> str:
    text = _clean_text(value, 20)
    return text if text in MATERIALS else "その他"


def _normalize_color(value: Any) -> Optional[str]:
    text = _clean_text(value, 7)
    return text.upper() if _COLOR_PATTERN.match(text) else None


def _normalize_spool(raw: Any, used_ids: set) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    name = _clean_text(raw.get("name"), MAX_NAME_LENGTH)
    if not name:
        return None
    net = _number(raw.get("net_g"), 1, MAX_NET_G)
    return {
        "id": _unique_id(raw.get("id"), "s", used_ids),
        "name": name,
        "material": _normalize_material(raw.get("material")),
        "color": _normalize_color(raw.get("color")),
        "purchased_on": _parse_date(raw.get("purchased_on")),
        "net_g": net if net is not None else DEFAULT_NET_G,
        "tare_g": _number(raw.get("tare_g"), 0, MAX_TARE_G),
        "archived": bool(raw.get("archived")),
        "weighings": _normalize_weighings(raw.get("weighings")),
        "usages": _normalize_usages(raw.get("usages")),
    }


def normalize_document(raw: Any) -> Dict[str, Any]:
    """保存された内容（もしくは壊れた内容）を `{"active_id", "spools"}` へ整える。

    使用中のスプールが消えている・使い切りになっているときは、使用中を外す
    （残っていない値を「いま使っている」と見せないため）。
    """
    source = raw if isinstance(raw, dict) else {}
    used_ids: set = set()
    spools: List[Dict[str, Any]] = []
    for item in source.get("spools") or []:
        spool = _normalize_spool(item, used_ids)
        if spool is not None:
            spools.append(spool)
        if len(spools) >= MAX_SPOOLS:
            break

    active_id = _clean_text(source.get("active_id"), 64)
    active = next((spool for spool in spools if spool["id"] == active_id), None)
    if active is None or active["archived"]:
        active_id = ""
    return {"active_id": active_id or None, "spools": spools}


# --- 残量の計算 ---------------------------------------------------------------


def latest_weighing(spool: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """残量の基準にする計量。空スプールの重さが分からないときは基準にできない。"""
    if spool.get("tare_g") is None or not spool.get("weighings"):
        return None
    # 日付・登録時刻が同じなら、あとに入れたほうを新しいとみなす（整列は安定なので末尾が最新）
    ordered = sorted(spool["weighings"], key=lambda entry: (entry["date"], entry["recorded_at"]))
    return ordered[-1]


def is_counted(usage: Dict[str, Any], weighing: Optional[Dict[str, Any]]) -> bool:
    """この使用量を残量から引くか。基準の計量より後のものだけ引く。

    同じ日の前後は、登録した時刻で決める。印刷した時刻は持っていないので、同じ日のうちに
    「印刷 → 計量 → 印刷の入力」の順で登録すると二重に引くことがある。その日の値が気になるときは
    計量し直せば、その値が基準になる。
    """
    if weighing is None:
        return True
    return (usage["date"], usage["recorded_at"]) >= (weighing["date"], weighing["recorded_at"])


def weighing_net_g(spool: Dict[str, Any], weighing: Dict[str, Any]) -> float:
    """計量した全体重量から空スプールを引いた、その時点のフィラメント量。0を下回らない。"""
    return max(round(weighing["gross_g"] - (spool.get("tare_g") or 0.0), 1), 0.0)


def compute_remaining(spool: Dict[str, Any]) -> Dict[str, Any]:
    """残量（g・%）と、その根拠（基準・引いた使用量）を返す。"""
    weighing = latest_weighing(spool)
    if weighing is not None:
        base_g = weighing_net_g(spool, weighing)
        base = {
            "kind": "weighing",
            "gross_g": weighing["gross_g"],
            "net_g": base_g,
            "date": weighing["date"],
        }
    else:
        base_g = spool["net_g"]
        base = {"kind": "initial", "gross_g": None, "net_g": base_g, "date": None}

    counted = [usage for usage in spool["usages"] if is_counted(usage, weighing)]
    used_g = round(sum(usage["grams"] for usage in counted), 1)
    remaining = max(round(base_g - used_g, 1), 0.0)

    percent = int(round(min(remaining / spool["net_g"], 1.0) * 100))
    if remaining <= 0:
        level = "empty"
    elif percent < LOW_PERCENT:
        level = "low"
    else:
        level = "ok"
    return {
        "remaining_g": remaining,
        "percent": percent,
        "level": level,
        "base": base,
        "used_since_g": used_g,
        "used_since_count": len(counted),
    }


def build_spool_view(spool: Dict[str, Any], *, active: bool) -> Dict[str, Any]:
    """画面が必要とする残量・内訳・履歴まで含めた1本分。履歴は新しい順。"""
    weighing = latest_weighing(spool)
    computed = compute_remaining(spool)
    weighings = [
        {
            **entry,
            "net_g": weighing_net_g(spool, entry) if spool.get("tare_g") is not None else None,
        }
        for entry in reversed(spool["weighings"])
    ]
    usages = [
        {**entry, "counted": is_counted(entry, weighing)} for entry in reversed(spool["usages"])
    ]
    return {
        "id": spool["id"],
        "name": spool["name"],
        "material": spool["material"],
        "color": spool["color"],
        "purchased_on": spool["purchased_on"],
        "net_g": spool["net_g"],
        "tare_g": spool["tare_g"],
        "archived": spool["archived"],
        "active": active,
        **computed,
        "weighings": weighings,
        "usages": usages,
    }


def build_payload(
    document: Dict[str, Any], today: Optional[datetime.date] = None
) -> Dict[str, Any]:
    """`GET /api/filament` が返す形。使い切りは末尾へ寄せ、それ以外は保存順のまま。

    `today` は日付入力の初期値と上限に使う。端末の時計ではなくサーバー（JST）の今日を返す。
    """
    today = today or get_today_jst()
    active_id = document["active_id"]
    views = [
        build_spool_view(spool, active=spool["id"] == active_id) for spool in document["spools"]
    ]
    views.sort(key=lambda view: view["archived"])
    return {
        "today": today.isoformat(),
        "configured": len(views) > 0,
        "active_id": active_id,
        "low_percent": LOW_PERCENT,
        "spools": views,
    }


# --- 保存先 -------------------------------------------------------------------


#: DB経路でプロセス内の並行リクエストを1本ずつにするロック。行ロック（`FOR UPDATE`）が効かない
#: DB（テストのSQLite）でも、同じプロセスの中では読み→書きが重ならないようにする
_db_lock = threading.Lock()


def _parse_row(row: Optional[database.AppSetting]) -> Any:
    if row is None:
        return None
    try:
        return json.loads(row.setting_value)
    except (TypeError, ValueError):
        return None


def _lock_row(db: Session) -> database.AppSetting:
    """`filament_spools` の行を書き込み用に確保する（`SELECT ... FOR UPDATE`）。

    行がまだ無い最初の1回だけ、空の行を作ってから取り直す。同時に作ろうとして主キー違反に
    なった側は、作り直さず相手が作った行を取りに行く。
    """
    query = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .with_for_update()
    )
    row = query.first()
    if row is None:
        try:
            db.add(database.AppSetting(setting_key=SETTING_KEY, setting_value="{}"))
            db.commit()
        except IntegrityError:
            db.rollback()
        row = query.first()
    assert row is not None
    return row


def get_document(db: Optional[Session] = None) -> Dict[str, Any]:
    """いまの内容を読む（書き込みはしないのでロックしない）。"""
    if database.DB_MOCK or db is None:
        return normalize_document(atomic_json.read_json(FILE_PATH, None))
    row = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .first()
    )
    return normalize_document(_parse_row(row))


def _update(
    db: Optional[Session], mutate: Callable[[Dict[str, Any]], None]
) -> Dict[str, Any]:
    """読み込み・加工・書き戻しを**1つの排他区間**で行い、保存後の内容を返す。

    `mutate` は読み込んだ内容をその場で書き換える。入力の誤りは例外で返し、その場合は
    何も書かない（ロックも放す）。読み込みと書き戻しを別々に呼ぶと、別のリクエストの変更を
    古い内容で上書きして消す（lost update）。全操作をここへ通すのはそのため。

    - DB_MOCK: `atomic_json.update_json`（プロセス内のロックと `.lock` ファイルの `flock`）
    - 本番: プロセス内のロックと、行ロック（`FOR UPDATE`）で読み込みから `commit` までを囲む
    """

    def apply(raw: Any) -> Dict[str, Any]:
        document = normalize_document(raw)
        mutate(document)
        return normalize_document(document)

    if database.DB_MOCK or db is None:
        return atomic_json.update_json(FILE_PATH, None, apply)

    with _db_lock:
        try:
            row = _lock_row(db)
            document = apply(_parse_row(row))
            row.setting_value = json.dumps(document, ensure_ascii=False)
            db.commit()
            return document
        except BaseException:
            # 例外のまま抜けると行ロックが残り、次のリクエストがロック待ちで止まる
            db.rollback()
            raise


# --- 操作 ---------------------------------------------------------------------


def _find(document: Dict[str, Any], spool_id: str) -> Dict[str, Any]:
    for spool in document["spools"]:
        if spool["id"] == spool_id:
            return spool
    raise SpoolNotFound("指定されたスプールが見つかりません")


def _check_date(value: Optional[str], today: datetime.date) -> str:
    """日付を受ける。未指定は今日、読めない値と未来の日は断る（黙って捨てると「増えない」に見える）。"""
    if not value:
        return today.isoformat()
    parsed = _parse_date(value)
    if parsed is None:
        raise FilamentError("日付は YYYY-MM-DD で指定してください")
    if parsed > today.isoformat():
        raise FilamentError("未来の日付は指定できません")
    return parsed


def _weighing_entry(gross_g: float, date: str, now: datetime.datetime) -> Dict[str, Any]:
    return {
        "id": _new_id("w"),
        "date": date,
        "gross_g": gross_g,
        "recorded_at": now.isoformat(timespec="seconds"),
    }


def _require_gross(value: Any) -> float:
    gross = _number(value, 0, MAX_GROSS_G)
    if gross is None:
        raise FilamentError(f"全体重量は0〜{int(MAX_GROSS_G)}gの数値で入力してください")
    return gross


def add_spool(
    fields: Dict[str, Any],
    db: Optional[Session] = None,
    *,
    today: Optional[datetime.date] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """スプールを1本足す。`current_gross_g` があれば、それを最初の計量として記録する。

    使いかけのスプールを登録するときのための項目。空スプールの重さが要る。
    最初の1本（使用中がまだ無いとき）は自動で使用中にする。
    """
    today = today or get_today_jst()
    now = now or get_now_jst()

    # 入力の検証は保存済みの内容に依らないので、ロックを取る前に済ませる
    name = _clean_text(fields.get("name"), MAX_NAME_LENGTH)
    if not name:
        raise FilamentError("名前を入力してください")
    net = _number(fields.get("net_g"), 1, MAX_NET_G) if fields.get("net_g") is not None else DEFAULT_NET_G
    if net is None:
        raise FilamentError(f"初期フィラメント量は1〜{int(MAX_NET_G)}gで入力してください")
    tare = None
    if fields.get("tare_g") is not None:
        tare = _number(fields.get("tare_g"), 0, MAX_TARE_G)
        if tare is None:
            raise FilamentError(f"空スプールの重さは0〜{int(MAX_TARE_G)}gで入力してください")

    weighings: List[Dict[str, Any]] = []
    if fields.get("current_gross_g") is not None:
        if tare is None:
            raise FilamentError("いまの全体重量を入れるには、空スプールの重さも必要です")
        weighings.append(_weighing_entry(_require_gross(fields.get("current_gross_g")), today.isoformat(), now))

    purchased_on = None
    if fields.get("purchased_on"):
        purchased_on = _check_date(fields.get("purchased_on"), today)

    def mutate(document: Dict[str, Any]) -> None:
        if len(document["spools"]) >= MAX_SPOOLS:
            raise FilamentError(f"スプールは{MAX_SPOOLS}本までです")
        spool = {
            "id": _new_id("s"),
            "name": name,
            "material": _normalize_material(fields.get("material")),
            "color": _normalize_color(fields.get("color")),
            "purchased_on": purchased_on,
            "net_g": net,
            "tare_g": tare,
            "archived": False,
            "weighings": weighings,
            "usages": [],
        }
        document["spools"].append(spool)
        if document["active_id"] is None:
            document["active_id"] = spool["id"]

    return _update(db, mutate)


def update_spool(
    spool_id: str,
    fields: Dict[str, Any],
    db: Optional[Session] = None,
    *,
    today: Optional[datetime.date] = None,
) -> Dict[str, Any]:
    """名前・素材・色・購入日・初期量・空スプールの重さ・使い切りを直す（送られた項目だけ）。

    使い切り（`archived`）にしたスプールは使用中から外す。
    """
    today = today or get_today_jst()

    def mutate(document: Dict[str, Any]) -> None:
        spool = _find(document, spool_id)
        if "name" in fields:
            name = _clean_text(fields["name"], MAX_NAME_LENGTH)
            if not name:
                raise FilamentError("名前を入力してください")
            spool["name"] = name
        if "material" in fields:
            spool["material"] = _normalize_material(fields["material"])
        if "color" in fields:
            spool["color"] = _normalize_color(fields["color"])
        if "purchased_on" in fields:
            spool["purchased_on"] = (
                _check_date(fields["purchased_on"], today) if fields["purchased_on"] else None
            )
        if "net_g" in fields:
            net = _number(fields["net_g"], 1, MAX_NET_G)
            if net is None:
                raise FilamentError(f"初期フィラメント量は1〜{int(MAX_NET_G)}gで入力してください")
            spool["net_g"] = net
        if "tare_g" in fields:
            if fields["tare_g"] is None:
                spool["tare_g"] = None
            else:
                tare = _number(fields["tare_g"], 0, MAX_TARE_G)
                if tare is None:
                    raise FilamentError(f"空スプールの重さは0〜{int(MAX_TARE_G)}gで入力してください")
                spool["tare_g"] = tare
        if "archived" in fields:
            spool["archived"] = bool(fields["archived"])
            if spool["archived"] and document["active_id"] == spool["id"]:
                document["active_id"] = None

    return _update(db, mutate)


def set_active(spool_id: Optional[str], db: Optional[Session] = None) -> Dict[str, Any]:
    """いま使っているスプールを選ぶ（None で外す）。使い切りは選べない。"""

    def mutate(document: Dict[str, Any]) -> None:
        if spool_id is None:
            document["active_id"] = None
            return
        spool = _find(document, spool_id)
        if spool["archived"]:
            raise FilamentError("使い切りのスプールは使用中にできません")
        document["active_id"] = spool["id"]

    return _update(db, mutate)


def delete_spool(spool_id: str, db: Optional[Session] = None) -> Dict[str, Any]:
    def mutate(document: Dict[str, Any]) -> None:
        _find(document, spool_id)
        document["spools"] = [spool for spool in document["spools"] if spool["id"] != spool_id]
        if document["active_id"] == spool_id:
            document["active_id"] = None

    return _update(db, mutate)


def record_weighing(
    spool_id: str,
    gross_g: Any,
    db: Optional[Session] = None,
    *,
    date: Optional[str] = None,
    today: Optional[datetime.date] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """秤で量った全体重量を記録する。以後の残量はこの値が基準になる。"""
    today = today or get_today_jst()
    now = now or get_now_jst()
    gross = _require_gross(gross_g)
    weighed_on = _check_date(date, today)

    def mutate(document: Dict[str, Any]) -> None:
        spool = _find(document, spool_id)
        if spool["tare_g"] is None:
            raise FilamentError("計量には空スプールの重さが必要です。先にスプールの設定で入力してください")
        spool["weighings"] = [*spool["weighings"], _weighing_entry(gross, weighed_on, now)]

    return _update(db, mutate)


def remove_weighing(spool_id: str, weighing_id: str, db: Optional[Session] = None) -> Dict[str, Any]:
    def mutate(document: Dict[str, Any]) -> None:
        spool = _find(document, spool_id)
        kept = [entry for entry in spool["weighings"] if entry["id"] != weighing_id]
        if len(kept) == len(spool["weighings"]):
            raise SpoolNotFound("指定された計量の記録が見つかりません")
        spool["weighings"] = kept

    return _update(db, mutate)


def record_usage(
    spool_id: str,
    grams: Any,
    db: Optional[Session] = None,
    *,
    date: Optional[str] = None,
    note: Optional[str] = None,
    today: Optional[datetime.date] = None,
    now: Optional[datetime.datetime] = None,
) -> Dict[str, Any]:
    """印刷で使った量（スライサーが出すg数）を記録する。"""
    today = today or get_today_jst()
    now = now or get_now_jst()
    used = _number(grams, 0.1, MAX_USAGE_G)
    if used is None:
        raise FilamentError(f"使った量は0.1〜{int(MAX_USAGE_G)}gの数値で入力してください")
    used_on = _check_date(date, today)

    def mutate(document: Dict[str, Any]) -> None:
        spool = _find(document, spool_id)
        _append_usage(spool, _usage_entry(used, used_on, note, now))

    return _update(db, mutate)


def _usage_entry(
    grams: float,
    date: str,
    note: Optional[str],
    now: datetime.datetime,
    *,
    source: str = "manual",
    job_key: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": _new_id("u"),
        "date": date,
        "grams": grams,
        "note": _clean_text(note, MAX_NOTE_LENGTH),
        "recorded_at": now.isoformat(timespec="seconds"),
        "source": source,
        "job_key": job_key,
    }


def _append_usage(spool: Dict[str, Any], entry: Dict[str, Any]) -> None:
    usages = [*spool["usages"], entry]
    if len(usages) > MAX_USAGES:
        # 計量に含まれていて残量に効かない古い記録から落とす。効く記録は落とせない
        weighing = latest_weighing(spool)
        droppable = [item for item in usages if not is_counted(item, weighing)]
        overflow = len(usages) - MAX_USAGES
        if len(droppable) < overflow:
            raise FilamentError("使用量の記録が多すぎます。いちど計量して基準を取り直してください")
        drop_ids = {item["id"] for item in droppable[:overflow]}
        usages = [item for item in usages if item["id"] not in drop_ids]
    spool["usages"] = usages


def record_auto_usage(
    grams: Any,
    job_key: str,
    job_name: Optional[str],
    db: Optional[Session] = None,
    *,
    estimated: bool = False,
    today: Optional[datetime.date] = None,
    now: Optional[datetime.datetime] = None,
) -> str:
    """造形の完了・停止で、使用中のスプールへ使用量を記録する（#454）。

    3Dプリンターの状態を受けたバックエンド（`bambu.detect_filament_usage()`）から呼ばれる。
    画面の操作ではないので、記録できない理由は例外ではなく戻り値で返す（呼び出し側は状態の保存を
    止めない）。戻り値:

    - `"recorded"` — 記録した
    - `"duplicate"` — 同じ `job_key` の記録がすでにある（どのスプールでも）。二重に引かない
    - `"no_active_spool"` — 使用中のスプールが無い。引く先が決まらないので何もしない
    - `"too_many_usages"` — 使用量の記録が上限で、効いている記録を落とせない
    - `"invalid"` — 使用量が範囲外

    **使用中のスプールは書き込みの排他区間の中で決める。** 読んでから選ぶと、そのあいだに
    使用中が切り替わって別のスプールから引く。
    """
    today = today or get_today_jst()
    now = now or get_now_jst()
    used = _number(grams, 0.1, MAX_USAGE_G)
    key = _clean_text(job_key, 200)
    if used is None or not key:
        return "invalid"

    outcome = "recorded"

    def mutate(document: Dict[str, Any]) -> None:
        nonlocal outcome
        if any(
            usage.get("job_key") == key for spool in document["spools"] for usage in spool["usages"]
        ):
            outcome = "duplicate"
            return
        active_id = document["active_id"]
        if active_id is None:
            outcome = "no_active_spool"
            return
        spool = _find(document, active_id)
        entry = _usage_entry(
            used,
            today.isoformat(),
            job_name,
            now,
            source="auto_estimate" if estimated else "auto",
            job_key=key,
        )
        try:
            _append_usage(spool, entry)
        except FilamentError:
            outcome = "too_many_usages"

    _update(db, mutate)
    return outcome


def remove_usage(spool_id: str, usage_id: str, db: Optional[Session] = None) -> Dict[str, Any]:
    """使用量の記録を1件取り消す。入力を間違えたときの直し方はこれ1つ（消して入れ直す）。"""

    def mutate(document: Dict[str, Any]) -> None:
        spool = _find(document, spool_id)
        kept = [entry for entry in spool["usages"] if entry["id"] != usage_id]
        if len(kept) == len(spool["usages"]):
            raise SpoolNotFound("指定された使用量の記録が見つかりません")
        spool["usages"] = kept

    return _update(db, mutate)
