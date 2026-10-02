import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-client", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } } }) } },
  supabaseConfig: { url: "https://example.supabase.co", publishableKey: "key" },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import {
  handleNativeDeviceTokenState,
  revokeNativeDeviceTokenBestEffort,
} from "@/lib/native-device-token";

function installBridge() {
  const postMessage = vi.fn();
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    webkit: { messageHandlers: { kurashioAuth: { postMessage } } },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return postMessage;
}

describe("端末用トークンの発行（#683）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("アプリがトークンを持っていなければ発行して渡す", async () => {
    const postMessage = installBridge();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "t1", token: "kdt_abc" }) });

    await handleNativeDeviceTokenState({ hasToken: false });

    expect(fetchMock).toHaveBeenCalledWith("/api/device-tokens", expect.objectContaining({ method: "POST" }));
    expect(postMessage).toHaveBeenCalledWith({ type: "deviceToken", token: "kdt_abc" });
  });

  it("持っているときは発行しない（ログインのたびに増やさない）", async () => {
    const postMessage = installBridge();
    await handleNativeDeviceTokenState({ hasToken: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("発行に失敗しても渡さない", async () => {
    const postMessage = installBridge();
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await handleNativeDeviceTokenState({ hasToken: false });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ログアウトでは失効し、失敗しても端末の保存を消させる", async () => {
    const postMessage = installBridge();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "t1", token: "kdt_abc" }) });
    await handleNativeDeviceTokenState({ hasToken: false });
    postMessage.mockClear();

    fetchMock.mockRejectedValueOnce(new Error("network"));
    await revokeNativeDeviceTokenBestEffort();

    expect(fetchMock).toHaveBeenLastCalledWith("/api/device-tokens/t1", expect.objectContaining({ method: "DELETE" }));
    expect(postMessage).toHaveBeenCalledWith({ type: "deviceTokenCleared" });
  });

  it("アプリの外では何もしない", async () => {
    vi.stubGlobal("window", {});
    await revokeNativeDeviceTokenBestEffort();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
