"""JWT検証とGoogleログイン判定の回帰テスト（#724）。

実際に ES256 の鍵で署名したトークンを使い、署名・発行元・audience・有効期限・鍵の違いを確かめる。
Auth サーバー（`/auth/v1/user`）への問い合わせは差し替える。
"""

import logging
import os
import time
import uuid

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from jose import jwk, jwt

from backend import auth

EMAIL = "owner@example.com"
SUB = str(uuid.uuid4())
KID = "test-kid"


def _es256_pair():
    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_jwk = jwk.construct(pem, "ES256").public_key().to_dict()
    return pem, public_jwk


SIGNING_PEM, SIGNING_JWK = _es256_pair()
OTHER_PEM, _ = _es256_pair()


def _claims(**overrides):
    now = int(time.time())
    claims = {
        "iss": auth.SUPABASE_ISSUER,
        "aud": "authenticated",
        "sub": SUB,
        "email": EMAIL,
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "amr": [{"method": "oauth", "timestamp": now}],
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "user_metadata": {"email_verified": True},
        "is_anonymous": False,
    }
    claims.update(overrides)
    return claims


def _es256_token(pem=SIGNING_PEM, kid=KID, **overrides):
    headers = {"kid": kid} if kid else {}
    return jwt.encode(_claims(**overrides), pem, algorithm="ES256", headers=headers)


def _hs256_token(secret="legacy-secret", **overrides):
    # jose は kid を付けない。Supabase の旧JWTシークレットのトークンと同じ形
    return jwt.encode(_claims(**overrides), secret, algorithm="HS256")


def _identity(provider, email=EMAIL, verified=True):
    return {
        "provider": provider,
        "identity_data": {"email": email, "email_verified": verified},
    }


def _auth_user(identities=None, **overrides):
    user = {
        "id": SUB,
        "email": EMAIL,
        "identities": identities if identities is not None else [_identity("google")],
    }
    user.update(overrides)
    return user


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setitem(auth._jwks_cache, "keys_by_kid", {})
    monkeypatch.setitem(auth._jwks_cache, "fetched_at", None)
    monkeypatch.setitem(auth._jwks_cache, "attempted_at", None)
    monkeypatch.setattr(auth, "_auth_user_cache", {})
    monkeypatch.setattr(auth, "_fetch_jwks", lambda: {KID: {**SIGNING_JWK, "kid": KID, "alg": "ES256"}})
    monkeypatch.setattr(auth, "ALLOWED_GOOGLE_EMAILS", {EMAIL})
    monkeypatch.setattr(auth, "SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")


def _auth_server(monkeypatch, result):
    calls = []

    def fake(token):
        calls.append(token)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(auth, "_request_auth_user", fake)
    return calls


def _status(token):
    with pytest.raises(HTTPException) as exc_info:
        auth.get_current_user(token=token)
    return exc_info.value.status_code


# --- 署名の検証（kid あり・JWKS） ---


def test_es256_google_login_is_allowed(monkeypatch):
    _auth_server(monkeypatch, _auth_user())
    payload = auth.get_current_user(token=_es256_token())
    assert payload["sub"] == SUB


def test_token_signed_by_another_key_is_401(monkeypatch):
    calls = _auth_server(monkeypatch, _auth_user())
    assert _status(_es256_token(pem=OTHER_PEM)) == 401
    assert calls == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": int(time.time()) - 10},
        {"iss": "https://other-project.supabase.co/auth/v1"},
        {"aud": "anon"},
    ],
)
def test_expired_or_foreign_token_is_401(monkeypatch, overrides):
    _auth_server(monkeypatch, _auth_user())
    assert _status(_es256_token(**overrides)) == 401


def test_unknown_kid_is_401(monkeypatch):
    _auth_server(monkeypatch, _auth_user())
    assert _status(_es256_token(kid="rotated-away")) == 401


