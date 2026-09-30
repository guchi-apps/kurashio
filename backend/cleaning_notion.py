"""次の掃除を Notion の Task データベースへ書き出す。

`backend/garbage_notion.py` と同じ考え方で、掃除の正はあくまで myroom 側
（`backend/cleaning.py`）。Notion 側は書き換えられても次の同期で戻る。目的は
DaySpan・AIDE が読むタスク一覧に「次の掃除」を並べることで、掃除の管理そのものを
Notion へ移すことではない。

**書き出すのは場所ごとに「次の1件」だけ。** 先の予定まで並べるとタスク一覧が
掃除で埋まり、本来のタスクが見えなくなる。

**myroom が書いたページかどうかは multi_select「タグ」に「掃除」が入っているかで判断する。**
ゴミの日の書き出し先には目印用の select「種類」があったが、Task データベースには
無いため、既存のタグへ1つ足して目印にする。これが無いと手で作ったタスクと区別できず、
不要になったページを片付けられない。

Notion 側でタスクを「完了」にすると、次の同期でその掃除を実施済みとして myroom へ
記録する（読み戻し）。**実施日は同期した日**で、チェックを入れた瞬間は分からない。
同期は1時間ごとなので実用上のずれは小さい。

手動で試すときは `python -m backend.cleaning_notion --dry-run` を実行する。
"""

from __future__ import annotations

import argparse
import datetime
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from sqlalchemy.orm import Session

from . import cleaning, database, notion_api

load_dotenv()

logger = logging.getLogger(__name__)

#: Notion のインテグレーショントークン。未設定なら書き出しを行わない。
#: ゴミの日と同じトークンを入れてよいが、Task データベース側にもそのインテグレーションを
#: 接続しておく必要がある（Notion の権限はページ単位のため）。
ENV_TOKEN = "CLEANING_NOTION_TOKEN"
#: 書き出し先のデータソースID（database_id ではない。notion_api の説明を参照）
ENV_DATA_SOURCE_ID = "CLEANING_NOTION_DATA_SOURCE_ID"

#: タイトルの頭に付ける。タスク一覧で他のタスクと見分けるためと、照合キーにするため
TITLE_PREFIX = "掃除: "

#: 「タグ」へ入れる値。myroom が書いたページの目印になる
TAG_VALUE = "掃除"

#: やることをメモ欄へ並べるときの区切り
MEMO_SEPARATOR = "／"

#: フィールド名 → Notion のプロパティ型。この3つが揃わなければ同期しない
REQUIRED_FIELD_TYPES: Tuple[Tuple[str, str], ...] = (
    ("title", "title"),
    ("date", "date"),
    ("tag", "multi_select"),
)

#: Notion 側の既定のプロパティ名。名前を変えている場合はここを直す
PROPERTY_NAMES: Dict[str, str] = {
    "title": "タイトル",
    "date": "期限",
    "tag": "タグ",
    "memo": "メモ",
    "done": "完了",
}


# --- 書き出す内容 -------------------------------------------------------------


def build_title(task: Dict[str, Any]) -> str:
    return f"{TITLE_PREFIX}{task['name']}"


def build_memo(task: Dict[str, Any]) -> str:
    parts = [f"{task['interval_days']}日ごと", *task["steps"]]
    return MEMO_SEPARATOR.join(parts)


def build_entries(
    tasks: List[Dict[str, Any]],
    today: datetime.date,
) -> List[Dict[str, str]]:
    """Notion に在るべきページの一覧。場所ごとに次の1件。"""
    return [
        {
            "title": build_title(task),
            "date": cleaning.next_due(task, today).isoformat(),
            "memo": build_memo(task),
        }
        for task in tasks
    ]


# --- Notion のプロパティ ------------------------------------------------------


def _find_property(
    properties: Dict[str, Any],
    wanted_name: str,
    wanted_type: str,
) -> Optional[str]:
    """設定した名前で当て、外れたら型が1つに絞れるときだけ自動で決める。

    Task データベースには日付型のプロパティが「期限」「予定日」の2つあるため、
    date は名前が当たらないと決まらない（絞れなければ None を返して中止する）。
    """
    prop = properties.get(wanted_name)
    if isinstance(prop, dict) and prop.get("type") == wanted_type:
        return wanted_name

    candidates = [
        name
        for name, definition in properties.items()
        if isinstance(definition, dict) and definition.get("type") == wanted_type
    ]
    return candidates[0] if len(candidates) == 1 else None


