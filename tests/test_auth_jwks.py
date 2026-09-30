import os

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

import pytest
import requests
from fastapi import HTTPException
from jose import JWTError

from backend import auth


@pytest.fixture(autouse=True)
def reset_cache(monkeypatch):
    monkeypatch.setitem(auth._jwks_cache, "keys_by_kid", {})
    monkeypatch.setitem(auth._jwks_cache, "fetched_at", None)
    monkeypatch.setitem(auth._jwks_cache, "attempted_at", None)


def _counting_fetch(monkeypatch, result):
    calls = []

    def fake():
        calls.append(1)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(auth, "_fetch_jwks", fake)
    return calls


def test_unknown_kid_refetch_is_throttled(monkeypatch):
    calls = _counting_fetch(monkeypatch, {"a": {"kid": "a"}})
    assert auth._get_signing_key("a")["kid"] == "a"
    for i in range(5):
        with pytest.raises(JWTError):
            auth._get_signing_key(f"bogus{i}")
    assert len(calls) == 1


def test_unknown_kid_refetches_after_interval(monkeypatch):
    calls = _counting_fetch(monkeypatch, {"a": {"kid": "a"}})
    auth._get_signing_key("a")
    auth._jwks_cache["attempted_at"] -= auth.JWKS_REFETCH_MIN_INTERVAL_SECONDS + 1
    with pytest.raises(JWTError):
        auth._get_signing_key("bogus")
    assert len(calls) == 2


def test_fetch_failure_keeps_stale_cache(monkeypatch):
    _counting_fetch(monkeypatch, {"a": {"kid": "a"}})
    auth._get_signing_key("a")
    auth._jwks_cache["fetched_at"] -= auth.JWKS_CACHE_TTL_SECONDS + 1
    auth._jwks_cache["attempted_at"] -= auth.JWKS_REFETCH_MIN_INTERVAL_SECONDS + 1
    _counting_fetch(monkeypatch, requests.ConnectionError("down"))
    assert auth._get_signing_key("a")["kid"] == "a"


def test_fetch_failure_without_cache_is_503(monkeypatch):
    _counting_fetch(monkeypatch, requests.ConnectionError("down"))
    monkeypatch.setattr(auth.jwt, "get_unverified_header", lambda t: {"kid": "a"})
    with pytest.raises(HTTPException) as exc:
        auth.verify_token("x")
    assert exc.value.status_code == 503


def test_get_current_user_is_sync():
    import inspect

    assert not inspect.iscoroutinefunction(auth.get_current_user)


def _user_with(monkeypatch, payload):
    monkeypatch.setattr(auth, "verify_token", lambda token: payload)
    return auth.get_current_user(token="t")


def _google_payload(**overrides):
    payload = {
        "email": "test@example.com",
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "user_metadata": {"email_verified": True},
    }
    payload.update(overrides)
    return payload


def test_verified_google_login_is_allowed(monkeypatch):
    payload = _google_payload()
    assert _user_with(monkeypatch, payload) is payload


@pytest.mark.parametrize(
    "overrides",
    [
        # 許可リストのメールでも、メール/パスワード登録のトークンは通さない
        {"app_metadata": {"provider": "email", "providers": ["email"]}},
        {"app_metadata": {}},
        {"app_metadata": None},
        # メールが未確認・確認済みの記載が無い
        {"user_metadata": {"email_verified": False}},
        {"user_metadata": {}},
        {"user_metadata": {"email_verified": "true"}},
    ],
)
def test_unverified_or_non_google_login_is_403(monkeypatch, overrides):
    with pytest.raises(HTTPException) as exc_info:
        _user_with(monkeypatch, _google_payload(**overrides))
    assert exc_info.value.status_code == 403
