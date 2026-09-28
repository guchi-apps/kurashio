import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// iOSアプリ（#526）の中でだけ働く分岐。Web・PWAの利用者には何も変えないことを確かめる。
const { createClient, signInWithOAuth } = vi.hoisted(() => {
  const signInWithOAuth = vi.fn();
  return {
    signInWithOAuth,
    createClient: vi.fn(() => ({ auth: { signInWithOAuth } })),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("@/lib/supabase-client", () => ({
  supabaseConfig: { url: "https://example.supabase.co", publishableKey: "key" },
}));

import { NATIVE_AUTH_REDIRECT, isNativeApp, startNativeGoogleSignIn } from "@/lib/native-app";

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("window", {
    webkit: { messageHandlers: { kurashioAuth: { postMessage } } },
    localStorage: new Map(),
  });
  return postMessage;
}

describe("isNativeApp", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ブラウザ・PWA（ブリッジが無い）では false", () => {
    vi.stubGlobal("window", {});
    expect(isNativeApp()).toBe(false);
  });

  it("iOSアプリ（ブリッジがある）では true", () => {
    installBridge();
    expect(isNativeApp()).toBe(true);
  });
});

describe("startNativeGoogleSignIn", () => {
  beforeEach(() => {
    signInWithOAuth.mockReset();
    createClient.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("アプリの外では何もしない", async () => {
    vi.stubGlobal("window", {});
    expect(await startNativeGoogleSignIn()).toBe(false);
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("PKCEのクライアントで認可URLだけを作り、ページを移動せずにアプリへ渡す", async () => {
    const postMessage = installBridge();
    signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.supabase.co/auth/v1/authorize?provider=google" },
      error: null,
    });

    expect(await startNativeGoogleSignIn()).toBe(true);

    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "key",
      expect.objectContaining({
        auth: expect.objectContaining({ flowType: "pkce", detectSessionInUrl: false }),
      })
    );
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: NATIVE_AUTH_REDIRECT, skipBrowserRedirect: true },
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "signIn",
      url: "https://example.supabase.co/auth/v1/authorize?provider=google",
    });
  });

  it("認可URLを作れなければアプリへ何も渡さない", async () => {
    const postMessage = installBridge();
    signInWithOAuth.mockResolvedValue({ data: { url: null }, error: new Error("x") });

    expect(await startNativeGoogleSignIn()).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
