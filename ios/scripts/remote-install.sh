#!/usr/bin/env bash
# subpc から Tailscale 越しに Mac mini へ入って install-to-iphone.sh を実行する（#568）。
# iPhone は Mac mini に USB で繋ぎ、ロックを解除しておく。
#
#   ios/scripts/remote-install.sh
#
# 環境変数（すべて任意）:
#   MAC_HOST      SSH先（既定 guchimac-mini）
#   MAC_REPO_DIR  Mac mini 上のチェックアウト（既定 ~/apps/myroom）
#   IOS_BRANCH / IOS_DEVICE / IOS_SKIP_PULL は install-to-iphone.sh へそのまま渡す
set -euo pipefail

HOST="${MAC_HOST:-guchimac-mini}"
REPO_DIR="${MAC_REPO_DIR:-\$HOME/apps/myroom}"

# 値は printf %q で引用して渡す（リモートのシェルで安全に展開させる）
pass=""
for name in IOS_BRANCH IOS_DEVICE IOS_SKIP_PULL; do
  if [ -n "${!name:-}" ]; then
    pass+="$name=$(printf '%q' "${!name}") "
  fi
done

# SSH に渡したコマンドはログインシェルで動かないため、Homebrew などの PATH（node）が通らない。
# 実行は zsh -lc 経由にする。リモートで実行する1行のスクリプトは printf %q で引用して渡す。
remote() {
  ssh "$@" "zsh -lc $(printf '%q' "$REMOTE_SCRIPT")"
}

cd_repo="cd \"$REPO_DIR\" 2>/dev/null || { echo \"$REPO_DIR が Mac mini に無いため中止します。MAC_REPO_DIR で場所を指定してください。\" >&2; exit 1; }"

# 取り込みは install-to-iphone.sh の中ではなく、ここで先に済ませる。
# チェックアウトが古くてスクリプト自体がまだ無いと、呼び出しが No such file or directory になるため。
if [ "${IOS_SKIP_PULL:-}" != "1" ]; then
  branch="$(printf '%q' "${IOS_BRANCH:-main}")"
  REMOTE_SCRIPT="$cd_repo; if [ -n \"\$(git status --porcelain)\" ]; then echo '作業ツリーに未コミットの変更があるため中止します。退避してから再実行するか、IOS_SKIP_PULL=1 を付けてください。' >&2; exit 1; fi; git fetch origin $branch && git checkout $branch && git merge --ff-only origin/$branch"
  remote "$HOST"
fi

# xcodebuild の署名はログインキーチェーンを使う。SSH 経由では自動で開かないため、
# 同じ接続の中でビルドの前に解除する（別の ssh で解除しても次の接続には引き継がれず、
# errSecInternalComponent で署名に失敗する）。パスワードの入力があるので -t が要る。
# 取り込みは済んでいるので install-to-iphone.sh 側では省く。
REMOTE_SCRIPT="$cd_repo; security unlock-keychain ~/Library/Keychains/login.keychain-db && ${pass}IOS_SKIP_PULL=1 bash ios/scripts/install-to-iphone.sh"
remote -t "$HOST"
