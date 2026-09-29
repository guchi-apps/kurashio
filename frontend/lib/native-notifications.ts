/**
 * iOSアプリ（ネイティブ）のAPNs通知のブラウザ（WKWebView）側ヘルパー（#527）。
 *
 * Web PushのAPI（push-notifications.ts）とは別経路。通知の許可要求は呼び出し側
 * （notification-settings-sheet.tsx）が「有効にする」操作のタイミングでのみ行う。
 *
 * `lib/auth.ts`（signOutThisApp）のログアウト時解除から使うため、`lib/api.ts`は使わず
 * `lib/supabase-client.ts`から直接トークンを取る（api.ts → auth.ts の既存依存と合わせると
 * 循環importになるため）。
 */

import { supabase } from "@/lib/supabase-client";
import {
  NATIVE_NOTIFICATION_STATE_EVENT,
  isNativeApp,
  queryNativeNotificationState,
  requestNativeNotificationPermission,
  type NativeNotificationState,
} from "@/lib/native-app";

//: 「有効にする」を押したこと（バックエンドへ登録してよいこと）を覚える。
//: OSの通知許可自体はアプリから取り消せないため、無効化はこのフラグと
//: バックエンドの登録解除だけで表す（Web PushのsubscribeがOSの許可とは別物なのと同じ）
const ENABLED_KEY = "myroom_native_push_enabled";
//: 直近にバックエンドへ登録したトークン。ログアウト・無効化時の解除に使う
const TOKEN_KEY = "myroom_native_push_token";

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ENABLED_KEY) === "true";
}

function setEnabled(value: boolean): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(ENABLED_KEY, "true");
  else window.localStorage.removeItem(ENABLED_KEY);
}

function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

function setStoredToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function putToken(token: string): Promise<void> {
  const res = await fetch("/api/apns/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
}

async function deleteToken(token: string): Promise<void> {
  const res = await fetch("/api/apns/register", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ token }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Request failed: ${res.status}`);
}

export function isNativeNotificationsEnabled(): boolean {
  return isEnabled();
}

/** アプリからの状態イベント（許可状態・デバイストークン）を購読する。戻り値で解除する。 */
export function subscribeNativeNotificationState(
  handler: (state: NativeNotificationState) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<NativeNotificationState>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(NATIVE_NOTIFICATION_STATE_EVENT, listener);
  return () => window.removeEventListener(NATIVE_NOTIFICATION_STATE_EVENT, listener);
}

/**
 * 状態イベントを受けたときに呼ぶ（アプリ起動時の確認・許可要求後・トークン更新のいずれも通る）。
 *
 * 「有効にする」フラグが立っているときだけバックエンドへ登録する。フラグが無い状態で
 * OSの許可だけが残っていても（アプリ内で無効にした後の再起動など）、勝手に再登録しない。
 */
export async function handleNativeNotificationState(
  state: NativeNotificationState
): Promise<void> {
  if (state.permission !== "granted" || !state.token) {
    setStoredToken(null);
    return;
  }
  setStoredToken(state.token);
  if (!isEnabled()) return;
  try {
    await putToken(state.token);
  } catch {
    // 次回の起動・状態更新に任せる（ここで利用者に見せるエラーは無い）
  }
}

/** 「有効にする」操作。許可要求〜バックエンド登録は非同期（状態イベントを待って進む）。 */
export function enableNativeNotifications(): void {
  setEnabled(true);
  requestNativeNotificationPermission();
}

/** 「無効にする」操作。バックエンドの登録を解除し、以後の自動再登録も止める。 */
export async function disableNativeNotifications(): Promise<void> {
  setEnabled(false);
  const token = getStoredToken();
  if (token) {
    await deleteToken(token);
  }
}

/**
 * ダッシュボード（ログイン後の画面）が一度だけ呼ぶ初期化。状態イベントを購読して
 * バックエンドの登録を追随させ、現在値を1回問い合わせる（起動直後の購読間に合わせ用）。
 * 戻り値は購読解除。
 */
export function initializeNativeNotifications(): () => void {
  if (!isNativeApp()) return () => {};
  const unsubscribe = subscribeNativeNotificationState((state) => {
    void handleNativeNotificationState(state);
  });
  queryNativeNotificationState();
  return unsubscribe;
}

/** ログアウト時のベストエフォート解除（`lib/auth.ts`から呼ぶ）。失敗してもログアウト自体は止めない。 */
export async function unregisterNativeNotificationsBestEffort(): Promise<void> {
  if (!isNativeApp()) return;
  const token = getStoredToken();
  if (!token) return;
  try {
    await deleteToken(token);
  } catch {
    // ログアウト自体は続ける
  }
}
