"use client";

import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import {
  NATIVE_DEVICE_TOKEN_STATE_EVENT,
  isNativeApp,
  requestNativeDeviceTokenState,
  type NativeDeviceTokenState,
} from "@/lib/native-app";
import { reissueNativeDeviceToken } from "@/lib/native-device-token";

/** 最後に取れた時刻（epoch秒）を「3:18」のように端末の時計ではなくJSTで出す */
export function formatFetchedAt(epochSeconds: number | null | undefined): string | null {
  if (epochSeconds == null) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

export function describeWidgetRefresh(state: NativeDeviceTokenState | null): {
  label: string;
  detail: string;
  tone: "ok" | "warn" | "bad";
  canReset: boolean;
} {
  const at = formatFetchedAt(state?.fetchedAt);
  const status = state?.status ?? (state && !state.hasToken ? "off" : "active");
  if (status === "off") {
    return {
      label: "未設定",
      detail: "端末用トークンがありません。アプリを閉じていると更新されません",
      tone: "warn",
      canReset: true,
    };
  }
  if (status === "failed") {
    return {
      label: "失敗",
      detail: `前回の取得に失敗しました${at ? `（最後に取れたのは ${at}）` : ""}。約15分後に取り直します`,
      tone: "bad",
      canReset: true,
    };
  }
  return {
    label: "有効",
    detail: `${at ? `最後に取得: ${at}・` : ""}約15分ごと（iOSの都合で遅れることがあります）`,
    tone: "ok",
    canReset: false,
  };
}

const TONE_CLASS = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
} as const;

/**
 * 設定シートの「ウィジェットの自動更新」（#786）。アプリの中（WKWebView）でだけ出す。
 * 状態はアプリが持つ（`deviceTokenReady` への返事）。Watch は別端末なので対象にしない。
 */
export function WidgetRefreshRow() {
  const [state, setState] = useState<NativeDeviceTokenState | null>(null);
  const [busy, setBusy] = useState(false);
  const native = typeof window !== "undefined" && isNativeApp();

  useEffect(() => {
    if (!native) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<NativeDeviceTokenState>).detail;
      if (detail) setState(detail);
    };
    window.addEventListener(NATIVE_DEVICE_TOKEN_STATE_EVENT, listener);
    requestNativeDeviceTokenState();
    return () => window.removeEventListener(NATIVE_DEVICE_TOKEN_STATE_EVENT, listener);
  }, [native]);

  if (!native || !state) return null;
  const view = describeWidgetRefresh(state);

  const reset = async () => {
    setBusy(true);
    try {
      await reissueNativeDeviceToken();
    } finally {
      setBusy(false);
      requestNativeDeviceTokenState();
    }
  };

  return (
    <div className="flex w-full items-start gap-3 border-b px-5 py-3.5">
      <Smartphone className="mt-0.5 size-[19px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold leading-snug">ウィジェットの自動更新</span>
        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
          {view.detail}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${TONE_CLASS[view.tone]}`}>{view.label}</span>
        {view.canReset ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void reset()}
            className="rounded-lg border px-3 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            再設定する
          </button>
        ) : null}
      </span>
    </div>
  );
}