def resolve_properties(schema: Any) -> Tuple[Dict[str, str], List[str]]:
    """データソースの定義から、書き込みに使うプロパティ名を決める。

    戻り値は（フィールド名 → プロパティ名, エラーの一覧）。エラーが1つでもあれば
    呼び出し側は同期を中止する（一部だけ書くと後片付けができなくなるため）。
    """
    properties = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(properties, dict):
        return {}, ["データソースのプロパティ定義を読み取れませんでした"]

    resolved: Dict[str, str] = {}
    errors: List[str] = []

    for field, wanted_type in REQUIRED_FIELD_TYPES:
        name = _find_property(properties, PROPERTY_NAMES[field], wanted_type)
        if name is None:
            errors.append(
                f"{wanted_type} 型のプロパティ「{PROPERTY_NAMES[field]}」が特定できません"
            )
        else:
            resolved[field] = name

    # メモと完了は無くても「次の掃除を出す」ことは成立するので任意扱い
    for field, wanted_type in (("memo", "rich_text"), ("done", "checkbox")):
        name = _find_property(properties, PROPERTY_NAMES[field], wanted_type)
        if name:
            resolved[field] = name

    return resolved, errors


def to_notion_properties(
    entry: Dict[str, str],
    resolved: Dict[str, str],
    existing_tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """書き込むプロパティ。既存ページのタグは目印以外を残す。"""
    tags = [TAG_VALUE, *[tag for tag in (existing_tags or []) if tag != TAG_VALUE]]
    properties: Dict[str, Any] = {
        resolved["title"]: {"title": [{"text": {"content": entry["title"]}}]},
        resolved["date"]: {"date": {"start": entry["date"]}},
        resolved["tag"]: {"multi_select": [{"name": tag} for tag in tags]},
    }
    if "memo" in resolved:
        memo = entry["memo"]
        properties[resolved["memo"]] = {
            "rich_text": [{"text": {"content": memo}}] if memo else []
        }
    if "done" in resolved:
        # 新しい予定を書くときは未完了へ戻す（前回の完了チェックが残らないように）
        properties[resolved["done"]] = {"checkbox": False}
    return properties


def _plain_text(items: Any) -> str:
    if not isinstance(items, list):
        return ""
    return "".join(
        str(item.get("plain_text") or "")
        for item in items
        if isinstance(item, dict)
    )


def parse_page(page: Any, resolved: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Notion のページを、照合に使う形へ落とす。タイトルが無いページは無視する。"""
    if not isinstance(page, dict):
        return None
    properties = page.get("properties")
    page_id = page.get("id")
    if not isinstance(properties, dict) or not page_id:
        return None

    def value(field: str) -> Any:
        name = resolved.get(field)
        return properties.get(name) if name else None

    title = _plain_text((value("title") or {}).get("title"))
    if not title:
        return None

    date_value = value("date") or {}
    date = (date_value.get("date") or {}).get("start") if isinstance(date_value, dict) else None
    memo = _plain_text(((value("memo") or {}) if "memo" in resolved else {}).get("rich_text"))
    done_value = (value("done") or {}) if "done" in resolved else {}
    tags = [
        str(tag.get("name") or "")
        for tag in ((value("tag") or {}).get("multi_select") or [])
        if isinstance(tag, dict)
    ]

    return {
        "page_id": str(page_id),
        "title": title,
        # 時刻付きで入っていても日付だけで照合する（myroom は日付のみで書く）
        "date": str(date)[:10] if date else "",
        "memo": memo,
        "done": bool(done_value.get("checkbox")),
        "tags": [tag for tag in tags if tag],
    }


def _build_filter(resolved: Dict[str, str]) -> Dict[str, Any]:
    """myroom が書いたページだけを引く。

    ゴミの日と違い期間では絞らない。書くのは場所ごとに1件だけで総数が小さく、
    期限を過ぎたページこそ「完了になっていないか」を見たい相手だから。
    """
    return {"property": resolved["tag"], "multi_select": {"contains": TAG_VALUE}}


# --- 差分 ---------------------------------------------------------------------


def plan_changes(
    expected: List[Dict[str, str]],
    existing: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """在るべき一覧と Notion 側の現状から、作成・更新・アーカイブを決める。

    照合キーはタイトル（＝「掃除: 場所名」）。場所の名前を変えると別物になり、
    古いページはアーカイブされて新しい名前で作り直される。
    """
    expected_by_title = {entry["title"]: entry for entry in expected}

    existing_by_title: Dict[str, Dict[str, Any]] = {}
    duplicates: List[Dict[str, Any]] = []
    for page in existing:
        if page["title"] in existing_by_title:
            # 同じ場所のページが2件あるのは過去の同期が中断した名残
            duplicates.append(page)
            continue
        existing_by_title[page["title"]] = page

    create = [entry for title, entry in expected_by_title.items() if title not in existing_by_title]
    update = [
        {**expected_by_title[title], "page_id": page["page_id"], "tags": page["tags"]}
        for title, page in existing_by_title.items()
        if title in expected_by_title
        and (
            page["date"] != expected_by_title[title]["date"]
            or page["memo"] != expected_by_title[title]["memo"]
            # 完了済みは日付が変わらなくても更新してチェックを外す。残すと日をまたいだ
            # 最初の同期で find_completed が再び拾い、実施していない日の記録が入る
            or page["done"]
        )
    ]
    archive = [
        page for title, page in existing_by_title.items() if title not in expected_by_title
    ] + duplicates

    return {
        "create": sorted(create, key=lambda item: item["title"]),
        "update": sorted(update, key=lambda item: item["title"]),
        "archive": sorted(archive, key=lambda item: item["title"]),
    }


def find_completed(
    tasks: List[Dict[str, Any]],
    existing: List[Dict[str, Any]],
) -> List[str]:
    """Notion 側で完了になったページに対応する掃除の id。

    完了チェックだけでは「どの掃除か」が決まらないので、タイトルで突き合わせる。
    """
    completed_titles = {page["title"] for page in existing if page["done"]}
    return [task["id"] for task in tasks if build_title(task) in completed_titles]


# --- 同期 ---------------------------------------------------------------------


def sync(
    db: Optional[Session] = None,
    today: Optional[datetime.date] = None,
    *,
    dry_run: bool = False,
) -> Optional[Dict[str, Any]]:
    """次の掃除を Notion へ同期する。未設定・掃除が0件なら None を返す。"""
    token = os.getenv(ENV_TOKEN, "").strip()
    data_source_id = os.getenv(ENV_DATA_SOURCE_ID, "").strip()
    if not token or not data_source_id:
        logger.info(
            "%s / %s が未設定のため Notion への書き出しを行いません", ENV_TOKEN, ENV_DATA_SOURCE_ID
        )
        return None

    tasks = cleaning.get_tasks(db)
    if not tasks:
        logger.info("掃除の予定が登録されていないため書き出しを行いません")
        return None

    today = today or cleaning.get_today_jst()

    schema = notion_api.retrieve_data_source(token, data_source_id)
    resolved, errors = resolve_properties(schema)
    if errors:
        logger.warning(
            "Notion のプロパティを特定できないため同期を中止します: %s", "／".join(errors)
        )
        return None

    pages = notion_api.query_data_source(
        token, data_source_id, query_filter=_build_filter(resolved)
    )
    existing = [parsed for parsed in (parse_page(page, resolved) for page in pages) if parsed]

    # 完了の読み戻しを先に済ませてから、次の予定を計算する
    completed_ids = find_completed(tasks, existing) if "done" in resolved else []
    if completed_ids and not dry_run:
        # 冒頭の読み込みで始まったトランザクション（REPEATABLE READ のスナップショット）を捨てる。
        # 残すと、Notion を呼んでいる間に画面から入った操作を古い内容で上書きして消す（#496）
        if db is not None:
            db.commit()
        for task_id in completed_ids:
            tasks, _ = cleaning.mark_done(task_id, db, done_on=today)

    expected = build_entries(tasks, today)
    changes = plan_changes(expected, existing)

    summary = {
        "expected": len(expected),
        "completed": len(completed_ids),
        "created": len(changes["create"]),
        "updated": len(changes["update"]),
        "archived": len(changes["archive"]),
        "dry_run": dry_run,
    }
    if dry_run:
        return summary

    for entry in changes["create"]:
        notion_api.create_page(token, data_source_id, to_notion_properties(entry, resolved))
    for entry in changes["update"]:
        notion_api.update_page(
            token, entry["page_id"], to_notion_properties(entry, resolved, entry.get("tags"))
        )
    for page in changes["archive"]:
        notion_api.archive_page(token, page["page_id"])

    return summary


def run_sync(db: Optional[Session] = None) -> Optional[Dict[str, Any]]:
    """バックエンドのループから呼ぶ入口。

    ゴミの日と違って「今日はもう同期したか」で間引かない。掃除は画面から
    いつでも足せて、実施を記録した直後に次の予定が動くため、毎回差分を取る。
    書き込みが起きるのは差分があるときだけなので、Notion への負荷は小さい。
    """
    if database.DB_MOCK or database.SessionLocal is None:
        return sync(db)

    session = db or database.SessionLocal()
    try:
        return sync(session)
    finally:
        if db is None:
            session.close()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="次の掃除を Notion へ同期する")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Notion へ書き込まず、作成・更新・アーカイブの件数だけ表示する",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    session = None
    if not database.DB_MOCK and database.SessionLocal is not None:
        session = database.SessionLocal()

    try:
        summary = sync(session, dry_run=args.dry_run)
    except notion_api.NotionError as exc:
        logger.error("%s", exc)
        return 1
    finally:
        if session is not None:
            session.close()

    if summary is None:
        logger.info("Notion への書き出しは行いませんでした")
        return 0

    logger.info(
        "Cleaning Notion sync %s: expected=%d completed=%d created=%d updated=%d archived=%d",
        "(dry-run)" if summary["dry_run"] else "done",
        summary["expected"],
        summary["completed"],
        summary["created"],
        summary["updated"],
        summary["archived"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
