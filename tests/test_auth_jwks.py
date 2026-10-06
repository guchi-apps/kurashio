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
    monkeypatch.setattr(auth, "_auth_user_cache", {})


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


