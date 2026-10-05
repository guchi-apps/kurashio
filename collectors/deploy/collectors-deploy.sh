#!/usr/bin/env bash
# サブPC上の collector をリリース（vX.Y.Z タグ）に追従させる。
#
#   collectors-deploy.sh [deploy]   最新リリースへ追従する（systemd timer から15分ごと）
#   collectors-deploy.sh status     いま動いているバージョンと各 collector の状態を出す（--json 可）
#
# 設計（#707）:
#   - main の先端ではなく **origin/main に含まれる最新の vX.Y.Z タグ** だけを配る。
#     リリース前のコミットがサブPCへ届かず、「どのリリースが動いているか」がタグで分かる。
#   - VPS の deploy.yml とは独立（サブPCがオフラインでも本番デプロイは巻き込まれない）。
#   - 作業ツリーがdirty・fast-forwardできない・main以外のブランチ、のときは何も変えずに失敗する。
#   - 依存の更新に失敗したら元のコミットへ戻す（壊れた組み合わせを残さない）。
#   - 対象の判定は unit の ExecStart から導く（スクリプト名・.venv-X → requirements-X.txt）ので、
#     collector を足したときは collectors/systemd/ に unit を置くだけでよい。
set -uo pipefail

REPO="${MYROOM_REPO:-$HOME/apps/myroom}"
STATE_DIR="${MYROOM_COLLECTORS_STATE:-$HOME/.local/state/myroom-collectors}"
UNIT_DIR="$HOME/.config/systemd/user"
STATUS_FILE="$STATE_DIR/deploy.json"
# origin/main より何リリース遅れたら異常とみなすか（status）
MAX_BEHIND_RELEASES="${MAX_BEHIND_RELEASES:-0}"
# デプロイの最終成功からこの秒数を超えたら異常（status。timer が止まっていないか）
MAX_DEPLOY_AGE_SECONDS="${MAX_DEPLOY_AGE_SECONDS:-7200}"
# oneshot の collector が最後に成功してからこの秒数を超えたら異常
MAX_COLLECTOR_AGE_SECONDS="${MAX_COLLECTOR_AGE_SECONDS:-93600}"

# git merge でこのファイル自身が差し替わると、実行中の bash が途中から別の内容を読む。
# コピーを作ってそちらから実行し直す。
if [ "${1:-deploy}" = deploy ] && [ -z "${MYROOM_DEPLOY_COPY:-}" ]; then
  mkdir -p "$STATE_DIR"
  cp "$0" "$STATE_DIR/collectors-deploy.run.sh" && MYROOM_DEPLOY_COPY=1 exec bash "$STATE_DIR/collectors-deploy.run.sh" "$@"
fi

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

write_status() { # result message
  mkdir -p "$STATE_DIR"
  jq -n --arg result "$1" --arg message "$2" \
    --arg sha "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" \
    --arg tag "$(git -C "$REPO" describe --tags --exact-match HEAD 2>/dev/null)" \
    --arg at "$(date -Is)" \
    --argjson ts "$(date +%s)" \
    --arg prev "$(jq -r '.last_success_at // empty' "$STATUS_FILE" 2>/dev/null)" \
    --argjson prevts "$(jq -r '.last_success_ts // 0' "$STATUS_FILE" 2>/dev/null || echo 0)" \
    '{result:$result, message:$message, sha:$sha, tag:$tag, checked_at:$at, checked_ts:$ts,
      last_success_at:(if $result=="ok" then $at else $prev end),
      last_success_ts:(if $result=="ok" then $ts else $prevts end)}' \
    >"$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

fail() { log "失敗: $*"; write_status failed "$*"; exit 1; }

# unit の ExecStart から、その collector が依存するファイルを導く
unit_script() { grep -oE 'collectors/[A-Za-z0-9_]+\.py' "$1" | head -1; }
unit_requirements() {
  local venv; venv=$(grep -oE '\.venv-[A-Za-z0-9_]+' "$1" | head -1) || true
  [ -n "$venv" ] && echo "collectors/requirements-${venv#.venv-}.txt"
}

