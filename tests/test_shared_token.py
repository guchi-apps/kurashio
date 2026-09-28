"""issue-deck の共有トークン取得（#525）。"""

import logging

import pytest
from fastapi import HTTPException

from backend import internal_auth, shared_token


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("SHARED_TOKEN_API_SECRET", "bearer-secret")
    monkeypatch.setenv("SHARED_TOKEN_API_URL", "https://deck.example/")


def test_未設定なら取得せずNone(monkeypatch):
    def boom(*a):
        raise AssertionError("呼ばれてはいけない")

    assert shared_token.get_shared_token("X", fetch=boom) is None


def test_取得値をキャッシュする(configured):
    calls = []

    def fetch(name, url, secret):
        calls.append((name, url, secret))
        return f"v{len(calls)}"

    assert shared_token.get_shared_token("X", fetch=fetch) == "v1"
    assert shared_token.get_shared_token("X", fetch=fetch) == "v1"
    assert calls == [("X", "https://deck.example/api/shared-tokens", "bearer-secret")]


def test_期限切れで取り直し_失敗なら直前の値(configured, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(shared_token, "_now", lambda: now[0])
    assert shared_token.get_shared_token("X", fetch=lambda *a: "old") == "old"

    now[0] += shared_token.CACHE_TTL_SECONDS + 1

    def fail(*a):
        raise RuntimeError("status 503")

    assert shared_token.get_shared_token("X", fetch=fail) == "old"


def test_一度も取れないときはNoneで短時間は再試行しない(configured, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(shared_token, "_now", lambda: now[0])
    calls = []

    def fail(*a):
        calls.append(1)
        raise RuntimeError("status 500")

    assert shared_token.get_shared_token("X", fetch=fail) is None
    assert shared_token.get_shared_token("X", fetch=fail) is None
    assert len(calls) == 1
    now[0] += shared_token.FAILURE_RETRY_SECONDS + 1
    assert shared_token.get_shared_token("X", fetch=fail) is None
    assert len(calls) == 2


def test_ログに値もBearerも出さない(configured, caplog):
    def fail(name, url, secret):
        raise RuntimeError("status 401")

    with caplog.at_level(logging.WARNING):
        shared_token.get_shared_token("X", fetch=fail)
    assert "bearer-secret" not in caplog.text


def test_HTTP呼び出しの形(configured, monkeypatch):
    seen = {}

    class Resp:
        status_code = 200

        def json(self):
            return {"name": "X", "value": "tok"}

    def fake_get(url, params, headers, timeout):
        seen.update(url=url, params=params, headers=headers, timeout=timeout)
        return Resp()

    monkeypatch.setattr(shared_token.requests, "get", fake_get)
    assert shared_token.get_shared_token("X") == "tok"
    assert seen["params"] == {"name": "X"}
    assert seen["headers"]["Authorization"] == "Bearer bearer-secret"
    assert seen["headers"]["X-Shared-Token-Consumer"] == "myroom"
    assert seen["timeout"] == 5


def test_内部APIは共有トークンを優先し_取れなければ環境変数(configured, monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "env-read")
    monkeypatch.setenv("INTERNAL_CONTROL_API_KEY", "env-control")
    values = {"MYROOM_INTERNAL_API_KEY": "shared-read"}
    monkeypatch.setattr(
        internal_auth, "get_shared_token", lambda name: values.get(name)
    )
    assert internal_auth.get_internal_api_key() == "shared-read"
    assert internal_auth.get_internal_control_api_key() == "env-control"

    internal_auth.require_internal_token("Bearer shared-read")
    with pytest.raises(HTTPException) as exc:
        internal_auth.require_internal_token("Bearer env-read")
    assert exc.value.status_code == 401
