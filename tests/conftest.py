import datetime
import os

os.environ["DB_MOCK"] = "true"
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("ALLOWED_GOOGLE_EMAILS", "test@example.com")
# 開発機の .env に Notion の値が入っていても、テストから本物の Notion を叩かない。
# python-dotenv は既にあるキーを上書きしないため、空文字を先に置いておけばよい。
os.environ["GARBAGE_NOTION_TOKEN"] = ""
os.environ["GARBAGE_NOTION_DATA_SOURCE_ID"] = ""
os.environ["CLEANING_NOTION_TOKEN"] = ""
os.environ["CLEANING_NOTION_DATA_SOURCE_ID"] = ""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "backend.device_config.CONFIG_PATH",
        tmp_path / "devices.json",
    )
    monkeypatch.setattr(
        "backend.aircon_config.CONFIG_PATH",
        tmp_path / "aircon.json",
    )
    monkeypatch.setattr(
        "backend.outdoor_config.CONFIG_PATH",
        tmp_path / "outdoor_location.json",
    )
    monkeypatch.setattr(
        "backend.ui_settings.CONFIG_PATH",
        tmp_path / "ui_settings.json",
    )
    # リポジトリに含まれる data/garbage.json は利用者が自分の収集日に書き換えるため、
    # テストは常に tmp_path 側の定義を見る。
    monkeypatch.setattr(
        "backend.garbage.CONFIG_PATH",
        tmp_path / "garbage.json",
    )
    monkeypatch.setattr(
        "backend.garbage_notion.STATE_PATH",
        tmp_path / "garbage_notion_state.json",
    )
    # Bambu の最新状態も DB_MOCK ではファイルに落ちる（本番は app_settings テーブル）
    monkeypatch.setattr(
        "backend.bambu.STATE_PATH",
        tmp_path / "bambu_state.json",
    )
    # 掃除の予定は DB_MOCK ではファイルに落ちる（本番は app_settings テーブル）
    monkeypatch.setattr(
        "backend.cleaning.CONFIG_PATH",
        tmp_path / "cleaning.json",
    )
    # フィラメントの在庫も DB_MOCK ではファイルに落ちる（本番は app_settings テーブル）
    monkeypatch.setattr(
        "backend.filament.FILE_PATH",
        tmp_path / "filament.json",
    )
    return tmp_path


@pytest.fixture
def auth_headers():
    return {"Authorization": "Bearer test-token"}


@pytest.fixture
def mock_weather(monkeypatch):
    def outdoor_weather(db=None, location_id=None):
        return {
            "temperature": 25.0,
            "humidity": 60.0,
            "pressure": 1013.0,
            "weather_code": 1,
            "weather_label": "晴れ",
            "weather_icon": "sun",
            # Open-Meteo は timezone=Asia/Tokyo でもオフセットを付けずに返す。
            "observed_at": "2026-08-19T21:00",
        }

    def outdoor_history(start, end, db=None, location_id=None):
        start_dt = datetime.datetime.strptime(start, "%Y-%m-%d")
        end_dt = datetime.datetime.strptime(end, "%Y-%m-%d")
        times = []
        temps = []
        humids = []
        pressures = []
        cursor = start_dt
        while cursor <= end_dt + datetime.timedelta(hours=23):
            times.append(cursor.strftime("%Y-%m-%dT%H:00"))
            temps.append(22.0)
            humids.append(55.0)
            pressures.append(1013.0)
            cursor += datetime.timedelta(hours=1)
        return {
            "time": times,
            "temperature": temps,
            "humidity": humids,
            "pressure": pressures,
        }

    def search_locations(query, count=8):
        if query.strip() == "大阪":
            return [
                {
                    "name": "大阪",
                    "label": "大阪, 大阪府, 日本",
                    "latitude": 34.6937,
                    "longitude": 135.5023,
                }
            ]
        return []

    monkeypatch.setattr("backend.weather.get_outdoor_weather", outdoor_weather)
    monkeypatch.setattr("backend.weather.get_outdoor_history", outdoor_history)
    monkeypatch.setattr("backend.weather.search_locations", search_locations)


@pytest.fixture(autouse=True)
def isolate_shared_token(monkeypatch):
    """開発機の .env に共有トークンAPIの設定があっても、テストが外へ出ないようにする（#525）。"""
    from backend import shared_token

    monkeypatch.delenv("SHARED_TOKEN_API_SECRET", raising=False)
    monkeypatch.delenv("SHARED_TOKEN_API_URL", raising=False)
    shared_token.clear_cache()
    yield
    shared_token.clear_cache()


@pytest.fixture
def internal_api_key(monkeypatch):
    """サーバー間参照用トークンを設定する。未設定（503）の確認をする側は使わない。"""
    key = "test-internal-api-key"
    monkeypatch.setenv("INTERNAL_API_KEY", key)
    return key


@pytest.fixture
def no_internal_api_key(monkeypatch):
    """開発機の .env に値が入っていても、未設定時の挙動を確認できるようにする。"""
    monkeypatch.delenv("INTERNAL_API_KEY", raising=False)


@pytest.fixture
def internal_control_api_key(monkeypatch):
    """操作専用トークンを設定する（#419）。読み取り用の `internal_api_key` とは別の値。"""
    key = "test-internal-control-api-key"
    monkeypatch.setenv("INTERNAL_CONTROL_API_KEY", key)
    return key


@pytest.fixture
def no_internal_control_api_key(monkeypatch):
    """開発機の .env に値が入っていても、未設定時の挙動を確認できるようにする。"""
    monkeypatch.delenv("INTERNAL_CONTROL_API_KEY", raising=False)


@pytest.fixture
def client(data_dir, mock_weather):
    from backend.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def authed_client(client):
    from backend.auth import get_current_user
    from backend.main import app

    app.dependency_overrides[get_current_user] = lambda: {"email": "test@example.com"}
    try:
        yield client
    finally:
        del app.dependency_overrides[get_current_user]