def test_hs256_token_claiming_jwks_kid_is_401(monkeypatch):
    # トークン自身の alg を採用すると、公開鍵を HMAC の鍵として使わせる攻撃が通る
    calls = _auth_server(monkeypatch, _auth_user())
    token = jwt.encode(_claims(), "x" * 32, algorithm="HS256", headers={"kid": KID})
    assert _status(token) == 401
    assert calls == []


def test_garbage_bearer_is_401(monkeypatch):
    calls = _auth_server(monkeypatch, _auth_user())
    assert _status("sb_publishable_not_a_jwt") == 401
    assert calls == []


# --- kid の無いトークン（Auth サーバーで検証） ---


def test_kidless_token_accepted_by_auth_server_is_allowed(monkeypatch):
    calls = _auth_server(monkeypatch, _auth_user())
    token = _hs256_token()
    assert auth.get_current_user(token=token)["sub"] == SUB
    # 検証と identity の確認で2回呼ばず、覚えた応答を使い回す
    assert len(calls) == 1


def test_kidless_token_rejected_by_auth_server_is_401(monkeypatch):
    _auth_server(monkeypatch, None)
    assert _status(_hs256_token()) == 401


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": int(time.time()) - 10},
        {"iss": "https://other-project.supabase.co/auth/v1"},
        {"aud": "anon", "role": "anon"},
        {"sub": str(uuid.uuid4())},
    ],
)
def test_kidless_token_with_mismatched_claims_is_401(monkeypatch, overrides):
    _auth_server(monkeypatch, _auth_user())
    assert _status(_hs256_token(**overrides)) == 401


def test_kidless_token_when_auth_server_unreachable_is_503(monkeypatch):
    _auth_server(monkeypatch, auth.AuthServerUnavailableError("ConnectionError"))
    assert _status(_hs256_token()) == 503


def test_kidless_token_without_publishable_key_is_503(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_PUBLISHABLE_KEY", "")
    assert _status(_hs256_token()) == 503


# --- Googleログインの判定（#616 を保ったまま、複数プロバイダーを通す） ---


def test_account_first_created_with_github_can_log_in_with_google(monkeypatch):
    # app_metadata.provider は最初のプロバイダーのまま（#724 の 403 の原因）
    _auth_server(
        monkeypatch,
        _auth_user(identities=[_identity("github"), _identity("google")]),
    )
    token = _es256_token(
        app_metadata={"provider": "github", "providers": ["github", "google"]},
        user_metadata={},
    )
    assert auth.get_current_user(token=token)["sub"] == SUB


@pytest.mark.parametrize(
    "token_overrides, identities",
    [
        # メール/パスワードで作られたアカウント（Googleの identity が無い）
        ({"amr": [{"method": "password"}]}, [_identity("email", verified=False)]),
        # GitHubだけのアカウント。app_metadata を google と偽っていても identities を見る
        ({"app_metadata": {"provider": "google", "providers": ["google"]}}, [_identity("github")]),
        # Googleの identity はあるがセッションはパスワード
        ({"amr": [{"method": "password"}]}, [_identity("google")]),
        # amr が無い
        ({"amr": None}, [_identity("google")]),
        # 匿名セッション
        ({"is_anonymous": True}, [_identity("google")]),
        # Google 側で未確認のメール（user_metadata は利用者が書き換えられるので見ない）
        ({"user_metadata": {"email_verified": True}}, [_identity("google", verified=False)]),
        # Google の identity のメールが許可リストのメールと違う
        ({}, [_identity("google", email="someone-else@example.com")]),
        # identities を返さない
        ({}, None),
    ],
)
def test_not_a_verified_google_login_is_403(monkeypatch, token_overrides, identities):
    user = _auth_user()
    user["identities"] = identities
    _auth_server(monkeypatch, user)
    assert _status(_es256_token(**token_overrides)) == 403


def test_auth_user_email_differs_from_token_is_403(monkeypatch):
    _auth_server(monkeypatch, _auth_user(email="changed@example.com"))
    assert _status(_es256_token()) == 403


def test_email_not_in_allowlist_is_403_without_asking_auth_server(monkeypatch):
    calls = _auth_server(monkeypatch, _auth_user())
    assert _status(_es256_token(email="stranger@example.com")) == 403
    assert calls == []


def test_revoked_session_is_401(monkeypatch):
    # 署名は正しいが、共有アカウント側でセッションが失効・ユーザーが削除された
    _auth_server(monkeypatch, None)
    assert _status(_es256_token()) == 401


def test_auth_user_of_another_subject_is_401(monkeypatch):
    _auth_server(monkeypatch, _auth_user(id=str(uuid.uuid4())))
    assert _status(_es256_token()) == 401


def test_auth_server_unreachable_is_503(monkeypatch):
    _auth_server(monkeypatch, auth.AuthServerUnavailableError("Timeout"))
    assert _status(_es256_token()) == 503


# --- Auth サーバーへの問い合わせ ---


class _Response:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 422])
def test_request_auth_user_rejection(monkeypatch, status_code):
    monkeypatch.setattr(auth.requests, "get", lambda *a, **k: _Response(status_code))
    assert auth._request_auth_user("t") is None


