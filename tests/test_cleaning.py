import datetime

from backend import cleaning, cleaning_notion

TODAY = datetime.date(2026, 8, 26)


def history_dates(task):
    """履歴の「掃除した日」だけを取り出す。登録日時は実行時刻なので照合しない"""
    return [entry["date"] for entry in task["history"]]

SAMPLE_TASKS = [
    {
        "id": "kitchen-sink",
        "name": "キッチンのシンク",
        "interval_days": 3,
        "steps": ["排水口のゴミを捨てる", "スポンジで磨く"],
        "history": ["2026-08-23", "2026-08-20"],
    },
    {
        "id": "fan",
        "name": "換気扇まわり",
        "interval_days": 30,
        "steps": [],
        "history": ["2026-07-25"],
    },
    {
        "id": "fridge",
        "name": "冷蔵庫の中",
        "interval_days": 60,
        "steps": ["賞味期限を確認する"],
        "history": [],
    },
]


def test_next_due_counts_from_last_done():
    tasks = cleaning.normalize_tasks(SAMPLE_TASKS)
    assert cleaning.next_due(tasks[0], TODAY) == datetime.date(2026, 8, 26)
    assert cleaning.next_due(tasks[1], TODAY) == datetime.date(2026, 8, 24)


def test_next_due_is_today_when_never_done():
    """一度もやっていない掃除は今日が期限。予定が無い状態で埋もれさせない。"""
    tasks = cleaning.normalize_tasks(SAMPLE_TASKS)
    assert cleaning.next_due(tasks[2], TODAY) == TODAY


def test_build_payload_marks_status():
    payload = cleaning.build_payload(cleaning.normalize_tasks(SAMPLE_TASKS), TODAY)
    by_id = {task["id"]: task for task in payload["tasks"]}

    assert payload["configured"] is True
    assert by_id["kitchen-sink"]["status"] == "today"
    assert by_id["kitchen-sink"]["days_until"] == 0
    assert by_id["fan"]["status"] == "overdue"
    assert by_id["fan"]["days_until"] == -2
    assert by_id["fridge"]["last_done"] is None


def test_normalize_drops_nameless_and_clamps_interval():
    tasks = cleaning.normalize_tasks(
        [
            {"name": "  ", "interval_days": 3},
            {"name": "お風呂", "interval_days": 0},
            {"name": "ベランダ", "interval_days": 9999},
        ]
    )
    assert [task["name"] for task in tasks] == ["お風呂", "ベランダ"]
    assert tasks[0]["interval_days"] == cleaning.MIN_INTERVAL_DAYS
    assert tasks[1]["interval_days"] == cleaning.MAX_INTERVAL_DAYS


def test_normalize_gives_unique_ids_to_same_name():
    tasks = cleaning.normalize_tasks([{"name": "床"}, {"name": "床"}])
    assert tasks[0]["id"] != tasks[1]["id"]


def test_history_is_newest_first_without_duplicates_or_future():
    tasks = cleaning.normalize_tasks(
        [
            {
                "name": "トイレ",
                "history": ["2026-08-20", "2026-08-23", "2026-08-20", "2099-01-01", "x"],
            }
        ]
    )
    assert history_dates(tasks[0]) == ["2026-08-23", "2026-08-20"]


def test_save_tasks_keeps_history_of_existing_ids(data_dir):
    cleaning.save_tasks([{"id": "kitchen-sink", "name": "キッチン", "interval_days": 3}])
    cleaning.mark_done("kitchen-sink", done_on=datetime.date(2026, 8, 25))

    # 名前と間隔だけを編集して送り直しても、実施履歴は消えない
    saved = cleaning.save_tasks(
        [{"id": "kitchen-sink", "name": "キッチンのシンク", "interval_days": 5}]
    )
    assert saved[0]["name"] == "キッチンのシンク"
    assert history_dates(saved[0]) == ["2026-08-25"]


