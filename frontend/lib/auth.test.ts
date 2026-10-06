import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 共有Supabaseプロジェクトの他アプリ・他端末のセッションを巻き込まないことの回帰テスト（#426）。
// `signOut()` は引数なしだと scope が `global` になり、同じユーザーの全 refresh token を失効させる。
const { signOut, getSession } = vi.hoisted(() => ({
  signOut: vi.fn().mockResolvedValue({ error: null }),
  getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: { auth: { signOut, getSession } },
}));

import { AuthError, signOutThisApp } from "@/lib/auth";
import { fetchUiSettings } from "@/lib/api";

describe("signOutThisApp", () => {
  beforeEach(() => {
    signOut.mockClear();
  });

  it("このアプリのセッションだけを破棄する（scope: local）", async () => {
    await signOutThisApp();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe.each([401, 403])("%i応答時のセッション破棄", (status) => {
  beforeEach(() => {
    signOut.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status, ok: false } as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("他アプリのセッションを巻き込まず（scope: local）、AuthError を投げる", async () => {
    await expect(fetchUiSettings()).rejects.toBeInstanceOf(AuthError);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("認証と関係ない失敗ではセッションを残す", () => {
  beforeEach(() => {
    signOut.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("503（認証サーバーへ届かない）ではログアウトさせない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503, ok: false } as Response));
    await expect(fetchUiSettings()).rejects.not.toBeInstanceOf(AuthError);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("通信不達ではログアウトさせない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchUiSettings()).rejects.toBeInstanceOf(TypeError);
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("signOut の呼び出し箇所", () => {
  const frontendRoot = path.resolve(__dirname, "..");
  const skipDirs = new Set(["node_modules", ".next", "out", "public"]);

  function collectSources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (skipDirs.has(name)) return [];
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return collectSources(full);
      // このテスト自体は検索対象の文字列を含むので除く
      if (full === __filename) return [];
      return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("`auth.signOut(` を直接呼ぶのは lib/auth.ts だけで、必ず scope を渡している", () => {
    const offenders: string[] = [];
    for (const file of collectSources(frontendRoot)) {
      const source = readFileSync(file, "utf8");
      const calls = source.match(/\.signOut\(([^)]*)\)/g) ?? [];
      if (calls.length === 0) continue;
      const relative = path.relative(frontendRoot, file);
      if (relative !== path.join("lib", "auth.ts")) {
        offenders.push(`${relative}: ${calls.join(", ")}`);
        continue;
      }
      for (const call of calls) {
        if (!/scope:\s*"local"/.test(call)) offenders.push(`${relative}: ${call}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
