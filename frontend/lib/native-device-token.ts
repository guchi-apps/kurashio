/**
 * 端末用の読み取りトークン（#683）を発行してiOSアプリへ渡す、ブラウザ（WKWebView）側のヘルパー。
 *
 * ウィジェット・Apple Watch はアプリ（WebView）を開いていない間も値を取りたいが、Supabaseのセッションは
 * 渡せない（refresh token を奪い合ってログアウトするため）。そこで `GET /api/device/sensors` だけを読める
 * トークンを発行して渡す（方式は #681・`ios/README.md`）。
 *
 * `lib/auth.ts`（signOutThisApp）のログアウト時失効から使うため、`lib/api.ts`は使わず
 * `lib/supabase-client.ts`から直接トークンを取る（循環importを避ける。`native-notifications.ts`と同じ）。
 */
import { supabase } from "@/lib/supabase-client";
import {
  NATIVE_DEVICE_TOKEN_STATE_EVENT,
  clearNativeDeviceToken,
  isNativeApp,
  requestNativeDeviceTokenState,
  sendNativeDeviceToken,
  type NativeDeviceTokenState,
} from "@/lib/native-app";

//: 直近に発行したトークンのID。ログアウト時の失効に使う（平文は持たない）
const TOKEN_ID_KEY = "myroom_native_device_token_id";
const TOKEN_LABEL = "iPhone・Apple Watch";

function getStoredTokenId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_ID_KEY);
}

function setStoredTokenId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) window.localStorage.setItem(TOKEN_ID_KEY, id);
  else window.localStorage.removeItem(TOKEN_ID_KEY);
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function revokeToken(id: string): Promise<void> {
  const res = await fetch(`/api/device-tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Request failed: ${res.status}`);
}

let issuing = false;

/**
 * アプリがトークンを持っていないとき（初回・再インストール・端末が失効を検知した）に発行して渡す。
 * 持っているときは何もしない（ログインのたびに増やさない）。失敗は次の起動・状態更新に任せる。
 */
export async function handleNativeDeviceTokenState(state: NativeDeviceTokenState): Promise<void> {
  if (state.hasToken || issuing) return;
  issuing = true;
  try {
    const previousId = getStoredTokenId();
    const res = await fetch("/api/device-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ label: TOKEN_LABEL }),
    });
    if (!res.ok) return;
    const issued = (await res.json()) as { id?: string; token?: string };
    if (!issued.id || !issued.token) return;
    if (!sendNativeDeviceToken(issued.token)) return;
    setStoredTokenId(issued.id);
    // 端末が捨てた古いトークンはサーバーに残るので、分かる範囲で失効しておく
    if (previousId && previousId !== issued.id) await revokeToken(previousId).catch(() => {});
  } catch {
    // 次回の起動・状態更新に任せる（利用者に見せるエラーは無い）
  } finally {
    issuing = false;
  }
}

/**
 * ダッシュボード（ログイン後の画面）が一度だけ呼ぶ初期化。アプリへトークンの有無を問い合わせ、
 * 無ければ発行して渡す。戻り値は購読解除。アプリの外（Web・PWA）では何もしない。
 */
export function initializeNativeDeviceToken(): () => void {
  if (!isNativeApp() || typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<NativeDeviceTokenState>).detail;
    if (detail) void handleNativeDeviceTokenState(detail);
  };
  window.addEventListener(NATIVE_DEVICE_TOKEN_STATE_EVENT, listener);
  requestNativeDeviceTokenState();
  return () => window.removeEventListener(NATIVE_DEVICE_TOKEN_STATE_EVENT, listener);
}

/**
 * ログアウト時。セッションが切れる前に呼ぶ（失効は認証済みAPIのため）。端末側の保存は
 * 失効に失敗しても必ず消す（ウィジェット・Watch に前の利用者の値を取らせない）。
 */
export async function revokeNativeDeviceTokenBestEffort(): Promise<void> {
  if (!isNativeApp()) return;
  const id = getStoredTokenId();
  try {
    if (id) await revokeToken(id);
  } catch {
    // サーバー側に残っても、端末が持たなければ使われない
  } finally {
    setStoredTokenId(null);
    clearNativeDeviceToken();
  }
}
