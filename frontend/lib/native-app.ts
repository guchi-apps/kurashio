/**
 * kurashio の iOSアプリ（`ios/`・#526）の中で開かれたときだけ働く処理。
 *
 * iOSアプリは WKWebView でこのWeb版を開く殻で、画面はすべてWeb側にある。
 * Web・PWA の利用者には何も変えないよう、アプリ側が用意するブリッジ
 * （`window.webkit.messageHandlers.kurashioAuth`）があるときだけ分岐する。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "@/lib/supabase-client";
import type { WidgetGarbageDay } from "@/lib/widget-garbage";
import type { WidgetAircon } from "@/lib/widget-aircon";
import type { WidgetRemoteButton } from "@/lib/widget-remote-buttons";
import type { WidgetSensor } from "@/lib/widget-sensors";

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
  /**
   * ウィジェットでセンサーを選んでいないときに出す室温・湿度（`pickDefaultWidgetSensor()`）。
   * `sensors` を読めない古いアプリのためにも残している
   */
  roomTemperature: number | null;
  roomHumidity: number | null;
  /** 上の値を取ったセンサーのID。該当が無ければ null */
  defaultSensorId: number | null;
  /** 「ウィジェットを編集」で選べるセンサーの一覧（#560・`buildWidgetSensors()`） */
  sensors: WidgetSensor[];
  /**
   * 受信停止とみなす分数（`GET /api/sensors/status` の `threshold_minutes`）。Apple Watch が、開いたまま
   * 古くなった値を黄色にする基準（#677）。基準をSwiftに持たせないため送る。未取得なら null
   */
  staleAfterMinutes: number | null;
  /** 次に収集される品目名（複数なら「・」区切り）。予定が無ければ null */
  garbageLabel: string | null;
  /** 上記の収集日までの日数（0=今日、1=明日）。`garbageLabel` が null なら意味を持たない */
  garbageDaysUntil: number | null;
  /**
   * 「ごみの日」ウィジェット用の、今日以降の収集日（最大5件・日付順）。
   * 日数は渡さず、ウィジェットが端末の日付から数える（`buildWidgetGarbageDays()`）
   */
  garbageUpcoming: WidgetGarbageDay[];
  /** 今日の収集が終わる時刻（"08:30"）。ウィジェットが今日の収集を済みとみなす境目。不明なら null */
  garbageCollectionTime: string | null;
  todayKwh: number | null;
  todayCostYen: number | null;
  /** 昨日の使用量（KEPCO差分の「その他」を除く）。記録が無ければ null（#648） */
  yesterdayKwh: number | null;
  /** 今月の累計使用量（#648） */
  monthKwh: number | null;
  /** 上の電気の値の基準日（JST・`2026-10-01`）。ウィジェットが日付またぎを見分ける（#648） */
  energyDate: string | null;
  /** Largeに並べる電気の操作ボタン（#546）。押した結果は `reportWidgetPressResult()` で返す */
  remoteButtons: WidgetRemoteButton[];
  /** エアコンの操作ウィジェットに並べる台（#649）。操作できない構成では空 */
  aircons: WidgetAircon[];
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

/** ウィジェットのボタンが押されたとき、アプリが保留の中身を届けるイベント（`detail` は {@link WidgetPress}） */
export const NATIVE_WIDGET_PRESS_EVENT = "myroom-native-widget-press";

/** 保留ができた合図（中身なし）。受け取ったら {@link requestWidgetPress} で取りにいく */
export const NATIVE_WIDGET_PRESS_AVAILABLE_EVENT = "myroom-native-widget-press-available";

/** ウィジェットで押されたボタン1回ぶん。`key` は押下ごとに変わる（二重送信の防止に使う） */
export interface WidgetPress {
  key: string;
  buttonId: string;
  /** エアコンの操作（#649）のときだけ入る。電気の操作では無い */
  acId?: number;
  action?: string;
}

export type WidgetPressStatus = "sent" | "failed" | "unknown";

/** 保留中の押下があれば届けてもらう。アプリの外では何もしない */
export function requestWidgetPress(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "widgetReady" });
  return true;
}

/** 押下の結果をアプリへ返す。アプリはこれを受けて初めて保留を消し、ウィジェットへ結果を出す */
export function reportWidgetPressResult(key: string, status: WidgetPressStatus): void {
  getBridge()?.postMessage({ type: "widgetPressResult", key, status });
}

/**
 * 端末用の読み取りトークン（`POST /api/device-tokens`・#683）の状態。アプリが `deviceTokenReady` への返事と、
 * 端末が401を受けてトークンを捨てたときに飛ばしてくる。`detail` は {@link NativeDeviceTokenState}
 */
export const NATIVE_DEVICE_TOKEN_STATE_EVENT = "myroom-native-device-token-state";

export interface NativeDeviceTokenState {
  /** アプリがトークンを持っているか。false ならWebが発行して渡す */
  hasToken: boolean;
}

/** アプリへ、トークンの有無を問い合わせる（返事は {@link NATIVE_DEVICE_TOKEN_STATE_EVENT}）。アプリの外では何もしない */
export function requestNativeDeviceTokenState(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "deviceTokenReady" });
  return true;
}

/**
 * 発行したトークンをアプリへ渡す。アプリは App Group へ保存し、Apple Watch へも送る。
 * ウィジェット・Watch が、アプリを閉じている間も `GET /api/device/sensors` を読むために使う（#683）。
 */
export function sendNativeDeviceToken(token: string): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "deviceToken", token });
  return true;
}

/** アプリが持つトークンを捨てさせる（ログアウト時）。ウィジェット・Watch の保存も消える */
export function clearNativeDeviceToken(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  bridge.postMessage({ type: "deviceTokenCleared" });
  return true;
}
