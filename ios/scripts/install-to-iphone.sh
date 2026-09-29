#!/usr/bin/env bash
# Mac mini 上で main を取り込み、Xcode でビルドして接続中の iPhone へ入れ直す（#568）。
# Mac mini のチェックアウトで直接実行するか、subpc から remote-install.sh 経由で呼ぶ。
#
#   ios/scripts/install-to-iphone.sh
#
# 環境変数（すべて任意）:
#   IOS_BRANCH   取り込むブランチ（既定 main。Web側が main へデプロイされた後に入れ直すため）
#   IOS_DEVICE   入れ先の iPhone の識別子か名前（既定は接続中の iPhone を自動選択）
#   IOS_SKIP_PULL=1  git の取り込みを省く（手元の変更をそのままビルドしたいとき）
set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "このスクリプトは Mac（Xcode入り）で実行します。subpc からは ios/scripts/remote-install.sh を使ってください。" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRANCH="${IOS_BRANCH:-main}"
cd "$REPO_ROOT"

if [ "${IOS_SKIP_PULL:-}" != "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "作業ツリーに未コミットの変更があるため中止します。退避してから再実行するか、IOS_SKIP_PULL=1 を付けてください。" >&2
    exit 1
  fi
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git merge --ff-only "origin/$BRANCH"
fi
echo "ビルド対象: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"

# 版番号の食い違いなど、ビルド前に分かるずれを先に止める
node ios/scripts/check-consistency.mjs

# 入れ先の iPhone を決める
DEVICE_JSON="$(mktemp)"
trap 'rm -f "$DEVICE_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICE_JSON" >/dev/null
DEVICE="$(IOS_DEVICE="${IOS_DEVICE:-}" python3 - "$DEVICE_JSON" <<'PY'
import json, os, sys
want = os.environ.get("IOS_DEVICE", "")
devices = json.load(open(sys.argv[1]))["result"]["devices"]
def ok(d):
    # シャットダウン中のシミュレータ（reality: simulated）は install できないので実機だけを選ぶ
    return d.get("hardwareProperties", {}).get("deviceType") == "iPhone" and \
        d.get("hardwareProperties", {}).get("reality") == "physical" and \
        d.get("connectionProperties", {}).get("tunnelState") == "connected"
for d in devices:
    if not ok(d):
        continue
    names = (d["identifier"], d.get("deviceProperties", {}).get("name", ""))
    if not want or want in names:
        print(d["identifier"])
        break
PY
)"
if [ -z "$DEVICE" ]; then
  echo "接続中の iPhone が見つかりません。USBで繋ぎ、ロックを解除して、信頼を許可してください。" >&2
  exit 1
fi
echo "入れ先: $DEVICE"

DERIVED="$REPO_ROOT/ios/build"
xcodebuild \
  -project ios/Kurashio.xcodeproj \
  -scheme Kurashio \
  -configuration Debug \
  -destination "id=$DEVICE" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build

APP="$DERIVED/Build/Products/Debug-iphoneos/Kurashio.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing com.gucchii.kurashio
echo "入れ直しが完了しました（$(git rev-parse --short HEAD)）"
