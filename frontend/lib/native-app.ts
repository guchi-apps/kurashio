/**
 * kurashio の iOSアプリ（`ios/`・#526）の中で開かれたときだけ働く処理。
 *
 * iOSアプリは WKWebView でこのWeb版を開く殻で、画面はすべてWeb側にある。
 * Web・PWA の利用者には何も変えないよう、アプリ側が用意するブリッジ
 * （`window.webkit.messageHandlers.kurashioAuth`）があるときだけ分岐する。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "@/lib/supabase-client";

/** Googleログインの戻り先。Supabase の許可リダイレクトURLに登録が要る（ios/README.md） */
export const NATIVE_AUTH_REDIRECT = "kurashio://auth-callback";

/** アプリがログインをキャンセルしたときに送ってくるイベント（WebViewModel.swift） */
export const NATIVE_AUTH_CANCELLED_EVENT = "myroom-native-auth-cancelled";

type NativeBridge = { postMessage: (message: unknown) => void };

type WebKitWindow = Window & {
  webkit?: { messageHandlers?: { kurashioAuth?: NativeBridge } };
};

function getBridge(): NativeBridge | null {
  if (typeof window === "undefined") return null;
  return (window as WebKitWindow).webkit?.messageHandlers?.kurashioAuth ?? null;
}

/** iOSアプリの中で開かれているか */
export function isNativeApp(): boolean {
  return getBridge() != null;
}

/**
 * PKCE の `code_verifier` だけを localStorage に置き、それ以外は手元に持たないストレージ。
 *
 * 共有クライアント（`supabase-client.ts`）は implicit フローのまま変えない（Web・PWA のログインと
 * `/auth/callback` の通知 #240 に影響させないため）。アプリ内のログインでだけ PKCE を使い、
 * 認可URLを作るときに保存される `code_verifier` を、共有クライアントと同じキーで localStorage に残す。
 * 戻った `code` は共有クライアントが `/auth/callback` で交換する（`exchangeCodeForSession` は
 * フローの種類によらず同じキーの `code_verifier` を読む）。
 *
 * セッション本体をこのクライアントに読ませないのは、2つのクライアントが同じ refresh token を
 * それぞれ更新しに行くと、片方が失効した token を使ってログアウトされるため。
 */
const verifierOnlyStorage = {
  memory: new Map<string, string>(),
  getItem(key: string): string | null {
    if (key.endsWith("-code-verifier")) return window.localStorage.getItem(key);
    return this.memory.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    if (key.endsWith("-code-verifier")) window.localStorage.setItem(key, value);
    else this.memory.set(key, value);
  },
  removeItem(key: string): void {
    if (key.endsWith("-code-verifier")) window.localStorage.removeItem(key);
    else this.memory.delete(key);
  },
};

let pkceClient: SupabaseClient | null = null;

function getPkceClient(): SupabaseClient {
  pkceClient ??= createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
    auth: {
      flowType: "pkce",
      storage: verifierOnlyStorage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return pkceClient;
}

/**
 * アプリの認証シートでGoogleログインを始める。
 * ここでは認可URLを作ってアプリへ渡すだけで、ページは移動しない。
 *
 * @returns 渡せなかったとき（アプリの外・認可URLを作れない）は false
 */
export async function startNativeGoogleSignIn(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge) return false;

  const { data, error } = await getPkceClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: NATIVE_AUTH_REDIRECT, skipBrowserRedirect: true },
  });
  if (error || !data.url) return false;

  bridge.postMessage({ type: "signIn", url: data.url });
  return true;
}
