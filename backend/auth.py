import hashlib
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

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

# Auth サーバー（`/auth/v1/user`）へ問い合わせるときの apikey。フロントに公開している値と同じで、
# 秘密ではない。kid の無いトークンの検証と、Googleの identity の確認に使う（#724）。
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
SUPABASE_USER_URL = f"{SUPABASE_ISSUER}/user"

# Auth サーバーの応答をトークンごとに覚える秒数。ダッシュボードは30秒ごとに数本のAPIを叩くので、
# 毎回問い合わせない。短くしてあるのは、共有アカウント側でのセッション失効・identity の解除を
# この時間のうちに反映するため。
AUTH_USER_CACHE_TTL_SECONDS = 300
AUTH_USER_CACHE_MAX_ENTRIES = 256

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


class AuthServerUnavailableError(Exception):
    """Auth サーバーへ問い合わせられず、トークンの正否を判定できない。"""


# sha256(トークン) -> (覚えた時刻, ユーザー)。トークンそのものはキーにも値にも持たない。
_auth_user_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_auth_user_lock = threading.Lock()


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _request_auth_user(token: str) -> Optional[Dict[str, Any]]:
    """Auth サーバーにトークンを渡し、そのトークンの持ち主を返す。拒否されたら None。

    Auth サーバーは署名・有効期限・セッションの失効を自分の鍵で判定する。こちらが
    トークン自身のヘッダーの alg を信じて検証方法を選ぶ必要が無い。
    """
    if not SUPABASE_PUBLISHABLE_KEY:
        raise AuthServerUnavailableError("SUPABASE_PUBLISHABLE_KEY is not set")
    try:
        response = requests.get(
            SUPABASE_USER_URL,
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": f"Bearer {token}",
            },
            timeout=5,
        )
    except requests.RequestException as exc:
        raise AuthServerUnavailableError(type(exc).__name__) from exc
    # 400/401/403/404/422 は「このトークンは通らない」（失効・別プロジェクト・ユーザー削除など）
    if 400 <= response.status_code < 500 and response.status_code != 429:
        return None
    if response.status_code != 200:
        raise AuthServerUnavailableError(f"HTTP {response.status_code}")
    try:
        user = response.json()
    except ValueError as exc:
        raise AuthServerUnavailableError("invalid JSON") from exc
    if not isinstance(user, dict) or not user.get("id"):
        raise AuthServerUnavailableError("unexpected response")
    return user


def fetch_auth_user(token: str) -> Optional[Dict[str, Any]]:
    """`_request_auth_user()` を短時間だけ覚えて返す。拒否（None）は覚えない。"""
    digest = _token_digest(token)
    now = time.monotonic()
    with _auth_user_lock:
        cached = _auth_user_cache.get(digest)
        if cached and now - cached[0] < AUTH_USER_CACHE_TTL_SECONDS:
            return cached[1]
    user = _request_auth_user(token)
    if user is None:
        return None
    with _auth_user_lock:
        if len(_auth_user_cache) >= AUTH_USER_CACHE_MAX_ENTRIES:
            for key, (stored_at, _) in list(_auth_user_cache.items()):
                if now - stored_at >= AUTH_USER_CACHE_TTL_SECONDS:
                    del _auth_user_cache[key]
            if len(_auth_user_cache) >= AUTH_USER_CACHE_MAX_ENTRIES:
                _auth_user_cache.clear()
        _auth_user_cache[digest] = (now, user)
    return user


def _describe_unverified(token: str) -> str:
    """拒否の理由を切り分けるための、機微情報を含まない要約（#724）。

    トークン全文・メール・sub は出さない。ヘッダーの alg と kid の有無、発行元がこのプロジェクトか、
    role（anon / service_role なら APIキーを Bearer に載せている）だけを残す。値は未検証。
    """
    try:
        header = jwt.get_unverified_header(token)
        claims = jwt.get_unverified_claims(token)
    except JWTError:
        return "not a JWT"
    alg = str(header.get("alg", ""))[:10]
    role = str(claims.get("role", ""))[:20]
    iss_match = claims.get("iss") == SUPABASE_ISSUER
    exp = claims.get("exp")
    expired = isinstance(exp, (int, float)) and exp < time.time()
    return f"alg={alg} kid={'yes' if header.get('kid') else 'no'} iss_match={iss_match} role={role} expired={expired}"


def _verify_without_kid(token: str) -> Dict[str, Any]:
    """kid の無いトークンを、Auth サーバーの判定で検証する（#724）。

    kid が無いことは「HS256 の旧JWTシークレットで署名された」可能性を示すだけで、断定できない。
    手元に HS256 の鍵は持たず、トークンの alg も採用しない。Auth サーバーが受け付けた場合だけ、
    クレームの発行元・audience・有効期限・sub を手元でも突き合わせる。
    """
    user = fetch_auth_user(token)
    if user is None:
        raise JWTError("Rejected by Supabase Auth server")
    payload = jwt.get_unverified_claims(token)
    if payload.get("iss") != SUPABASE_ISSUER:
        raise JWTError("Invalid issuer")
    aud = payload.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if SUPABASE_AUDIENCE not in audiences:
        raise JWTError("Invalid audience")
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp <= time.time():
        raise JWTError("Signature has expired")
    if payload.get("sub") != user.get("id"):
        raise JWTError("Subject does not match Supabase Auth user")
    return payload


