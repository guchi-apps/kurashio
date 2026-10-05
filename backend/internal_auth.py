"""サーバー間参照用の固定トークン認証。

画面向けのAPIは `auth.get_current_user`（Supabase のユーザーJWT）を必須にしているため、
ログイン画面を通れない別プロセス——同じVPS上で動く AIDE の MCP サーバー
（guchi-apps/aide#101）——からは読めない。そこで**読み取り専用の内部APIに限って**、
`Authorization: Bearer` の固定トークンで通る経路を用意する。

ops-dashboard の `OPS_API_TOKEN`（`requireSessionOrApiToken`）と同じ形。違いは、
こちらはログインセッションを併用せず**サーバー間専用**にしている点だけ。

トークンは用途ごとに分けている（DaySpan の `INTERNAL_EVENTS_API_KEY` と同じ分け方）。

取得元は issue-deck の共有トークン（`MYROOM_INTERNAL_API_KEY`・`MYROOM_INTERNAL_CONTROL_API_KEY`。
`backend/shared_token.py`）を優先し、取れなければ下の環境変数へフォールバックする（#525）。

- `INTERNAL_API_KEY` … 読み取り専用（`GET /api/internal/room-state`）
- `INTERNAL_CONTROL_API_KEY` … 操作専用（`/api/internal/remote/…`・#419、`/api/internal/aircon/…`・#439）
- `COLLECTOR_API_KEY` … サブPCの収集専用（消費電力の再取得 `/api/energy/refetch/request`・`/done`・#714）。
  共有トークンは使わず環境変数だけ。既存の2つのキーの用途は広げていない

**片方のトークンでもう片方の経路は通らない。** 読み取り用が漏れても操作の口は塞がったままに
するための分け方なので、1つの依存にまとめて「どちらでも通す」形にしないこと。

対応する環境変数が未設定なら常に 503 を返す。401（値が違う）と切り分けられるのは
呼ぶ側にとって重要で、AIDE 側は 503 を「相手側でAPIキーが未設定」、401 を
「トークンが一致しない」と表示し分けている。
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Optional

from dotenv import load_dotenv
from fastapi import Header, HTTPException, status

from backend.shared_token import get_shared_token

load_dotenv()

ENV_VAR_NAME = "INTERNAL_API_KEY"
CONTROL_ENV_VAR_NAME = "INTERNAL_CONTROL_API_KEY"
COLLECTOR_ENV_VAR_NAME = "COLLECTOR_API_KEY"

# issue-deck の共有トークン名（#525）。取れなければ上の環境変数へフォールバックする
SHARED_TOKEN_NAME = "MYROOM_INTERNAL_API_KEY"
CONTROL_SHARED_TOKEN_NAME = "MYROOM_INTERNAL_CONTROL_API_KEY"


def _read_token(env_var_name: str, shared_token_name: str) -> Optional[str]:
    """共有トークン（issue-deck）、無ければ環境変数のトークン。空文字は「未設定」として扱う。

    モジュール読み込み時ではなく都度読むのは、テストが `monkeypatch.setenv` で
    差し替えられるようにするため。デプロイは未登録の secret を空文字で `.env` へ書くので、
    空を「未設定」に倒しておかないと、空のトークンで通る口ができてしまう。
    """
    shared = get_shared_token(shared_token_name)
    if shared:
        return shared
    value = os.getenv(env_var_name)
    return value if value else None


def get_internal_api_key() -> Optional[str]:
    """読み取り用トークン（`INTERNAL_API_KEY`）。"""
    return _read_token(ENV_VAR_NAME, SHARED_TOKEN_NAME)


def get_internal_control_api_key() -> Optional[str]:
    """操作用トークン（`INTERNAL_CONTROL_API_KEY`）。"""
    return _read_token(CONTROL_ENV_VAR_NAME, CONTROL_SHARED_TOKEN_NAME)


def _token_matches(provided: str, expected: str) -> bool:
    """定数時間で比較する。長さの違いで早期に抜けないようダイジェスト同士を突き合わせる。"""
    provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(provided_digest, expected_digest)


def _check_bearer(
    authorization: Optional[str], env_var_name: str, expected: Optional[str]
) -> None:
    """Bearer トークンを `expected` と突き合わせる。通れば None、通らなければ 503 / 401。"""
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{env_var_name} is not configured",
        )

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or not _token_matches(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_internal_token(
    authorization: Optional[str] = Header(default=None),
) -> None:
    """読み取り用の内部API向けの依存（`INTERNAL_API_KEY`）。"""
    _check_bearer(authorization, ENV_VAR_NAME, get_internal_api_key())


def require_internal_control_token(
    authorization: Optional[str] = Header(default=None),
) -> None:
    """操作用の内部API向けの依存（`INTERNAL_CONTROL_API_KEY`）。

    読み取り用の `INTERNAL_API_KEY` では通らない。
    """
    _check_bearer(authorization, CONTROL_ENV_VAR_NAME, get_internal_control_api_key())


def get_collector_api_key() -> Optional[str]:
    """収集用トークン（`COLLECTOR_API_KEY`）。共有トークンは無く、環境変数だけを見る。"""
    value = os.getenv(COLLECTOR_ENV_VAR_NAME)
    return value if value else None


def require_collector_token(
    authorization: Optional[str] = Header(default=None),
) -> None:
    """サブPCの収集向けの依存（`COLLECTOR_API_KEY`・#714）。

    読み取り用・操作用のどちらのトークンでも通らない。未設定なら無認証へ落とさず 503。
    """
    _check_bearer(authorization, COLLECTOR_ENV_VAR_NAME, get_collector_api_key())
