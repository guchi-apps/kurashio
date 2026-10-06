/** ログイン画面へ戻すときに付ける `?authError=` の値（`components/login-screen.tsx` が読む） */
export type AuthCallbackError = "forbidden" | "failed" | "unavailable";

export type AuthCallbackResult = { ok: true } | { ok: false; error: AuthCallbackError };

export type AuthCallbackDeps = {
  /** PKCE（iOSアプリ）で戻った `?code=` を交換する。implicit（Web）では呼ばない */
  exchangeCode: (code: string) => Promise<{ error: unknown }>;
  /** `/api/auth/me` を叩く。通信そのものが失敗したら throw してよい */
  checkMe: () => Promise<{ ok: boolean; status: number }>;
  /** このアプリのセッションだけを破棄する（`signOutThisApp`） */
  discardSession: () => Promise<void>;
};

/**
 * `/auth/callback` の判定（#724）。
 *
 * **どの失敗でもログイン画面へ戻す。** 以前は `/api/auth/me` の通信が例外を投げると
 * 「ログインしています」のまま止まり、利用者には読み込みが終わらないように見えた。
 * セッションはこのアプリの分だけ破棄し（`scope: "local"`・#426）、もう一度ログインし直せるようにする。
 *
 * - 401・403 … このアカウントでは使えない（許可リスト外・Googleで確認できない・失効したセッション）
 * - それ以外（503・通信不達）… 認証サーバーへ届かない。アカウントのせいにしない
 * - コードの交換に失敗 … Googleログインそのものの失敗
 */
export async function completeAuthCallback(
  code: string | null,
  deps: AuthCallbackDeps
): Promise<AuthCallbackResult> {
  if (code) {
    let exchangeFailed: boolean;
    try {
      exchangeFailed = Boolean((await deps.exchangeCode(code)).error);
    } catch {
      exchangeFailed = true;
    }
    if (exchangeFailed) {
      await signOutQuietly(deps);
      return { ok: false, error: "failed" };
    }
  }

  let error: AuthCallbackError | null = null;
  try {
    const res = await deps.checkMe();
    if (!res.ok) error = res.status === 401 || res.status === 403 ? "forbidden" : "unavailable";
  } catch {
    error = "unavailable";
  }
  if (error) {
    await signOutQuietly(deps);
    return { ok: false, error };
  }
  return { ok: true };
}

async function signOutQuietly(deps: AuthCallbackDeps): Promise<void> {
  try {
    await deps.discardSession();
  } catch {
    // 破棄に失敗してもログイン画面へは戻す（そこで「ログイン」を押し直せる）
  }
}
