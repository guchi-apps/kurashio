import base64

from backend import apns_notify, apns_subscriptions


def _configure_apns(monkeypatch):
    monkeypatch.setenv("APNS_KEY_ID", "KEYID123")
    monkeypatch.setenv("APNS_TEAM_ID", "TEAMID123")
    monkeypatch.setenv("APNS_BUNDLE_ID", "com.gucchii.kurashio")
    monkeypatch.setenv("APNS_AUTH_KEY", base64.b64encode(b"dummy-key-contents").decode())


def _set_tokens_path(monkeypatch, tmp_path):
    monkeypatch.setattr(apns_subscriptions, "TOKENS_PATH", tmp_path / "apns_tokens.json")


def test_apns_status_requires_auth(client):
    assert client.get("/api/apns/status").status_code == 401


def test_apns_status_reflects_configuration(authed_client, monkeypatch):
    monkeypatch.delenv("APNS_AUTH_KEY", raising=False)
    assert authed_client.get("/api/apns/status").json() == {"configured": False}

    _configure_apns(monkeypatch)
    assert authed_client.get("/api/apns/status").json() == {"configured": True}


def test_register_requires_auth(client):
    response = client.post("/api/apns/register", json={"token": "token-a"})
    assert response.status_code == 401


def test_register_stores_token(authed_client, monkeypatch, tmp_path):
    _configure_apns(monkeypatch)
    _set_tokens_path(monkeypatch, tmp_path)

    response = authed_client.post("/api/apns/register", json={"token": "token-a"})
    assert response.status_code == 200
    assert apns_subscriptions.list_tokens() == ["token-a"]


def test_register_rejects_when_not_configured(authed_client, monkeypatch, tmp_path):
    monkeypatch.delenv("APNS_AUTH_KEY", raising=False)
    _set_tokens_path(monkeypatch, tmp_path)

    response = authed_client.post("/api/apns/register", json={"token": "token-a"})
    assert response.status_code == 503


def test_unregister_removes_token(authed_client, monkeypatch, tmp_path):
    _set_tokens_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")

    response = authed_client.request("DELETE", "/api/apns/register", json={"token": "token-a"})
    assert response.status_code == 200
    assert apns_subscriptions.list_tokens() == []


def test_unregister_missing_token_returns_404(authed_client, monkeypatch, tmp_path):
    _set_tokens_path(monkeypatch, tmp_path)
    response = authed_client.request("DELETE", "/api/apns/register", json={"token": "missing"})
    assert response.status_code == 404


def test_send_test_apns_requires_configuration(authed_client, monkeypatch):
    monkeypatch.delenv("APNS_AUTH_KEY", raising=False)
    response = authed_client.post("/api/apns/test")
    assert response.status_code == 503


def test_send_test_apns_returns_counts(authed_client, monkeypatch, tmp_path):
    _configure_apns(monkeypatch)
    _set_tokens_path(monkeypatch, tmp_path)
    monkeypatch.setattr(apns_notify, "broadcast", lambda payload: {"sent": 1, "total": 1})

    response = authed_client.post("/api/apns/test")
    assert response.status_code == 200
    body = response.json()
    assert body["sent"] == 1
    assert body["total"] == 1