def test_mark_done_twice_in_a_day_does_not_duplicate(data_dir):
    cleaning.save_tasks([{"id": "toilet", "name": "トイレ", "interval_days": 7}])
    cleaning.mark_done("toilet", done_on=TODAY)
    tasks, found = cleaning.mark_done("toilet", done_on=TODAY)

    assert found is True
    assert history_dates(tasks[0]) == [TODAY.isoformat()]


def test_mark_done_reports_unknown_id(data_dir):
    tasks, found = cleaning.mark_done("nope")
    assert found is False
    assert tasks == []


# --- 掃除した日と登録した日時（#294） -----------------------------------------


def test_mark_done_keeps_done_date_and_recorded_at_apart(data_dir):
    """当日に押し忘れて翌日に前日ぶんを入れても、掃除した日は前日のまま。"""
    cleaning.save_tasks([{"id": "sink", "name": "シンク", "interval_days": 3}])
    recorded = datetime.datetime(2026, 8, 26, 9, 15, tzinfo=cleaning.JST)
    tasks, _ = cleaning.mark_done(
        "sink", done_on=datetime.date(2026, 8, 25), recorded_at=recorded
    )

    assert tasks[0]["history"] == [
        {"date": "2026-08-25", "recorded_at": "2026-08-26T09:15:00+09:00"}
    ]
    # 予定の計算は登録日ではなく掃除した日から数える
    assert cleaning.last_done(tasks[0]) == datetime.date(2026, 8, 25)
    assert cleaning.next_due(tasks[0], TODAY) == datetime.date(2026, 8, 28)


def test_mark_done_twice_keeps_the_first_recorded_at(data_dir):
    """同じ日を押し直しても、最初に登録した時刻を上書きしない。"""
    cleaning.save_tasks([{"id": "sink", "name": "シンク", "interval_days": 3}])
    first = datetime.datetime(2026, 8, 26, 9, 15, tzinfo=cleaning.JST)
    later = datetime.datetime(2026, 8, 26, 21, 0, tzinfo=cleaning.JST)
    cleaning.mark_done("sink", done_on=TODAY, recorded_at=first)
    tasks, _ = cleaning.mark_done("sink", done_on=TODAY, recorded_at=later)

    assert tasks[0]["history"] == [
        {"date": TODAY.isoformat(), "recorded_at": "2026-08-26T09:15:00+09:00"}
    ]


def test_old_history_of_plain_dates_is_read_as_unknown_recorded_at():
    """日付の文字列だけで保存されていた記録も、書き換えずにそのまま読める。"""
    tasks = cleaning.normalize_tasks(
        [{"name": "トイレ", "history": ["2026-08-23", {"date": "2026-08-20"}]}]
    )
    assert tasks[0]["history"] == [
        {"date": "2026-08-23", "recorded_at": None},
        {"date": "2026-08-20", "recorded_at": None},
    ]


def test_recorded_at_without_timezone_is_read_as_jst():
    tasks = cleaning.normalize_tasks(
        [
            {
                "name": "床",
                "history": [{"date": "2026-08-23", "recorded_at": "2026-08-24T07:05:00"}],
            }
        ]
    )
    assert tasks[0]["history"][0]["recorded_at"] == "2026-08-24T07:05:00+09:00"


def test_remove_done_deletes_one_record(data_dir):
    """日付を間違えて登録したときは、その1件を取り消して入れ直す。"""
    cleaning.save_tasks([{"id": "sink", "name": "シンク", "interval_days": 3}])
    cleaning.mark_done("sink", done_on=datetime.date(2026, 8, 25))
    cleaning.mark_done("sink", done_on=datetime.date(2026, 8, 20))

    tasks, removed = cleaning.remove_done("sink", datetime.date(2026, 8, 25))
    assert removed is True
    assert history_dates(tasks[0]) == ["2026-08-20"]

    # 保存されているので、取り直しても消えたまま
    assert history_dates(cleaning.get_tasks()[0]) == ["2026-08-20"]


