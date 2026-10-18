"""`GET /api/app-version`（#798）。deploy.yml が稼働版のSHAを照合するのに使う。"""

import json


def _frontend_version():
    with open("frontend/package.json", encoding="utf-8") as f:
        return json.load(f)["version"]


def test_app_version_returns_version_and_sha(client, monkeypatch):
    monkeypatch.setenv("APP_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567")
    response = client.get("/api/app-version")
    assert response.status_code == 200
    assert response.json() == {
        "version": _frontend_version(),
        "sha": "0123456789abcdef0123456789abcdef01234567",
    }
    assert response.headers["cache-control"] == "no-store"


def test_app_version_sha_is_null_when_unset(client, monkeypatch):
    monkeypatch.delenv("APP_COMMIT_SHA", raising=False)
    response = client.get("/api/app-version")
    assert response.status_code == 200
    assert response.json()["sha"] is None


def test_app_version_sha_is_null_when_blank(client, monkeypatch):
    monkeypatch.setenv("APP_COMMIT_SHA", "  ")
    assert client.get("/api/app-version").json()["sha"] is None


def test_app_version_does_not_require_auth(client):
    # client は認証ヘッダーを持たない。デプロイ中のヘルスチェックから叩けること
    assert client.get("/api/app-version").status_code == 200


def test_app_version_is_null_when_package_json_missing(client, monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.FRONTEND_PACKAGE_JSON", str(tmp_path / "missing.json"))
    assert client.get("/api/app-version").json()["version"] is None


def test_app_version_is_not_served_as_frontend_html(client):
    # serve_frontend は api/ 配下を404にするが、ルートの登録順で横取りされていないこと
    response = client.get("/api/app-version")
    assert response.headers["content-type"].startswith("application/json")
