import base64

from backend import apns_notify, apns_subscriptions


class FakeResponse:
    def __init__(self, status_code, reason=None):
        self.status_code = status_code
        self._reason = reason

    def json(self):
        return {"reason": self._reason} if self._reason else {}


class FakeClient:
    """`httpx.Client(http2=True, timeout=...)` の代わり。呼ばれた順に応答を返す。"""

    def __init__(self, calls, responses, **_kwargs):
        self._calls = calls
        self._responses = responses

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, headers=None, content=None):
        self._calls.append({"url": url, "headers": headers, "content": content})
        return self._responses.pop(0)


def _configure_apns(monkeypatch):
    monkeypatch.setenv("APNS_KEY_ID", "KEYID123")
    monkeypatch.setenv("APNS_TEAM_ID", "TEAMID123")
    monkeypatch.setenv("APNS_BUNDLE_ID", "com.gucchii.kurashio")
    monkeypatch.setenv("APNS_AUTH_KEY", base64.b64encode(b"dummy-key-contents").decode())
    monkeypatch.setattr(apns_notify, "_signing_token", lambda: "test-jwt")


def _set_tokens_path(monkeypatch, tmp_path):
    monkeypatch.setattr(apns_subscriptions, "TOKENS_PATH", tmp_path / "apns_tokens.json")


def _use_fake_client(monkeypatch, responses):
    calls = []
    monkeypatch.setattr(
        apns_notify.httpx, "Client", lambda **kwargs: FakeClient(calls, responses, **kwargs)
    )
    return calls


def test_is_configured_requires_all_values(monkeypatch):
    monkeypatch.delenv("APNS_KEY_ID", raising=False)
    monkeypatch.delenv("APNS_TEAM_ID", raising=False)
    monkeypatch.delenv("APNS_BUNDLE_ID", raising=False)
    monkeypatch.delenv("APNS_AUTH_KEY", raising=False)
    assert apns_notify.is_configured() is False

    _configure_apns(monkeypatch)
    assert apns_notify.is_configured() is True


def test_broadcast_skips_when_not_configured(monkeypatch, tmp_path):
    monkeypatch.delenv("APNS_AUTH_KEY", raising=False)
    _set_tokens_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")

    result = apns_notify.broadcast({"title": "t", "body": "b", "tag": "x", "url": "/"})
    assert result == {"sent": 0, "total": 0}


def test_broadcast_sends_to_all_tokens(monkeypatch, tmp_path):
    _configure_apns(monkeypatch)
    _set_tokens_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-a")
    apns_subscriptions.upsert_token("token-b")

    calls = _use_fake_client(monkeypatch, [FakeResponse(200), FakeResponse(200)])

    result = apns_notify.broadcast({"title": "t", "body": "b", "tag": "x", "url": "/"})
    assert result == {"sent": 2, "total": 2}
    assert len(calls) == 2
    assert calls[0]["headers"]["apns-topic"] == "com.gucchii.kurashio"
    assert calls[0]["headers"]["apns-collapse-id"] == "x"


def test_broadcast_removes_expired_tokens(monkeypatch, tmp_path):
    _configure_apns(monkeypatch)
    _set_tokens_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-expired")
    apns_subscriptions.upsert_token("token-ok")

    _use_fake_client(monkeypatch, [FakeResponse(410, reason="Unregistered"), FakeResponse(200)])

    result = apns_notify.broadcast({"title": "t", "body": "b", "tag": "x", "url": "/"})
    assert result == {"sent": 1, "total": 2}
    assert apns_subscriptions.list_tokens() == ["token-ok"]


def test_broadcast_removes_bad_device_token(monkeypatch, tmp_path):
    _configure_apns(monkeypatch)
    _set_tokens_path(monkeypatch, tmp_path)
    apns_subscriptions.upsert_token("token-bad")

    _use_fake_client(monkeypatch, [FakeResponse(400, reason="BadDeviceToken")])

    result = apns_notify.broadcast({"title": "t", "body": "b", "tag": "x", "url": "/"})
    assert result == {"sent": 0, "total": 1}
    assert apns_subscriptions.list_tokens() == []
