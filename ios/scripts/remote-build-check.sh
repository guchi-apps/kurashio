#!/usr/bin/env bash
# subpc の作業ツリーの ios/ を Tailscale 越しに Mac へ送り、署名なしでビルドできるか確かめる（#3846）。
# subpc に Xcode が無いため、Swift の変更をコミットする前に「コンパイルが通るか」を見る用途。
# 署名・アーカイブ・TestFlightへのアップロードはしない（それは remote-upload-testflight.sh / CI）。
#
#   ios/scripts/remote-build-check.sh
#
# 環境変数（すべて任意）:
#   MAC_HOST      SSH先（既定 guchimac-mini）。`local` を指すとSSHせずこの機でビルドする。
#                 未指定でも `uname -s` が Darwin（Mac自身）ならローカル実行にする（#880）
#   MAC_WORK_DIR  Mac 上の作業ディレクトリ（既定 /tmp/kurashio-ios-build-check）。毎回この中身を置き換える
#
# 実機での動作（日本語入力・キーボード・TestFlightからの起動）はここでは確かめられない。
set -euo pipefail

HOST="${MAC_HOST:-}"
if [ -z "$HOST" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then HOST=local; else HOST=guchimac-mini; fi
fi
WORK_DIR="${MAC_WORK_DIR:-/tmp/kurashio-ios-build-check}"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 終了コードをパイプで隠さない。生成物は作業ディレクトリ内の DerivedData に閉じる。
# SSH先のログインシェルは macOS 標準の zsh で、Bash固有の ${PIPESTATUS[0]} は取れず tail の成功が返ってしまう。
# そのため bash を明示し、pipefail で xcodebuild の失敗をパイプ越しに伝える（#764）。
# スクリプトは stdin で渡す（シェルの引数クォートを二重に組まない）。
BUILD_SCRIPT="set -o pipefail
cd '$WORK_DIR/ios'
xcodebuild \\
  -project Kurashio.xcodeproj -scheme Kurashio -configuration Debug \\
  -destination 'generic/platform=iOS Simulator' \\
  -derivedDataPath '$WORK_DIR/DerivedData' \\
  CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -n 8"

if [ "$HOST" = "local" ]; then
  # Mac自身では SSH せず、作業ディレクトリへのコピーと DerivedData の置き場は従来どおりにする。
  mkdir -p "$WORK_DIR"
  rsync -a --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$WORK_DIR/ios/"
  printf '%s\n' "$BUILD_SCRIPT" | bash -l -s
else
  ssh "$HOST" "mkdir -p '$WORK_DIR'"
  rsync -az --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$HOST:$WORK_DIR/ios/"
  # ssh は リモートの bash の終了コードをそのまま返す。set -e により失敗はここで非0終了になる。
  printf '%s\n' "$BUILD_SCRIPT" | ssh "$HOST" bash -l -s
fi
