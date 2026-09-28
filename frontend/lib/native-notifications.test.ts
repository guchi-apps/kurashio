import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// iOSアプリ（#526）のAPNs通知（#527）。Web Pushとは別経路であることと、
// 「有効にする」フラグが立っているときだけバックエンドへ登録することを確かめる。
const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: { auth: { getSession } },
}));

import {
  NATIVE_NOTIFICATION_STATE_EVENT,
  type NativeNotificationState,
} from "@/lib/native-app";
import {
  disableNativeNotifications,
  enableNativeNotifications,
  handleNativeNotificationState,
  initializeNativeNotifications,
  isNativeNotificationsEnabled,
  subscribeNativeNotificationState,
  unregisterNativeNotificationsBestEffort,
} from "@/lib/native-notifications";

function installWindow({ bridge = false }: { bridge?: boolean } = {}) {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const store = new Map<string, string>();
  const postMessage = vi.fn();

  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== fn);
    },
    dispatchEvent: (event: { type: string; detail: unknown }) => {
      for (const fn of listeners[event.type] ?? []) fn(event);
    },
    ...(bridge ? { webkit: { messageHandlers: { kurashioAuth: { postMessage } } } } : {}),
  };

  vi.stubGlobal("window", fakeWindow);
  return { fakeWindow, postMessage };
}

function emitState(fakeWindow: ReturnType<typeof installWindow>["fakeWindow"], detail: NativeNotificationState) {
  fakeWindow.dispatchEvent({ type: NATIVE_NOTIFICATION_STATE_EVENT, detail });
}

describe("isNativeNotificationsEnabled / enableNativeNotifications / disableNativeNotifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("既定は無効", () => {
    installWindow({ bridge: true });
    expect(isNativeNotificationsEnabled()).toBe(false);
  });

  it("有効にすると許可要求のブリッジメッセージを送り、フラグが立つ", () => {
    const { postMessage } = installWindow({ bridge: true });
    enableNativeNotifications();
    expect(isNativeNotificationsEnabled()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "requestNotificationPermission" });
  });

  it("無効にすると登録済みトークンをDELETEし、フラグが下りる", async () => {
    const { fakeWindow } = installWindow({ bridge: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    enableNativeNotifications();
    await handleNativeNotificationState({ permission: "granted", token: "device-token" });

    await disableNativeNotifications();

    expect(isNativeNotificationsEnabled()).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "/api/apns/register",
      expect.objectContaining({ method: "DELETE" })
    );
    void fakeWindow;
  });

  it("トークンが無ければ無効化してもDELETEを呼ばない", async () => {
    installWindow({ bridge: true });
    vi.stubGlobal("fetch", vi.fn());
    await disableNativeNotifications();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("handleNativeNotificationState", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("未許可・トークン無しでは何も送らない", async () => {
    installWindow({ bridge: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleNativeNotificationState({ permission: "denied", token: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("許可済みでも「有効にする」フラグが無ければ登録しない", async () => {
    installWindow({ bridge: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleNativeNotificationState({ permission: "granted", token: "device-token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("許可済み・有効フラグありなら認証ヘッダー付きでPOSTする", async () => {
    installWindow({ bridge: true });
    getSession.mockResolvedValueOnce({ data: { session: { access_token: "jwt-token" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    enableNativeNotifications();
    await handleNativeNotificationState({ permission: "granted", token: "device-token" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apns/register",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }),
        body: JSON.stringify({ token: "device-token" }),
      })
    );
  });
});

describe("subscribeNativeNotificationState / initializeNativeNotifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("イベントを購読し、解除後は呼ばれない", () => {
    const { fakeWindow } = installWindow({ bridge: true });
    const handler = vi.fn();
    const unsubscribe = subscribeNativeNotificationState(handler);

    emitState(fakeWindow, { permission: "granted", token: "t1" });
    expect(handler).toHaveBeenCalledWith({ permission: "granted", token: "t1" });

    unsubscribe();
    emitState(fakeWindow, { permission: "denied", token: null });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("アプリの外では何もせず、no-opの解除関数を返す", () => {
    installWindow({ bridge: false });
    vi.stubGlobal("window", {});
    expect(() => initializeNativeNotifications()()).not.toThrow();
  });

  it("アプリの中では起動時に状態を問い合わせる", () => {
    const { postMessage } = installWindow({ bridge: true });
    const unsubscribe = initializeNativeNotifications();
    expect(postMessage).toHaveBeenCalledWith({ type: "queryNotificationPermission" });
    unsubscribe();
  });
});

describe("unregisterNativeNotificationsBestEffort", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("アプリの外では何もしない", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await unregisterNativeNotificationsBestEffort();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("登録済みトークンが無ければ何もしない", async () => {
    installWindow({ bridge: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await unregisterNativeNotificationsBestEffort();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("登録済みトークンがあればDELETEし、失敗しても投げない", async () => {
    installWindow({ bridge: true });
    await handleNativeNotificationState({ permission: "granted", token: "device-token" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(unregisterNativeNotificationsBestEffort()).resolves.toBeUndefined();
  });
});

beforeEach(() => {
  getSession.mockResolvedValue({ data: { session: null } });
});
