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

# xcodebuild の署名はログインキーチェーンを使う。SSH 経由では自動で開かないため、
# ロックされていると codesign が失敗する（README「Mac miniへSSHで入れ直す」）。
ssh -t "$HOST" "cd \"$REPO_DIR\" 2>/dev/null || { echo \"$REPO_DIR が Mac mini に無いため中止します。MAC_REPO_DIR で場所を指定してください。\" >&2; exit 1; }; ${pass}bash ios/scripts/install-to-iphone.sh"