def verify_token(token: str) -> Dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if not kid:
            payload = _verify_without_kid(token)
            logger.info("Supabase JWT without kid verified by Auth server (%s)", _describe_unverified(token))
            return payload
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
    except (JwksUnavailableError, AuthServerUnavailableError) as exc:
        logger.warning("Supabase JWT verification unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="認証サーバーに接続できません。しばらくしてからやり直してください",
        ) from exc
    except JWTError as exc:
        logger.warning(
            "Supabase JWT verification failed: %s (%s)", exc, _describe_unverified(token)
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return payload


def _mask_email(email: str) -> str:
    """ログに残すメールを伏せる（先頭1文字とドメインだけ）。"""
    local, sep, domain = email.partition("@")
    if not sep:
        return "(none)" if not email else "***"
    return f"{local[:1]}***@{domain}"


def _amr_methods(payload: Dict[str, Any]) -> List[str]:
    amr = payload.get("amr")
    if not isinstance(amr, list):
        return []
    methods = []
    for entry in amr:
        if isinstance(entry, dict) and isinstance(entry.get("method"), str):
            methods.append(entry["method"])
        elif isinstance(entry, str):
            methods.append(entry)
    return methods


def _google_login_rejection(payload: Dict[str, Any], user: Dict[str, Any]) -> Optional[str]:
    """Googleで確かめたアカウントのログインでなければ、その理由（ログ用・機微情報なし）を返す。

    共有の Supabase アカウントには複数のプロバイダーが紐付く（IssueDeck は GitHub、ここは Google）。
    **`app_metadata.provider` は最初に作られたときのプロバイダーのまま変わらない**ため、GitHub で
    先に作られたアカウントが Google でログインしても `github` になる（#724 の 403）。また
    `user_metadata` は利用者が `updateUser()` で書き換えられるので、本人確認の根拠にしない。

    根拠にするのは次の2つで、どちらも利用者が書き換えられない。
    - トークンの `amr` に `oauth` がある（パスワード・OTP・匿名のセッションではない）
    - Auth サーバーが返す identities に、トークンのメールと一致し、Google が確認済みとした
      Google の identity がある（identity_data はプロバイダーから受け取った値で、利用者は編集できない）

    Supabase のアクセストークンには「このセッションをどのプロバイダーで作ったか」が載らないため、
    同じアカウントに紐付いた別の OAuth（GitHub など）のセッションとは区別できない。その場合も
    Supabase が確認済みメールで同一アカウントへ結び付けたものに限られる。
    """
    if payload.get("is_anonymous") is True:
        return "anonymous session"
    methods = _amr_methods(payload)
    if "oauth" not in methods:
        return f"not an OAuth session (amr={','.join(methods)[:40] or 'none'})"
    email = str(payload.get("email", "")).lower()
    if str(user.get("email", "")).lower() != email:
        return "token email differs from Auth user"
    identities = user.get("identities")
    if not isinstance(identities, list):
        return "no identities"
    providers = []
    for identity in identities:
        if not isinstance(identity, dict):
            continue
        provider = identity.get("provider")
        providers.append(str(provider))
        if provider != "google":
            continue
        data = identity.get("identity_data")
        if not isinstance(data, dict):
            continue
        if str(data.get("email", "")).lower() == email and data.get("email_verified") is True:
            return None
    return f"no verified Google identity for the email (providers={','.join(sorted(providers))[:60]})"


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
        logger.warning("Login rejected: email not in allowlist (%s)", _mask_email(email))
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このGoogleアカウントではログインできません",
        )
    # Supabaseは他アプリと共有のプロジェクト。メール/パスワード登録などで許可リストの
    # アドレスを名乗れてしまわないよう、Googleで確認済みのアカウントのOAuthログインだけ通す（#616）。
    try:
        user = fetch_auth_user(token)
    except AuthServerUnavailableError as exc:
        logger.warning("Supabase Auth user lookup unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="認証サーバーに接続できません。しばらくしてからやり直してください",
        ) from exc
    if user is None:
        logger.warning("Login rejected: session not accepted by Supabase Auth (%s)", _mask_email(email))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.get("id") != payload.get("sub"):
        logger.warning("Login rejected: Auth user does not match token subject (%s)", _mask_email(email))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    reason = _google_login_rejection(payload, user)
    if reason:
        logger.warning(
            "Login rejected: not a verified Google login (%s): %s", _mask_email(email), reason
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このGoogleアカウントではログインできません",
        )
    return payload
