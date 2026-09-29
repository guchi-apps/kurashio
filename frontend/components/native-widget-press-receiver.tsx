"use client";

import { useEffect, useRef, useState } from "react";
import { sendRemoteButton } from "@/lib/api";
import {
  isNativeApp,
  NATIVE_WIDGET_PRESS_AVAILABLE_EVENT,
  NATIVE_WIDGET_PRESS_EVENT,
  reportWidgetPressResult,
  requestWidgetPress,
  type WidgetPress,
} from "@/lib/native-app";
import { REMOTE_SENT_MESSAGE_MS } from "@/lib/remote";
import { supabase } from "@/lib/supabase-client";
import { claimPressKey } from "@/lib/widget-press";

/**
 * iPhoneのホーム画面ウィジェットで押された電気の操作ボタンを、ここで送る（#546）。
 *
 * ウィジェットは認証を持たない（JWTを渡すとrefresh tokenの奪い合いでログアウトする・#537）。
 * 代わりに、アプリが前面に出たあと**このページのログイン済みセッション**で
 * `POST /api/remote/buttons/{id}/send` を送る。**どの画面にいても受けられるよう
 * ルートレイアウトに置く**（ページ遷移させると `/devices` などの未保存の入力が消えるため）。
 *
 * アプリからの「保留あり」の合図には中身が無く、こちらから `requestWidgetPress()` で取りにいく
 * （アプリからの直接の受け渡しは、復帰時の自動リロードと競合して取りこぼす・二重に送るため）。
 * Web・PWAでは何も描かず、何も購読しない。
 */
export function NativeWidgetPressReceiver() {
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const show = (text: string, failed: boolean) => {
      setMessage({ text, failed });
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(null), failed ? REMOTE_SENT_MESSAGE_MS * 2 : REMOTE_SENT_MESSAGE_MS);
    };

    // 未ログインなら取りにいかない（ログイン後の状態変化でもう一度試す）
    const poll = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!cancelled && data.session) requestWidgetPress();
      } catch {
        // 判定できないときは取りにいかない。保留は60秒で捨てられる
      }
    };

    const onPress = async (event: Event) => {
      const press = (event as CustomEvent<WidgetPress>).detail;
      if (!press?.key || !press.buttonId) return;
      if (inFlightRef.current.has(press.key)) return;
      inFlightRef.current.add(press.key);
      try {
        if (!claimPressKey(window.localStorage, press.key)) {
          // 記録済み＝前の画面で送り始めている。通ったかは分からない
          reportWidgetPressResult(press.key, "unknown");
          show("ウィジェットの操作は、送信済みか確認できませんでした", true);
          return;
        }
        try {
          const result = await sendRemoteButton(press.buttonId);
          reportWidgetPressResult(press.key, "sent");
          show(`${result.group_name} ${result.label} を送信しました`, false);
        } catch (err) {
          reportWidgetPressResult(press.key, "failed");
          show(err instanceof Error ? err.message : "送信できませんでした", true);
        }
      } finally {
        inFlightRef.current.delete(press.key);
      }
    };

    window.addEventListener(NATIVE_WIDGET_PRESS_EVENT, onPress);
    window.addEventListener(NATIVE_WIDGET_PRESS_AVAILABLE_EVENT, poll);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") void poll();
    });
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(NATIVE_WIDGET_PRESS_EVENT, onPress);
      window.removeEventListener(NATIVE_WIDGET_PRESS_AVAILABLE_EVENT, poll);
      subscription.unsubscribe();
    };
  }, []);

  if (!message) return null;
  return (
    <div
      role="status"
      className={`fixed inset-x-4 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-[60] mx-auto max-w-sm rounded-xl px-4 py-3 text-center text-sm font-medium shadow-lg ${
        message.failed ? "bg-red-600 text-white" : "bg-foreground text-background"
      }`}
    >
      {message.text}
    </div>
  );
}
