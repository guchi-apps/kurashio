"""消費電力の取得元の同一性（Tapoの改名後も履歴を1台として扱う・#768）。

`daily_energy.source` は `tapo:<名前>` で、名前を変えると別の取得元になる。名前もIPも同一機器の
証明にならないので、収集（`collectors/tapo_to_myroom.py`）が機器固有のID（MAC）を `device_id` として
送り、ここで **正規の source** へ寄せる。**保存済みの行は書き換えない**（読むときに読み替える）。
切り戻しは対応表（`energy_links`）を消すだけで、生データは受信したままの形で残っている。

対応表（`app_settings` の `energy_links` 1行。DDLなし・DB_MOCKは `data/energy_links.json`）

    {"devices": {"<device_id>": "<正規 source>"},   # 機器IDの根拠で自動登録
     "links":   {"<別名 source>": "<正規 source>"}}  # 同一機器の根拠（自動）または利用者の確認（手動）

- 別名は常に**正規の側**へ向ける。正規同士は結ばない（連鎖・循環を作らない）。読み替えは念のため
  固定回数で打ち切る
- 自動登録は機器IDが一致するときだけ。同じ名前の別機器（別の `device_id`）は混ざらない
- 旧データ（機器IDなし）は自動では結ばない。利用者が確認して手動で結ぶ

排他: 受信（5分ごと）の自動追記と画面の関連付けが重なるので、保存する操作はすべて `_update()` を通す
（`filament._update()` と同じ形。`ui_settings.save_settings()` の全キー書き戻しには載せない）。
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import atomic_json, database

logger = logging.getLogger(__name__)

FILE_PATH = Path(__file__).resolve().parent.parent / "data" / "energy_links.json"
SETTING_KEY = "energy_links"

#: 読み替えを辿る最大段数。正常なら1段で終わる（別名→正規）
MAX_HOPS = 8

#: 機器IDの最大長（MACを正規化した値の想定。異常に長い値は捨てる）
MAX_DEVICE_ID_LENGTH = 64


class LinkError(ValueError):
    """関連付けとして成立しない指定（向き・循環・自己参照など）。"""


def normalize_device_id(value: Any) -> Optional[str]:
    """MACを `AABBCCDDEEFF` の形へ。区切りを除いた英数字の大文字。読めなければ None。"""
    if not isinstance(value, str):
        return None
    cleaned = "".join(ch for ch in value if ch.isalnum()).upper()
    if not cleaned or len(cleaned) > MAX_DEVICE_ID_LENGTH:
        return None
    return cleaned


def normalize_document(raw: Any) -> Dict[str, Dict[str, str]]:
    """読み込んだ値を `{"devices": {...}, "links": {...}}` の形へ。壊れた項目は落とす。"""
    document: Dict[str, Dict[str, str]] = {"devices": {}, "links": {}}
    if not isinstance(raw, dict):
        return document
    for key in ("devices", "links"):
        section = raw.get(key)
        if not isinstance(section, dict):
            continue
        for name, target in section.items():
            if isinstance(name, str) and isinstance(target, str) and name and target:
                if key == "links" and name == target:
                    continue  # 自己参照は無かったことにする
                document[key][name] = target
    return document


def resolve(document: Dict[str, Dict[str, str]], source: str) -> str:
    """`source` の正規の取得元。対応が無ければそのまま。循環していても `MAX_HOPS` で止まる。"""
    links = document["links"]
    current = source
    for _ in range(MAX_HOPS):
        nxt = links.get(current)
        if nxt is None or nxt == current:
            return current
        current = nxt
    return current


def members(document: Dict[str, Dict[str, str]], source: str) -> List[str]:
    """`source` と同じ機器とみなす取得元すべて（正規を先頭に）。"""
    canonical = resolve(document, source)
    aliases = sorted(
        name for name in document["links"] if resolve(document, name) == canonical
    )
    return [canonical] + [name for name in aliases if name != canonical]


def _check_link(document: Dict[str, Dict[str, str]], alias: str, canonical: str) -> None:
    """`alias → canonical` を足してよいか。だめなら `LinkError`。"""
    if alias == canonical:
        raise LinkError("同じ取得元どうしは関連付けできません")
    if resolve(document, canonical) != canonical:
        raise LinkError("関連付け先は、他の取得元の別名になっていないものを指定してください")
    if any(target == alias for target in document["links"].values()):
        raise LinkError("すでに別の取得元の関連付け先になっています。先にその関連付けを解除してください")
    if alias in document["devices"].values():
        raise LinkError("機器IDで管理している取得元は別名にできません。関連付け先のほうを選んでください")


# --- 保存先 -------------------------------------------------------------------

#: DB経路でプロセス内の並行リクエストを1本ずつにするロック（SQLiteでは行ロックが効かない）
_db_lock = threading.Lock()


def _parse_row(row: Optional[database.AppSetting]) -> Any:
    if row is None:
        return None
    try:
        return json.loads(row.setting_value)
    except (TypeError, ValueError):
        return None


def _lock_row(db: Session) -> database.AppSetting:
    """`energy_links` の行を書き込み用に確保する（`SELECT ... FOR UPDATE`）。"""
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


def get_document(db: Optional[Session] = None) -> Dict[str, Dict[str, str]]:
    """いまの対応表を読む（書き込みはしないのでロックしない）。"""
    if database.DB_MOCK or db is None:
        return normalize_document(atomic_json.read_json(FILE_PATH, None))
    row = (
        db.query(database.AppSetting)
        .filter(database.AppSetting.setting_key == SETTING_KEY)
        .first()
    )
    return normalize_document(_parse_row(row))


def _update(
    db: Optional[Session], mutate: Callable[[Dict[str, Dict[str, str]]], None]
) -> Dict[str, Dict[str, str]]:
    """読み込み・加工・書き戻しを**1つの排他区間**で行い、保存後の内容を返す。

    `mutate` が例外を投げたら何も書かない（行ロックも放す）。
    """

    def apply(raw: Any) -> Dict[str, Dict[str, str]]:
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
            db.rollback()
            raise


# --- 操作 ---------------------------------------------------------------------


def register_devices(db: Optional[Session], pairs: Iterable[Tuple[str, str]]) -> None:
    """受信した `(device_id, source)` を対応表へ反映する（機器IDが一致する改名を自動で結ぶ）。

    - 初めて見る機器ID: 今回の source（すでに別名なら正規）を正規として登録
    - 登録済みで source が違う: 別名として結ぶ。ただし **その名前がすでに別の機器の取得元**
      （別の機器IDの正規、または別の機器の別名）なら結ばない（同名の別機器・名前の使い回しを混ぜない）
    変化が無ければ書き込まない。
    """
    wanted: Dict[str, str] = {}
    for device_id, source in pairs:
        normalized = normalize_device_id(device_id)
        if normalized and source:
            wanted[normalized] = source
    if not wanted:
        return

    def mutate(document: Dict[str, Dict[str, str]]) -> None:
        for device_id, source in wanted.items():
            canonical = document["devices"].get(device_id)
            if canonical is None:
                document["devices"][device_id] = resolve(document, source)
                continue
            if resolve(document, source) == canonical:
                continue
            owner_elsewhere = any(
                other_id != device_id and resolve(document, source) == target
                for other_id, target in document["devices"].items()
            )
            try:
                if owner_elsewhere:
                    raise LinkError("別の機器の取得元です")
                _check_link(document, source, canonical)
            except LinkError as exc:
                logger.warning(
                    "機器ID %s の取得元 %s を %s へ自動では結べませんでした: %s",
                    device_id[-6:], source, canonical, exc,
                )
                continue
            document["links"][source] = canonical

    current = get_document(db)
    # 変化が無い受信（ほとんどの5分ごとの送信）では、ロックも書き込みもしない
    if all(
        current["devices"].get(device_id) is not None
        and resolve(current, source) == current["devices"][device_id]
        for device_id, source in wanted.items()
    ):
        return
    _update(db, mutate)


def link(db: Optional[Session], alias: str, canonical: str) -> Dict[str, Dict[str, str]]:
    """利用者が確認した関連付け（`alias` を `canonical` の別名にする）。"""

    def mutate(document: Dict[str, Dict[str, str]]) -> None:
        _check_link(document, alias, canonical)
        document["links"][alias] = canonical

    return _update(db, mutate)


def unlink(db: Optional[Session], alias: str) -> Dict[str, Dict[str, str]]:
    """関連付けを外す。機器IDで登録した正規の対応（`devices`）は変えない。"""

    def mutate(document: Dict[str, Dict[str, str]]) -> None:
        if alias not in document["links"]:
            raise LinkError("その取得元は関連付けられていません")
        del document["links"][alias]

    return _update(db, mutate)


# --- 行の読み替え -------------------------------------------------------------


def merge_daily_rows(
    rows: Iterable[Dict[str, Any]], document: Dict[str, Dict[str, str]]
) -> List[Dict[str, Any]]:
    """日別の行を正規の取得元へ読み替え、同じ `(日付, 正規)` を1行にする。

    **足し算はしない。** 日別の値は「その日の累計」で、同じ機器の同じ日が旧名・新名の両方に
    あるのは、改名当日や再取得で同じ累計が二重に届いただけ。`updated_at` が新しい行を採り、
    その値が空なら古い行で補う（再実行しても結果は同じ）。別機器は別の正規なので混ざらない。
    `origin` は採った行の元の source（画面の既定名を最新の名前に追従させるため）。
    """
    chosen: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    for row in rows:
        canonical = resolve(document, row["source"])
        key = (row["date"], canonical)
        candidate = dict(row, source=canonical, origin=row["source"])
        current = chosen.get(key)
        if current is None:
            chosen[key] = candidate
            continue
        newer, older = (
            (candidate, current)
            if _stamp(candidate) >= _stamp(current)
            else (current, candidate)
        )
        for field in ("kwh", "cost_yen", "power_w"):
            if newer.get(field) is None and older.get(field) is not None:
                newer[field] = older[field]
        chosen[key] = newer
    return sorted(chosen.values(), key=lambda r: (r["date"], r["source"]))


def _stamp(row: Dict[str, Any]) -> Any:
    updated = row.get("updated_at")
    # updated_at が無い行（モック等）は最も古い扱い
    return (updated is not None, updated or 0)


def merge_reading_rows(
    rows: Iterable[Dict[str, Any]], document: Dict[str, Dict[str, str]]
) -> List[Dict[str, Any]]:
    """時間ごとのスナップショットを正規の取得元へ読み替える。

    各行は「その時刻までの当日累計」なので、旧名と新名の行を1本の時系列に並べれば、
    直前の値を引き継いで差分が出る（足し算はしない）。同じ時刻に両方あれば大きい方を採る。
    """
    by_key: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    for row in rows:
        canonical = resolve(document, row["source"])
        key = (row["recorded_at"], canonical)
        candidate = dict(row, source=canonical)
        current = by_key.get(key)
        if current is None or (candidate.get("kwh") or 0) > (current.get("kwh") or 0):
            by_key[key] = candidate
    return sorted(by_key.values(), key=lambda r: (r["recorded_at"], r["source"]))
