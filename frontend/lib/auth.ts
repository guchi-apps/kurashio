import { supabase } from "@/lib/supabase-client";
import { unregisterNativeNotificationsBestEffort } from "@/lib/native-notifications";
import { syncWidgetSnapshot } from "@/lib/native-app";
import { revokeNativeDeviceTokenBestEffort } from "@/lib/native-device-token";

export class AuthError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthError";
  }
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * このアプリのセッションだけを破棄する（他アプリ・他端末には影響しない）。
 *
 * **Supabase の `signOut` を scope なしで呼ばないこと（#426）。** Supabase Auth の既定 scope は
 * `global` で、同じユーザーの全セッション（同じSupabaseプロジェクトを共有する他アプリ・他端末）の
 * refresh token まで失効させる。このアプリのログアウトや401時の破棄は `local` で足りる。
 */
export async function signOutThisApp(): Promise<void> {
  // セッションが切れる前に解除する（解除自体は認証済みAPIのため。#527）
  await unregisterNativeNotificationsBestEffort();
  // ウィジェット・Watch が持つ読み取りトークン（#683）を失効し、端末の保存も消す
  await revokeNativeDeviceTokenBestEffort();
  // ホーム画面ウィジェット（#537）に前の利用者の値を残さない
  syncWidgetSnapshot(null);
  await supabase.auth.signOut({ scope: "local" });
}

export async function authHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
