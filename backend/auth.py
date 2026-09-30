import logging
import os
import threading
import time
from typing import Any, Dict, Optional

import requests
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

load_dotenv()

logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
if not SUPABASE_URL:
    raise RuntimeError("SUPABASE_URL environment variable is required")
SUPABASE_URL = SUPABASE_URL.rstrip("/")

SUPABASE_ISSUER = f"{SUPABASE_URL}/auth/v1"
SUPABASE_JWKS_URL = f"{SUPABASE_ISSUER}/.well-known/jwks.json"
SUPABASE_AUDIENCE = "authenticated"
JWKS_CACHE_TTL_SECONDS = 3600

# Supabaseが署名に使うアルゴリズムの固定値。検証対象のトークン自身のヘッダー（未検証・
# 攻撃者が書き換え可能）からは取らない。JWKSのキーがalgを持っていればそちらを優先する。
ALLOWED_ALGORITHMS = ("ES256", "RS256")

ALLOWED_GOOGLE_EMAILS = {
    email.strip().lower()
    for email in os.getenv("ALLOWED_GOOGLE_EMAILS", "").split(",")
    if email.strip()
}

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token", auto_error=False)

# 未知のkidによる再取得の最小間隔。kidは未検証のトークンのヘッダーから取った値なので、
# でたらめなkidを送るだけでSupabaseへのリクエストを起こせてしまうのを防ぐ。
JWKS_REFETCH_MIN_INTERVAL_SECONDS = 60

# kid -> JWK の辞書。Supabase側のキーローテーションに追従できるよう、
# 未知のkidに出会ったら（最小間隔を空けて）再フェッチする。
# fetched_at は成功した時刻、attempted_at は成功・失敗を問わず最後に取りに行った時刻。
_jwks_cache: Dict[str, Any] = {"keys_by_kid": {}, "fetched_at": None, "attempted_at": None}
_jwks_lock = threading.Lock()


class JwksUnavailableError(Exception):
    """JWKSを取得できず、検証に使える鍵も手元に無い。"""


def _fetch_jwks() -> Dict[str, Any]:
    response = requests.get(SUPABASE_JWKS_URL, timeout=5)
    response.raise_for_status()
    keys = response.json().get("keys", [])
    return {key["kid"]: key for key in keys if "kid" in key}


def _get_signing_key(kid: str) -> Dict[str, Any]:
    with _jwks_lock:
        now = time.monotonic()
        fetched_at = _jwks_cache["fetched_at"]
        attempted_at = _jwks_cache["attempted_at"]
        keys_by_kid = _jwks_cache["keys_by_kid"]

        is_stale = fetched_at is None or now - fetched_at > JWKS_CACHE_TTL_SECONDS
        needs_fetch = is_stale or kid not in keys_by_kid
        throttled = (
            attempted_at is not None
            and now - attempted_at < JWKS_REFETCH_MIN_INTERVAL_SECONDS
        )
        if needs_fetch and not throttled:
            _jwks_cache["attempted_at"] = now
            try:
                _jwks_cache["keys_by_kid"] = _fetch_jwks()
                _jwks_cache["fetched_at"] = now
            except (requests.RequestException, ValueError, KeyError) as exc:
                # 古いキャッシュが残っていればそれで検証を続ける。
                logger.warning("JWKS fetch failed: %s", exc)
                if not _jwks_cache["keys_by_kid"]:
                    raise JwksUnavailableError(str(exc)) from exc
            keys_by_kid = _jwks_cache["keys_by_kid"]

        key = keys_by_kid.get(kid)
        if not key:
            if not keys_by_kid:
                raise JwksUnavailableError("JWKS is not available")
            raise JWTError(f"Unknown JWT key id: {kid}")
        return key


def verify_token(token: str) -> Dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if not kid:
            raise JWTError("Missing kid in token header")
        key = _get_signing_key(kid)
        alg = key.get("alg", "ES256")
        if alg not in ALLOWED_ALGORITHMS:
            raise JWTError(f"Unsupported JWT alg: {alg}")
        payload = jwt.decode(
            token,
            key,
            algorithms=[alg],
            audience=SUPABASE_AUDIENCE,
            issuer=SUPABASE_ISSUER,
        )
    except JwksUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="認証サーバーに接続できません。しばらくしてからやり直してください",
        ) from exc
    except JWTError as exc:
        logger.warning("Supabase JWT verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return payload


def _is_verified_google_login(payload: Dict[str, Any]) -> bool:
    app_metadata = payload.get("app_metadata")
    if not isinstance(app_metadata, dict) or app_metadata.get("provider") != "google":
        return False
    user_metadata = payload.get("user_metadata")
    if not isinstance(user_metadata, dict):
        user_metadata = {}
    # Googleログインでは user_metadata.email_verified に入る。トップレベルも念のため見る。
    verified = user_metadata.get("email_verified", payload.get("email_verified"))
    return verified is True


# 同期関数にしてスレッドプールで動かす（JWKS取得の同期HTTPでイベントループを止めない）。
def get_current_user(token: str = Depends(oauth2_scheme)) -> Dict[str, Any]:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = verify_token(token)
    email = str(payload.get("email", "")).lower()
    if email not in ALLOWED_GOOGLE_EMAILS:
        logger.warning("Login rejected: email not in allowlist (%s)", email)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このGoogleアカウントではログインできません",
        )
    # Supabaseは他アプリと共有のプロジェクト。メール/パスワード登録などで許可リストの
    # アドレスを名乗れてしまわないよう、Googleログインかつメール確認済みのトークンだけ通す。
    if not _is_verified_google_login(payload):
        logger.warning("Login rejected: not a verified Google login (%s)", email)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このGoogleアカウントではログインできません",
        )
    return payload
