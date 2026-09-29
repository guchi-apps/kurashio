"use client";

import { useEffect, useRef } from "react";
import { syncWidgetSnapshot, type WidgetSnapshot } from "@/lib/native-app";

interface NativeWidgetSnapshotSyncProps {
  /** ダッシュボードが表示している値。ログアウト直後など出す値が無ければ null */
  snapshot: WidgetSnapshot | null;
}

/**
 * ダッシュボードが表示している値を、iOSアプリのホーム画面ウィジェット（#537）へ渡す。
 * Web・PWAでは `syncWidgetSnapshot()` が何もしないので、描画も副作用も増えない。
 *
 * **中身が前回と同じなら送らない。** 受け取ったアプリはそのたびにWidgetの再読み込みを求めるが、
 * WidgetKitには1日あたりの上限がある。センサーの一覧（#560）は30秒ごとの取得で新しい配列に
 * なるため、オブジェクトの同一性ではなくJSONの文字列で比べる
 */
export function NativeWidgetSnapshotSync({ snapshot }: NativeWidgetSnapshotSyncProps) {
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSentRef.current) return;
    if (syncWidgetSnapshot(snapshot)) lastSentRef.current = serialized;
  }, [snapshot]);
  return null;
}