@pytest.mark.parametrize("status_code", [429, 500, 502, 503])
def test_request_auth_user_server_error_is_unavailable(monkeypatch, status_code):
    monkeypatch.setattr(auth.requests, "get", lambda *a, **k: _Response(status_code))
    with pytest.raises(auth.AuthServerUnavailableError):
        auth._request_auth_user("t")


def test_request_auth_user_network_error_is_unavailable(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(auth.requests, "get", boom)
    with pytest.raises(auth.AuthServerUnavailableError):
        auth._request_auth_user("t")


def test_request_auth_user_sends_publishable_key_and_token(monkeypatch):
    seen = {}

    def fake_get(url, headers, timeout):
        seen.update(url=url, headers=headers)
        return _Response(200, _auth_user())

    monkeypatch.setattr(auth.requests, "get", fake_get)
    assert auth._request_auth_user("tok")["id"] == SUB
    assert seen["url"] == f"{auth.SUPABASE_ISSUER}/user"
    assert seen["headers"] == {"apikey": "sb_publishable_test", "Authorization": "Bearer tok"}


def test_rejection_is_not_cached(monkeypatch):
    calls = _auth_server(monkeypatch, None)
    assert auth.fetch_auth_user("t") is None
    assert auth.fetch_auth_user("t") is None
    assert len(calls) == 2


def test_accepted_user_is_cached_until_ttl(monkeypatch):
    calls = _auth_server(monkeypatch, _auth_user())
    auth.fetch_auth_user("t")
    auth.fetch_auth_user("t")
    assert len(calls) == 1
    digest = auth._token_digest("t")
    stored_at, user = auth._auth_user_cache[digest]
    auth._auth_user_cache[digest] = (stored_at - auth.AUTH_USER_CACHE_TTL_SECONDS - 1, user)
    auth.fetch_auth_user("t")
    assert len(calls) == 2
    # キャッシュのキーにトークンそのものを持たない
    assert "t" not in auth._auth_user_cache


# --- ログに機微情報を出さない ---


def test_rejection_logs_do_not_contain_email_or_token(monkeypatch, caplog):
    _auth_server(monkeypatch, _auth_user(identities=[_identity("github")]))
    token = _es256_token()
    with caplog.at_level(logging.INFO, logger="backend.auth"):
        assert _status(token) == 403
    text = caplog.text
    assert "not a verified Google login" in text
    assert "providers=github" in text
    assert EMAIL not in text
    assert token not in text


def test_kidless_failure_log_describes_token_without_secrets(monkeypatch, caplog):
    _auth_server(monkeypatch, None)
    token = _hs256_token()
    with caplog.at_level(logging.INFO, logger="backend.auth"):
        assert _status(token) == 401
    text = caplog.text
    assert "alg=HS256 kid=no iss_match=True role=authenticated expired=False" in text
    assert EMAIL not in text
    assert token not in text