def test_remove_done_reports_unknown_date(data_dir):
    cleaning.save_tasks([{"id": "sink", "name": "シンク", "interval_days": 3}])
    cleaning.mark_done("sink", done_on=datetime.date(2026, 8, 25))

    _, removed = cleaning.remove_done("sink", datetime.date(2026, 8, 24))
    assert removed is False


# --- Notion への書き出し ------------------------------------------------------

RESOLVED = {
    "title": "タイトル",
    "date": "期限",
    "tag": "タグ",
    "memo": "メモ",
    "done": "完了",
}


def test_resolve_properties_picks_date_by_name():
    """Task データベースには日付が「期限」「予定日」の2つある。型だけでは決まらない。"""
    schema = {
        "properties": {
            "タイトル": {"type": "title"},
            "期限": {"type": "date"},
            "予定日": {"type": "date"},
            "タグ": {"type": "multi_select"},
            "メモ": {"type": "rich_text"},
            "完了": {"type": "checkbox"},
        }
    }
    resolved, errors = cleaning_notion.resolve_properties(schema)
    assert errors == []
    assert resolved["date"] == "期限"


def test_resolve_properties_reports_missing_tag():
    schema = {"properties": {"タイトル": {"type": "title"}, "期限": {"type": "date"}}}
    resolved, errors = cleaning_notion.resolve_properties(schema)
    assert errors
    assert "tag" not in resolved


def test_build_entries_writes_only_the_next_one_per_task():
    tasks = cleaning.normalize_tasks(SAMPLE_TASKS)
    entries = cleaning_notion.build_entries(tasks, TODAY)

    assert len(entries) == len(tasks)
    assert entries[0]["title"] == "掃除: キッチンのシンク"
    assert entries[0]["date"] == "2026-08-26"
    assert entries[0]["memo"] == "3日ごと／排水口のゴミを捨てる／スポンジで磨く"


def test_plan_changes_creates_updates_and_archives():
    expected = [
        {"title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと"},
        {"title": "掃除: お風呂", "date": "2026-08-31", "memo": "7日ごと"},
    ]
    existing = [
        {"page_id": "p1", "title": "掃除: トイレ", "date": "2026-08-22", "memo": "7日ごと", "done": False, "tags": ["掃除", "生活"]},
        {"page_id": "p2", "title": "掃除: 玄関", "date": "2026-08-20", "memo": "", "done": False, "tags": ["掃除"]},
    ]
    changes = cleaning_notion.plan_changes(expected, existing)

    assert [item["title"] for item in changes["create"]] == ["掃除: お風呂"]
    assert changes["update"][0]["page_id"] == "p1"
    assert changes["update"][0]["date"] == "2026-08-29"
    assert [item["page_id"] for item in changes["archive"]] == ["p2"]


def test_plan_changes_leaves_unchanged_pages_alone():
    expected = [{"title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと"}]
    existing = [
        {"page_id": "p1", "title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと", "done": False, "tags": ["掃除"]}
    ]
    changes = cleaning_notion.plan_changes(expected, existing)
    assert changes == {"create": [], "update": [], "archive": []}


def test_plan_changes_updates_completed_page_even_if_date_is_unchanged():
    # その日のうちに実施済みで次回の日付が動かないページにチェックが付いた場合
    expected = [{"title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと"}]
    existing = [
        {"page_id": "p1", "title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと", "done": True, "tags": ["掃除"]}
    ]
    changes = cleaning_notion.plan_changes(expected, existing)

    assert [item["page_id"] for item in changes["update"]] == ["p1"]
    properties = cleaning_notion.to_notion_properties(
        changes["update"][0], RESOLVED, changes["update"][0]["tags"]
    )
    assert properties["完了"]["checkbox"] is False


def test_to_notion_properties_keeps_other_tags():
    entry = {"title": "掃除: トイレ", "date": "2026-08-29", "memo": "7日ごと"}
    properties = cleaning_notion.to_notion_properties(entry, RESOLVED, ["生活", "掃除"])

    assert [tag["name"] for tag in properties["タグ"]["multi_select"]] == ["掃除", "生活"]
    assert properties["期限"]["date"]["start"] == "2026-08-29"
    # 予定を書き直すときは完了チェックを外す（前回の完了が残らないように）
    assert properties["完了"]["checkbox"] is False