deploy() {
  command -v jq >/dev/null || { log "jq が必要です"; exit 1; }
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/deploy.lock"
  flock -n 9 || { log "別のデプロイが実行中"; exit 0; }

  cd "$REPO" || fail "リポジトリが見つからない: $REPO"
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || fail "main 以外のブランチ($branch)にいるため更新しない"
  [ -z "$(git status --porcelain)" ] || fail "作業ツリーにローカル変更があるため更新しない（上書きしない）"

  git fetch --quiet --tags origin main || fail "git fetch に失敗（オフライン？）"

  target_tag="${DEPLOY_REF:-$(git tag --merged origin/main --list 'v[0-9]*' --sort=-v:refname | head -1)}"
  [ -n "$target_tag" ] || fail "origin/main に含まれるリリースタグが無い"
  target=$(git rev-parse "$target_tag^{commit}") || fail "タグを解決できない: $target_tag"
  prev=$(git rev-parse HEAD)

  if [ "$prev" != "$target" ]; then
    git merge-base --is-ancestor "$prev" "$target" || fail "fast-forward できない（$prev → $target_tag）。手で確認が必要"
    git merge --ff-only --quiet "$target" || fail "git merge --ff-only に失敗"
    log "更新: ${prev:0:7} → $target_tag (${target:0:7})"
  else
    log "最新のリリース $target_tag のまま"
  fi

  changed=$(git diff --name-only "$prev" "$target" -- collectors/ 2>/dev/null)

  # --- 依存（専用 venv）。失敗したら元のコミットへ戻す ---
  declare -A restart_units=()
  for unit in collectors/systemd/*.service; do
    name=$(basename "$unit" .service)
    script=$(unit_script "$unit"); req=$(unit_requirements "$unit")
    venv_dir=""; [ -n "$req" ] && venv_dir="collectors/.venv-${req#collectors/requirements-}"; venv_dir="${venv_dir%.txt}"
    need_deps=0
    if [ -n "$req" ]; then
      [ -x "$venv_dir/bin/python" ] || need_deps=1
      grep -qxF "$req" <<<"$changed" && need_deps=1
    fi
    if [ "$need_deps" = 1 ]; then
      log "依存を更新: $req"
      if { [ -x "$venv_dir/bin/python" ] || python3 -m venv "$venv_dir"; } \
        && "$venv_dir/bin/pip" install --quiet -r "$req"; then
        :
      else
        git reset --hard --quiet "$prev"
        fail "依存の更新に失敗（$req）。${prev:0:7} に戻した"
      fi
      restart_units[$name]=1
    fi
    # コードが変わった collector
    [ -n "$script" ] && grep -qxF "$script" <<<"$changed" && restart_units[$name]=1
    # unit が変わった
    grep -qE "^collectors/systemd/$name\.(service|timer)$" <<<"$changed" && restart_units[$name]=1
  done
  # 共有モジュール（どの unit の ExecStart にも無い collectors/*.py）が変わったら全部
  shared=$(grep -E '^collectors/[A-Za-z0-9_]+\.py$' <<<"$changed" | while read -r f; do
    grep -qlF "$f" collectors/systemd/*.service 2>/dev/null || echo "$f"; done)
  if [ -n "$shared" ]; then
    for unit in collectors/systemd/*.service; do restart_units[$(basename "$unit" .service)]=1; done
  fi

  # --- unit の同期 ---
  mkdir -p "$UNIT_DIR"
  unit_changed=0
  for f in collectors/systemd/*.service collectors/systemd/*.timer; do
    dest="$UNIT_DIR/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then
      cp "$f" "$dest"; unit_changed=1; log "unit を配置: $(basename "$f")"
      restart_units[$(basename "${f%.*}")]=1
    fi
  done
  [ "$unit_changed" = 1 ] && systemctl --user daemon-reload

  # --- 有効化と再起動（常駐は変わったものだけ、timer は変わった unit の timer だけ） ---
  problems=()
  for f in collectors/systemd/*.timer; do
    t=$(basename "$f")
    systemctl --user is-enabled --quiet "$t" 2>/dev/null || systemctl --user enable --now "$t" 2>/dev/null
    [ -n "${restart_units[${t%.timer}]:-}" ] && systemctl --user restart "$t"
  done
  for f in collectors/systemd/*.service; do
    n=$(basename "$f" .service)
    grep -q '^Type=simple' "$f" || continue
    grep -q '^\[Install\]' "$f" || continue
    systemctl --user is-enabled --quiet "$n.service" 2>/dev/null || systemctl --user enable "$n.service" 2>/dev/null
    if [ -n "${restart_units[$n]:-}" ] || ! systemctl --user is-active --quiet "$n.service"; then
      systemctl --user restart "$n.service"
    fi
  done

  # --- 確認: 常駐は起動し続けているか、変えた oneshot は1回走らせて成功するか ---
  sleep 5
  for f in collectors/systemd/*.service; do
    n=$(basename "$f" .service)
    [ "$n" = myroom-collectors-deploy ] && continue
    if grep -q '^Type=simple' "$f"; then
      systemctl --user is-active --quiet "$n.service" || problems+=("$n が起動していない")
    elif [ -n "${restart_units[$n]:-}" ]; then
      systemctl --user reset-failed "$n.service" 2>/dev/null
      systemctl --user start --wait "$n.service" || problems+=("$n の実行に失敗")
    fi
  done

  if [ ${#problems[@]} -gt 0 ]; then
    fail "更新後の確認で異常: ${problems[*]}（${target_tag} は配置済み。journalctl --user -u <unit> を見る）"
  fi
  write_status ok "$target_tag"
  log "完了: $target_tag"
}

status() {
  cd "$REPO" || exit 2
  json=0; [ "${1:-}" = --json ] && json=1
  sha=$(git rev-parse HEAD); tag=$(git describe --tags --exact-match HEAD 2>/dev/null || git describe --tags HEAD)
  latest=$(git tag --merged origin/main --list 'v[0-9]*' --sort=-v:refname | head -1)
  behind_commits=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
  behind_releases=$(git tag --merged origin/main --list 'v[0-9]*' | while read -r t; do
    git merge-base --is-ancestor "$t" HEAD || echo "$t"; done | wc -l)
  now=$(date +%s); bad=0; units='[]'
  last_ts=$(jq -r '.last_success_ts // 0' "$STATUS_FILE" 2>/dev/null || echo 0)
  result=$(jq -r '.result // "unknown"' "$STATUS_FILE" 2>/dev/null || echo unknown)
  dirty=0; [ -n "$(git status --porcelain)" ] && dirty=1
  [ "$result" = ok ] || bad=1
  [ "$behind_releases" -gt "$MAX_BEHIND_RELEASES" ] && bad=1
  [ $((now - last_ts)) -gt "$MAX_DEPLOY_AGE_SECONDS" ] && bad=1
  [ "$dirty" = 1 ] && bad=1

  for f in collectors/systemd/*.service; do
    n=$(basename "$f" .service); [ "$n" = myroom-collectors-deploy ] && continue
    props=$(systemctl --user show "$n.service" -p ActiveState,SubState,Result)
    active=$(sed -n 's/^ActiveState=//p' <<<"$props"); res=$(sed -n 's/^Result=//p' <<<"$props")
    # 直近の実行結果（新しい順）。連続失敗は先頭から数える
    hist=$(journalctl --user -u "$n.service" -o short-unix --no-pager -n 200 2>/dev/null \
      | grep -E 'Finished |Failed with result' | tac)
    last_ok=$(grep -m1 'Finished ' <<<"$hist" | cut -d' ' -f1 | cut -d. -f1)
    consecutive=$(awk '/Finished /{exit} /Failed with result/{c++} END{print c+0}' <<<"$hist")
    kind=oneshot; grep -q '^Type=simple' "$f" && kind=daemon
    ok=1
    if [ "$kind" = daemon ]; then [ "$active" = active ] || ok=0
    else
      [ "$consecutive" -ge 2 ] && ok=0
      [ -n "$last_ok" ] && [ $((now - last_ok)) -gt "$MAX_COLLECTOR_AGE_SECONDS" ] && ok=0
      [ -z "$last_ok" ] && ok=0
    fi
    [ "$ok" = 1 ] || bad=1
    units=$(jq -c --arg n "$n" --arg kind "$kind" --arg active "$active" --arg res "$res" \
      --arg ok "${last_ok:-}" --argjson c "$consecutive" --argjson good "$ok" \
      '. + [{unit:$n, kind:$kind, active:$active, result:$res, last_success_ts:($ok|tonumber? // null),
             consecutive_failures:$c, healthy:($good==1)}]' <<<"$units")
  done

  if [ "$json" = 1 ]; then
    jq -n --arg sha "$sha" --arg tag "$tag" --arg latest "$latest" --argjson bc "${behind_commits/\?/null}" \
      --argjson br "$behind_releases" --argjson dirty "$dirty" --argjson units "$units" \
      --argjson deploy "$(cat "$STATUS_FILE" 2>/dev/null || echo null)" --argjson healthy "$((1 - bad))" \
      '{sha:$sha, tag:$tag, latest_release:$latest, behind_commits:$bc, behind_releases:$br,
        dirty:($dirty==1), deploy:$deploy, collectors:$units, healthy:($healthy==1)}'
  else
    echo "kurashio collector"
    echo "Version: $tag"; echo "Commit: ${sha:0:7}"
    echo "origin/main: $([ "$behind_releases" = 0 ] && echo "リリース済みの最新に追従" || echo "${behind_releases}リリース遅れ（最新 $latest・$behind_commits コミット）")"
    echo "Last deploy: $(jq -r '"\(if (.last_success_at // "") == "" then "なし" else .last_success_at end)（直近の結果: \(.result)）"' "$STATUS_FILE" 2>/dev/null || echo なし)"
    [ "$dirty" = 1 ] && echo "作業ツリー: ローカル変更あり（デプロイは止まる）"
    echo
    jq -r '.[] | "\(.unit)\t\(if .healthy then "OK" else "NG" end)\t\(.active) 連続失敗=\(.consecutive_failures) 最終成功=\(if .last_success_ts then (.last_success_ts|todate) else "不明" end)"' <<<"$units" | column -t -s$'\t'
  fi
  exit "$bad"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  status) shift; status "$@" ;;
  *) echo "usage: $0 [deploy|status [--json]]" >&2; exit 2 ;;
esac
