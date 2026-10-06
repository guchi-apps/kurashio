import { describe, expect, it, vi } from "vitest";
import { completeAuthCallback, type AuthCallbackDeps } from "@/lib/auth-callback";

function deps(overrides: Partial<AuthCallbackDeps> = {}) {
  return {
    exchangeCode: vi.fn().mockResolvedValue({ error: null }),
    checkMe: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    discardSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("completeAuthCallback（#724）", () => {
  it("許可されたら通す。セッションは残す", async () => {
    const d = deps();
    expect(await completeAuthCallback(null, d)).toEqual({ ok: true });
    expect(d.exchangeCode).not.toHaveBeenCalled();
    expect(d.discardSession).not.toHaveBeenCalled();
  });

  it("PKCE（iOSアプリ）ではコードを交換してから確かめる", async () => {
    const d = deps();
    expect(await completeAuthCallback("abc", d)).toEqual({ ok: true });
    expect(d.exchangeCode).toHaveBeenCalledWith("abc");
    expect(d.checkMe).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("%i なら許可されていない扱いにし、このアプリのセッションを破棄する", async (status) => {
    const d = deps({ checkMe: vi.fn().mockResolvedValue({ ok: false, status }) });
    expect(await completeAuthCallback(null, d)).toEqual({ ok: false, error: "forbidden" });
    expect(d.discardSession).toHaveBeenCalledTimes(1);
  });

  it("503 ならアカウントのせいにせず、つながらない扱いにする", async () => {
    const d = deps({ checkMe: vi.fn().mockResolvedValue({ ok: false, status: 503 }) });
    expect(await completeAuthCallback(null, d)).toEqual({ ok: false, error: "unavailable" });
    expect(d.discardSession).toHaveBeenCalledTimes(1);
  });

  it("通信が例外になっても読み込みのまま止まらない", async () => {
    const d = deps({ checkMe: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });
    expect(await completeAuthCallback(null, d)).toEqual({ ok: false, error: "unavailable" });
  });

  it("セッションの破棄が失敗してもログイン画面へ戻す", async () => {
    const d = deps({
      checkMe: vi.fn().mockResolvedValue({ ok: false, status: 403 }),
      discardSession: vi.fn().mockRejectedValue(new Error("offline")),
    });
    expect(await completeAuthCallback(null, d)).toEqual({ ok: false, error: "forbidden" });
  });

  it.each([
    ["エラーを返す", vi.fn().mockResolvedValue({ error: new Error("invalid grant") })],
    ["例外を投げる", vi.fn().mockRejectedValue(new Error("network"))],
  ])("コードの交換が%sと、ログインの失敗として戻す", async (_label, exchangeCode) => {
    const d = deps({ exchangeCode });
    expect(await completeAuthCallback("abc", d)).toEqual({ ok: false, error: "failed" });
    expect(d.checkMe).not.toHaveBeenCalled();
  });
});