def test_find_completed_matches_by_title():
    tasks = cleaning.normalize_tasks(SAMPLE_TASKS)
    existing = [
        {"page_id": "p1", "title": "掃除: 換気扇まわり", "date": "2026-08-24", "memo": "", "done": True, "tags": ["掃除"]},
        {"page_id": "p2", "title": "掃除: キッチンのシンク", "date": "2026-08-26", "memo": "", "done": False, "tags": ["掃除"]},
        {"page_id": "p3", "title": "買い物へ行く", "date": "2026-08-26", "memo": "", "done": True, "tags": ["掃除"]},
    ]
    assert cleaning_notion.find_completed(tasks, existing) == ["fan"]


def test_parse_page_reads_title_date_and_done():
    page = {
        "id": "page-1",
        "properties": {
            "タイトル": {"title": [{"plain_text": "掃除: トイレ"}]},
            "期限": {"date": {"start": "2026-08-29T00:00:00.000+09:00"}},
            "タグ": {"multi_select": [{"name": "掃除"}, {"name": "生活"}]},
            "メモ": {"rich_text": [{"plain_text": "7日ごと"}]},
            "完了": {"checkbox": True},
        },
    }
    parsed = cleaning_notion.parse_page(page, RESOLVED)

    assert parsed["title"] == "掃除: トイレ"
    assert parsed["date"] == "2026-08-29"
    assert parsed["done"] is True
    assert parsed["tags"] == ["掃除", "生活"]


def test_sync_does_nothing_without_env(data_dir):
    cleaning.save_tasks([{"id": "toilet", "name": "トイレ", "interval_days": 7}])
    assert cleaning_notion.sync(today=TODAY) is None


# --- API ----------------------------------------------------------------------


def test_cleaning_api_round_trip(authed_client):
    empty = authed_client.get("/api/cleaning").json()
    assert empty["configured"] is False
    assert empty["tasks"] == []

    saved = authed_client.put(
        "/api/cleaning/tasks",
        json={
            "tasks": [
                {"id": "toilet", "name": "トイレ", "interval_days": 7, "steps": ["便器を洗う"]},
                {"id": "bath", "name": "お風呂", "interval_days": 7, "steps": []},
            ]
        },
    ).json()
    assert [task["name"] for task in saved["tasks"]] == ["トイレ", "お風呂"]
    # 一度もやっていないので今日が期限
    assert saved["tasks"][0]["status"] == "today"

    done = authed_client.post(
        "/api/cleaning/tasks/toilet/done", json={"date": "2026-08-26"}
    ).json()
    by_id = {task["id"]: task for task in done["tasks"]}
    assert by_id["toilet"]["last_done"] == "2026-08-26"
    assert by_id["toilet"]["next_due"] == "2026-09-02"


def test_cleaning_done_rejects_unknown_task(authed_client):
    assert authed_client.post("/api/cleaning/tasks/nope/done").status_code == 404


def test_cleaning_done_rejects_broken_date(authed_client):
    authed_client.put(
        "/api/cleaning/tasks",
        json={"tasks": [{"id": "toilet", "name": "トイレ", "interval_days": 7, "steps": []}]},
    )
    response = authed_client.post("/api/cleaning/tasks/toilet/done", json={"date": "8/26"})
    assert response.status_code == 400


def test_cleaning_requires_auth(client):
    assert client.get("/api/cleaning").status_code in (401, 403)


