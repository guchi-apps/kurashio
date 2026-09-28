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
 * アプリのネイティブ通知（APNs・#527）の状態が変わるたびに、アプリ側
 * （`AppDelegate.swift`・`WebViewModel.swift`）が飛ばしてくるイベント。
 * `detail` は {@link NativeNotificationState}。
 */
export const NATIVE_NOTIFICATION_STATE_EVENT = "myroom-native-notification-state";

export interface NativeNotificationState {
  //: Web版の`Notification.permission`と揃えた3値（`UNAuthorizationStatus`の`.authorized`/`.provisional`は
  //: "granted"、`.denied`は"denied"、`.notDetermined`は"default"に読み替える）
  permission: "granted" | "denied" | "default";
  /** 許可済み（"granted"）のときの、この端末のAPNsデバイストークン（16進文字列）。それ以外は null */
  token: string | null;
}

/**
 * アプリへ、通知許可の要求（未許可なら要求・許可済みならトークンを取り直す）を依頼する。
 * OSのダイアログは初回（未確定のとき）だけ出るため、呼ぶのは「有効にする」操作のときだけにする。
 */
export function requestNativeNotificationPermission(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "requestNotificationPermission" });
  return true;
}

/**
 * いまの通知許可状態を問い合わせる（OSのダイアログは出ない・読み取り専用）。
 * アプリは起動・復帰のたびに自動でも状態を飛ばしてくるが、Reactの購読が間に合わない
 * 起動直後のタイミングを埋めるため、画面側からも明示的に呼べるようにしてある。
 */
export function queryNativeNotificationState(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "queryNotificationPermission" });
  return true;
}

/** iOSの設定アプリ（このアプリの通知設定）を開く。拒否後に変更方法を示すため。 */
export function openNativeNotificationSettings(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "openSystemSettings" });
  return true;
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

/** iPhoneのホーム画面ウィジェット（`ios/KurashioWidget/`）が表示する値 */
export interface WidgetSnapshot {
  roomTemperature: number | null;
  roomHumidity: number | null;
  /** 次に収集される品目名（複数なら「・」区切り）。予定が無ければ null */
  garbageLabel: string | null;
  /** 上記の収集日までの日数（0=今日、1=明日）。`garbageLabel` が null なら意味を持たない */
  garbageDaysUntil: number | null;
  todayKwh: number | null;
  todayCostYen: number | null;
}

/**
 * ダッシュボードが表示している値を、ホーム画面ウィジェット用にアプリ（Swift）へ渡す（#537）。
 *
 * ウィジェットはWKWebViewの外（別プロセス）で動くため、このページが持つ値を直接読めない。
 * **Supabaseのセッション（JWT）は渡さない。** ウィジェットが独自にrefresh tokenを更新すると、
 * WKWebView側のクライアントと同じrefresh tokenを奪い合ってログアウトを引き起こすため
 * （`ios/README.md`「表示用データだけをApp Group経由で共有する」参照）。渡すのは表示用の
 * 値だけで、ウィジェットはこれをそのまま出すだけになる。**アプリの外（Web・PWA）では何もしない。**
 *
 * @param snapshot 表示中の値。ログアウト直後など出す値が無いときは `null`
 * @returns アプリへ渡せたか（アプリの外なら false）
 */
export function syncWidgetSnapshot(snapshot: WidgetSnapshot | null): boolean {
  const bridge = getBridge();
  if (!bridge) return false;

  if (snapshot) {
    bridge.postMessage({ type: "widgetSnapshot", snapshot });
  } else {
    bridge.postMessage({ type: "widgetSnapshotCleared" });
  }
  return true;
}
