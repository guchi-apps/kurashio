#!/bin/bash
# app-deploy-gate（guchi-apps/vps#275・#305）が配布物を展開し .env を更新したあとに呼ぶ手順（#803）。
#
# gate は Node.js のアプリ向けに「lockfile で依存を入れる → prisma → pm2」を持つが、myroom は
# Python（venv・pip・migrate_db.py）なので、このファイルがある間 gate はそれらを動かさずにここを実行する。
# 以前 deploy.yml の「Restart Backend Service」が SSH 先で行っていた手順を、順番を変えずに写してある。
#
# 受け取るもの（gate が渡す）:
#   cwd                   置き場（/home/github-user/apps/<gateのアプリ名>）
#   MIGRATE_DATABASE_URL  マイグレーション専用ユーザーの接続先（mysql://<user>:<pass>@<host>:<port>/<db>）。
#                         .env には書かれない。空なら migrate_db.py がアプリ用ユーザーへフォールバックする（#193）
#   PORT                  待受ポート（ecosystem.config.js が 8000 を持つので使わない）
#
# 稼働版の照合（.env の APP_COMMIT_SHA と /api/app-version の sha）は、終わったあとに gate が行う。
# 失敗したら非0で終わる（set -e）。gate はその時点でデプロイを失敗にする。
set -euo pipefail

echo "Working directory: $(pwd)"

bash deployment/ensure_venv.sh

echo "Ensuring pip is installed..."
./venv/bin/python3 -m ensurepip || true

if ! ./venv/bin/python3 -m pip --version > /dev/null 2>&1; then
  echo "Downloading get-pip.py..."
  curl -sS https://bootstrap.pypa.io/get-pip.py | ./venv/bin/python3
fi

echo "Installing dependencies..."
./venv/bin/python3 -m pip install --upgrade pip
./venv/bin/python3 -m pip install -r requirements.txt

if [ -f "migrate_db.py" ]; then
  echo "Running migrations..."
  # DDLはマイグレーション専用ユーザーで実行する（#193）。常時稼働するバックエンドにDDL権限を渡さないため、
  # .env には書かず、MIGRATE_DATABASE_URL から取り出したユーザー・パスワードをこの1コマンドの間だけ
  # DB_ADMIN_USER / DB_ADMIN_PASSWORD として渡す。値は argv に載せず環境変数のまま渡す。
  # URLのユーザー・パスワードはパーセントエンコードされているので戻す。URLが空なら空文字を渡し、
  # 従来どおり migrate_db.py がアプリ用ユーザーへフォールバックする（.env に古い DB_ADMIN_* が
  # 残っていても load_dotenv は既にある環境変数を上書きしないので、空文字が勝つ）。
  ./venv/bin/python3 - <<'PY'
import os
import sys
from urllib.parse import unquote, urlsplit

url = os.environ.pop("MIGRATE_DATABASE_URL", "") or ""
user = password = ""
if url:
    parts = urlsplit(url)
    user = unquote(parts.username or "")
    password = unquote(parts.password or "")
os.environ["DB_ADMIN_USER"] = user
os.environ["DB_ADMIN_PASSWORD"] = password
os.execv(sys.executable, [sys.executable, "migrate_db.py"])
PY
fi

echo "Managing PM2 process..."
# pm2 restart では cwd が変わらないため、毎回 delete → start する。insight-backend は旧名。
pm2 delete myroom-backend 2> /dev/null || true
pm2 delete insight-backend 2> /dev/null || true
pm2 start ecosystem.config.js
pm2 save
