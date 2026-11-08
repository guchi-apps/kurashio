"""廃止した掃除機能（#865）が Notion の Task データベースへ残したページをアーカイブする。

一回限りの移行。掃除機能の削除で、タグ「掃除」付きのページを片付ける同期ループが
無くなったため、既存のページは手でここから片付ける。

**対象は「タグに『掃除』を含み、かつタイトルが『掃除: 』で始まるページ」だけ。**
旧実装は両方を付けて書いていたので、手で作ったタスク（タグだけ・タイトルだけが一致）は
巻き込まない。アーカイブは Notion のゴミ箱への移動で、Notion 側から戻せる。

既定は dry-run（一覧表示のみ）。`--execute` を付けたときだけ書き込む。
何度実行しても安全（アーカイブ済みのページはクエリに出ない）。

使い方（リポジトリルートで。トークンは 1Password から実行時に渡す）:

    op run --env-file=<(printf 'CLEANING_NOTION_TOKEN=op://apps/MyRoom/cleaning-notion-token\\nCLEANING_NOTION_DATA_SOURCE_ID=op://apps/MyRoom/cleaning-notion-data-source-id\\n') \\
        -- python scripts/archive_cleaning_notion.py            # 確認
    ... -- python scripts/archive_cleaning_notion.py --execute  # 実行
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import notion_api  # noqa: E402

logger = logging.getLogger("archive_cleaning_notion")

ENV_TOKEN = "CLEANING_NOTION_TOKEN"
ENV_DATA_SOURCE_ID = "CLEANING_NOTION_DATA_SOURCE_ID"

TAG_VALUE = "掃除"
TITLE_PREFIX = "掃除: "
TAG_PROPERTY_NAME = "タグ"


def find_tag_property(schema: Any) -> Optional[str]:
    """multi_select のプロパティ名。「タグ」を優先し、なければ1つに絞れるときだけ決める。"""
    properties = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(properties, dict):
        return None
    prop = properties.get(TAG_PROPERTY_NAME)
    if isinstance(prop, dict) and prop.get("type") == "multi_select":
        return TAG_PROPERTY_NAME
    candidates = [
        name
        for name, definition in properties.items()
        if isinstance(definition, dict) and definition.get("type") == "multi_select"
    ]
    return candidates[0] if len(candidates) == 1 else None


def _title_of(page: Dict[str, Any]) -> str:
    for definition in (page.get("properties") or {}).values():
        if isinstance(definition, dict) and definition.get("type") == "title":
            return "".join(
                str(item.get("plain_text") or "")
                for item in definition.get("title") or []
                if isinstance(item, dict)
            )
    return ""


def _tags_of(page: Dict[str, Any], tag_property: str) -> List[str]:
    prop = (page.get("properties") or {}).get(tag_property) or {}
    return [
        str(tag.get("name") or "")
        for tag in prop.get("multi_select") or []
        if isinstance(tag, dict)
    ]


def select_targets(pages: List[Dict[str, Any]], tag_property: str) -> List[Tuple[str, str]]:
    """アーカイブ対象（page_id, タイトル）。タグとタイトルの両方が一致するものだけ。"""
    targets: List[Tuple[str, str]] = []
    for page in pages:
        if not isinstance(page, dict) or not page.get("id") or page.get("archived"):
            continue
        title = _title_of(page)
        if TAG_VALUE in _tags_of(page, tag_property) and title.startswith(TITLE_PREFIX):
            targets.append((str(page["id"]), title))
    return targets


def run(token: str, data_source_id: str, *, execute: bool) -> int:
    schema = notion_api.retrieve_data_source(token, data_source_id)
    tag_property = find_tag_property(schema)
    if tag_property is None:
        logger.error("multi_select 型のタグのプロパティを特定できないため中止します")
        return 1

    options = (schema["properties"][tag_property].get("multi_select") or {}).get("options") or []
    if TAG_VALUE not in [str(o.get("name") or "") for o in options if isinstance(o, dict)]:
        # 選択肢が無いプロパティを絞り込むと Notion は 400 を返す。選択肢が無い＝付いたページも無い
        logger.info("タグ「%s」の選択肢が存在しないため、対象のページはありません", TAG_VALUE)
        return 0

    pages = notion_api.query_data_source(
        token,
        data_source_id,
        query_filter={"property": tag_property, "multi_select": {"contains": TAG_VALUE}},
    )
    targets = select_targets(pages, tag_property)
    skipped = len(pages) - len(targets)

    for page_id, title in targets:
        logger.info("%s %s (%s)", "アーカイブ" if execute else "対象", title, page_id)
        if execute:
            notion_api.archive_page(token, page_id)

    logger.info(
        "%s: 対象=%d 除外（タイトルが『%s』で始まらない等）=%d",
        "実行完了" if execute else "dry-run（書き込みなし）",
        len(targets),
        TITLE_PREFIX,
        skipped,
    )
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="掃除タグのNotionページをアーカイブする")
    parser.add_argument("--execute", action="store_true", help="実際にアーカイブする（既定はdry-run）")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    token = os.getenv(ENV_TOKEN, "").strip()
    data_source_id = os.getenv(ENV_DATA_SOURCE_ID, "").strip()
    if not token or not data_source_id:
        logger.error("%s / %s が未設定です", ENV_TOKEN, ENV_DATA_SOURCE_ID)
        return 2
    try:
        return run(token, data_source_id, execute=args.execute)
    except notion_api.NotionError as exc:
        logger.error("%s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