def test_sync_creates_updates_archives_and_reads_back(data_dir, monkeypatch):
    """Notion 側を差し替えて、同期のひと通り（作成・更新・片付け・読み戻し）を通す。"""
    monkeypatch.setenv(cleaning_notion.ENV_TOKEN, "test-token")
    monkeypatch.setenv(cleaning_notion.ENV_DATA_SOURCE_ID, "test-data-source")

    cleaning.save_tasks(
        [
            {"id": "toilet", "name": "トイレ", "interval_days": 7, "steps": ["便器を洗う"]},
            {"id": "bath", "name": "お風呂", "interval_days": 7, "steps": []},
        ]
    )
    # トイレは8/19に実施済み → 期限は8/26（今日）
    cleaning.mark_done("toilet", done_on=datetime.date(2026, 8, 19))

    schema = {
        "properties": {
            "タイトル": {"type": "title"},
            "期限": {"type": "date"},
            "予定日": {"type": "date"},
            "タグ": {"type": "multi_select"},
            "メモ": {"type": "rich_text"},
            "完了": {"type": "checkbox"},
        }
    }

    def page(page_id, title, date, memo="", done=False):
        return {
            "id": page_id,
            "properties": {
                "タイトル": {"title": [{"plain_text": title}]},
                "期限": {"date": {"start": date}},
                "タグ": {"multi_select": [{"name": "掃除"}]},
                "メモ": {"rich_text": [{"plain_text": memo}]},
                "完了": {"checkbox": done},
            },
        }

    existing = [
        # 完了になっている → お風呂を実施済みとして読み戻す
        page("p-bath", "掃除: お風呂", "2026-08-26", "7日ごと", done=True),
        # 期限がずれている → 更新
        page("p-toilet", "掃除: トイレ", "2026-08-20", "7日ごと／便器を洗う"),
        # 掃除の一覧に無い → 片付け
        page("p-old", "掃除: 玄関", "2026-08-10"),
    ]

    created, updated, archived = [], [], []
    monkeypatch.setattr(cleaning_notion.notion_api, "retrieve_data_source", lambda *a: schema)
    monkeypatch.setattr(cleaning_notion.notion_api, "query_data_source", lambda *a, **k: existing)
    monkeypatch.setattr(
        cleaning_notion.notion_api,
        "create_page",
        lambda token, ds, props: created.append(props),
    )
    monkeypatch.setattr(
        cleaning_notion.notion_api,
        "update_page",
        lambda token, page_id, props: updated.append((page_id, props)),
    )
    monkeypatch.setattr(
        cleaning_notion.notion_api,
        "archive_page",
        lambda token, page_id: archived.append(page_id),
    )

    summary = cleaning_notion.sync(today=TODAY)

    assert summary["completed"] == 1
    # 完了を読み戻したので、お風呂は今日やった扱い → 次の期限は 9/2 へ動く
    by_id = {task["id"]: task for task in cleaning.get_tasks()}
    assert history_dates(by_id["bath"]) == [TODAY.isoformat()]

    assert [page_id for page_id, _ in updated] == ["p-bath", "p-toilet"]
    updated_by_id = dict(updated)
    assert updated_by_id["p-bath"]["期限"]["date"]["start"] == "2026-09-02"
    assert updated_by_id["p-bath"]["完了"]["checkbox"] is False
    assert updated_by_id["p-toilet"]["期限"]["date"]["start"] == "2026-08-26"

    assert archived == ["p-old"]
    assert created == []


# --- 並行する更新（lost update・#496）------------------------------------------
#
# 全タスクが1行のJSONに入っているので、別のタスクへの操作同士でも、読み込みから書き戻しの
# 間に割り込まれると片方が消える。窓を広げるため、ロックの内側で走る `_normalize_history` を
# 遅くして、ロックが無ければ確実に取りこぼす形にしてある。

import threading
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import database

_TASK_IDS = ["t0", "t1", "t2", "t3"]


@pytest.fixture
def slow_history(monkeypatch):
    original = cleaning._normalize_history

    def slow(raw):
        time.sleep(0.01)
        return original(raw)

    monkeypatch.setattr(cleaning, "_normalize_history", slow)


def _definitions():
    return [{"id": task_id, "name": task_id, "interval_days": 7} for task_id in _TASK_IDS]


