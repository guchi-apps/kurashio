import importlib.util
import pathlib

from backend import notion_api

_spec = importlib.util.spec_from_file_location(
    "archive_cleaning_notion",
    pathlib.Path(__file__).resolve().parent.parent / "scripts" / "archive_cleaning_notion.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

SCHEMA = {
    "properties": {
        "タイトル": {"type": "title"},
        "タグ": {"type": "multi_select", "multi_select": {"options": [{"name": "掃除"}]}},
    }
}


def _page(page_id, title, tags, archived=False):
    return {
        "id": page_id,
        "archived": archived,
        "properties": {
            "タイトル": {"type": "title", "title": [{"plain_text": title}]},
            "タグ": {"type": "multi_select", "multi_select": [{"name": t} for t in tags]},
        },
    }


def test_対象はタグとタイトルの両方が一致するページだけ():
    pages = [
        _page("a", "掃除: キッチン", ["掃除"]),
        _page("b", "掃除: 風呂", ["掃除", "家"]),
        _page("c", "掃除の本を読む", ["掃除"]),  # タイトルが違う（手作業のタスク）
        _page("d", "掃除: トイレ", ["家"]),  # タグが違う
        _page("e", "掃除: 洗面所", ["掃除"], archived=True),
    ]
    assert mod.select_targets(pages, "タグ") == [("a", "掃除: キッチン"), ("b", "掃除: 風呂")]


def test_タグのプロパティは名前か型が1つなら特定できる():
    assert mod.find_tag_property(SCHEMA) == "タグ"
    assert mod.find_tag_property({"properties": {"ラベル": {"type": "multi_select"}}}) == "ラベル"
    two = {"properties": {"a": {"type": "multi_select"}, "b": {"type": "multi_select"}}}
    assert mod.find_tag_property(two) is None


def _patch(monkeypatch, pages):
    archived = []
    monkeypatch.setattr(notion_api, "retrieve_data_source", lambda t, d: SCHEMA)
    monkeypatch.setattr(notion_api, "query_data_source", lambda t, d, query_filter=None: pages)
    monkeypatch.setattr(notion_api, "archive_page", lambda t, p: archived.append(p) or {})
    return archived


def test_dry_runは書き込まない(monkeypatch):
    archived = _patch(monkeypatch, [_page("a", "掃除: キッチン", ["掃除"])])
    assert mod.run("t", "d", execute=False) == 0
    assert archived == []


def test_executeは対象だけアーカイブする(monkeypatch):
    archived = _patch(
        monkeypatch,
        [_page("a", "掃除: キッチン", ["掃除"]), _page("c", "掃除の本", ["掃除"])],
    )
    assert mod.run("t", "d", execute=True) == 0
    assert archived == ["a"]


def test_未設定なら何もせず終了する(monkeypatch):
    monkeypatch.delenv(mod.ENV_TOKEN, raising=False)
    monkeypatch.delenv(mod.ENV_DATA_SOURCE_ID, raising=False)
    assert mod.main([]) == 2


def test_タグの選択肢が無ければ問い合わせず終了する(monkeypatch):
    no_option = {"properties": {"タグ": {"type": "multi_select", "multi_select": {"options": [{"name": "仕事"}]}}}}
    monkeypatch.setattr(notion_api, "retrieve_data_source", lambda t, d: no_option)

    def boom(*a, **k):
        raise AssertionError("query されてはならない")

    monkeypatch.setattr(notion_api, "query_data_source", boom)
    assert mod.run("t", "d", execute=True) == 0
