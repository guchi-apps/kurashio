# kurashio Deployment Guide

Production URL: **https://myroom.gucchii.com/**

## Quick Start

```bash
scp -r /path/to/myroom user@your-server:/home/user/
cd myroom
sudo ./deployment/setup_on_target.sh
```

Configure Apache/Nginx using `deployment/apache.conf` or `deployment/nginx.conf`.

## URLs

| 用途 | URL |
|------|-----|
| アプリ | https://myroom.gucchii.com/ |
| API | https://myroom.gucchii.com/api/sensor |
| ヘルスチェック | https://myroom.gucchii.com/api/health |

## Raspberry Pi

```env
MYROOM_API_URL=https://myroom.gucchii.com/api/sensor
```

## シークレットは「登録しただけ」では本番に反映されない

GitHub Secret（`INTERNAL_API_KEY`・`INTERNAL_CONTROL_API_KEY` 等）を追加・更新しても、本番VPSの `.env` は自動では書き換わらない。

`.env` を書いているのは `Deploy to Production`（`.github/workflows/deploy.yml`）の
`Restart Backend Service` ステップにある `sync_env_var` で、**これはデプロイのときにしか走らない**。
つまり値が `.env` に入るのは「Secret を登録した**後**に走ったデプロイ」からで、
登録より前のデプロイが最後のままなら本番のプロセスには入っていない。

`Sync secrets`（`sync-secrets.yml`）は 1Password → GitHub Secrets の同期までで、
GitHub Secrets → 本番 `.env` は行わない。ここも混同しやすい。

### 症状の切り分け

`INTERNAL_API_KEY` が本番プロセスに無いと、内部APIは常に 503 を返す
（`backend/internal_auth.py` の `require_internal_token()`）。401 は「値が違う」なので別。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://myroom.gucchii.com/api/internal/room-state
# 503 … INTERNAL_API_KEY が未設定（= デプロイが足りていない）
# 401 … 設定はされている（トークン不一致。今回はトークン無しで叩いているので401が正常）
```

照明・エアコンを操作する内部API（`/api/internal/remote/…`・#419、`/api/internal/aircon/…`・#439）は**別のトークン**
`INTERNAL_CONTROL_API_KEY` を見る。切り分けは同じで、こちらも未設定なら常に 503。

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://myroom.gucchii.com/api/internal/remote/buttons
# 503 … INTERNAL_CONTROL_API_KEY が未設定（Secret が未登録、または登録後にデプロイしていない）
# 401 … 設定はされている（トークン無しで叩いているので401が正常）
```

Secret の登録時刻と最後のデプロイ時刻を比べると確定できる。

```bash
gh api repos/guchi-apps/myroom/actions/secrets --jq '.secrets[] | select(.name=="INTERNAL_API_KEY") | .updated_at'
gh run list --repo guchi-apps/myroom --workflow deploy.yml --limit 1 --json createdAt,conclusion
```

### 対処

`main` に対してデプロイを流し直す。`main` への通常のマージでも同じ結果になる。

```bash
gh workflow run deploy.yml --repo guchi-apps/myroom --ref main
```

`--ref main` を省略するとデフォルトブランチ（`develop`）の内容で走ってしまうため、**必ず明示する**。
`tag` ジョブは同じバージョンのタグが HEAD を指していれば何もせず通るので、再実行は冪等。