def _run_concurrently(jobs):
    errors = []
    barrier = threading.Barrier(len(jobs))

    def run(job):
        try:
            barrier.wait()
            job()
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(job,)) for job in jobs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []


def _days(count):
    return [TODAY - datetime.timedelta(days=index) for index in range(count)]


def _assert_nothing_lost(tasks, count):
    by_id = {task["id"]: task for task in tasks}
    for task_id in _TASK_IDS:
        assert len(by_id[task_id]["history"]) == count


def test_concurrent_mark_done_does_not_lose_each_other_in_file_mode(data_dir, slow_history):
    cleaning.save_tasks(_definitions())
    per_task = 4
    jobs = [
        (lambda task_id=task_id, day=day: cleaning.mark_done(task_id, done_on=day))
        for task_id in _TASK_IDS
        for day in _days(per_task)
    ]
    _run_concurrently(jobs)
    _assert_nothing_lost(cleaning.get_tasks(), per_task)


@pytest.fixture
def sqlite_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'cleaning.db'}", connect_args={"timeout": 30})
    database.AppSetting.__table__.create(engine)
    monkeypatch.setattr(database, "DB_MOCK", False)
    factory = sessionmaker(bind=engine)
    try:
        yield factory
    finally:
        engine.dispose()


def _in_session(factory, action):
    session = factory()
    try:
        return action(session)
    finally:
        session.close()


def test_concurrent_mark_done_does_not_lose_each_other_in_db_mode(sqlite_db, slow_history):
    _in_session(sqlite_db, lambda db: cleaning.save_tasks(_definitions(), db))
    per_task = 4
    jobs = [
        (
            lambda task_id=task_id, day=day: _in_session(
                sqlite_db, lambda db: cleaning.mark_done(task_id, db, done_on=day)
            )
        )
        for task_id in _TASK_IDS
        for day in _days(per_task)
    ]
    _run_concurrently(jobs)
    _assert_nothing_lost(_in_session(sqlite_db, cleaning.get_tasks), per_task)


def test_concurrent_first_saves_create_the_row_once(sqlite_db):
    jobs = [
        (lambda: _in_session(sqlite_db, lambda db: cleaning.save_tasks(_definitions(), db)))
        for _ in range(4)
    ]
    _run_concurrently(jobs)
    assert [t["id"] for t in _in_session(sqlite_db, cleaning.get_tasks)] == _TASK_IDS


def test_db_mode_not_found_writes_nothing_and_keeps_working(sqlite_db):
    _in_session(sqlite_db, lambda db: cleaning.save_tasks(_definitions(), db))
    _, found = _in_session(sqlite_db, lambda db: cleaning.mark_done("nope", db, done_on=TODAY))
    assert found is False
    _, removed = _in_session(
        sqlite_db, lambda db: cleaning.remove_done("t0", TODAY, db)
    )
    assert removed is False
    _, found = _in_session(sqlite_db, lambda db: cleaning.mark_done("t0", db, done_on=TODAY))
    assert found is True


def test_db_mode_save_keeps_history_written_after_the_stale_read(sqlite_db):
    """Notion同期の冒頭で読んだあとに画面から入った記録を、完了の読み戻しが消さない。"""
    _in_session(sqlite_db, lambda db: cleaning.save_tasks(_definitions(), db))

    db = sqlite_db()
    try:
        cleaning.get_tasks(db)  # 同期の冒頭の読み込み（ここでトランザクションが始まる）
        _in_session(sqlite_db, lambda other: cleaning.mark_done("t1", other, done_on=TODAY))
        db.commit()  # cleaning_notion.sync() が完了の読み戻しの前に行う
        cleaning.mark_done("t0", db, done_on=TODAY)
    finally:
        db.close()

    by_id = {t["id"]: t for t in _in_session(sqlite_db, cleaning.get_tasks)}
    assert len(by_id["t0"]["history"]) == 1
    assert len(by_id["t1"]["history"]) == 1
