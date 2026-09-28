"use client";

import { useEffect } from "react";
import { syncWidgetSnapshot, type WidgetSnapshot } from "@/lib/native-app";

interface NativeWidgetSnapshotSyncProps {
  /** ダッシュボードが表示している値。ログアウト直後など出す値が無ければ null */
  snapshot: WidgetSnapshot | null;
}

/**
 * ダッシュボードが表示している値を、iOSアプリのホーム画面ウィジェット（#537）へ渡す。
 * Web・PWAでは `syncWidgetSnapshot()` が何もしないので、描画も副作用も増えない。
 */
export function NativeWidgetSnapshotSync({ snapshot }: NativeWidgetSnapshotSyncProps) {
  useEffect(() => {
    syncWidgetSnapshot(snapshot);
  }, [snapshot]);
  return null;
}
