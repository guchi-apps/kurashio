import { describe, expect, it } from "vitest";
import { describeWidgetRefresh, formatFetchedAt } from "@/components/widget-refresh-row";

describe("ウィジェットの自動更新の表示（#786）", () => {
  it("トークンが無ければ未設定で、再設定を出す", () => {
    const view = describeWidgetRefresh({ hasToken: false, status: "off" });
    expect(view.label).toBe("未設定");
    expect(view.canReset).toBe(true);
  });

  it("取得に失敗していれば失敗と、最後に取れた時刻を出す", () => {
    // 2026-10-12 18:18 UTC = JST 03:18
    const view = describeWidgetRefresh({ hasToken: true, status: "failed", fetchedAt: Date.UTC(2026, 9, 12, 18, 18) / 1000 });
    expect(view.label).toBe("失敗");
    expect(view.detail).toContain("3:18");
    expect(view.canReset).toBe(true);
  });

  it("動いていれば有効で、再設定は出さない", () => {
    const view = describeWidgetRefresh({ hasToken: true, status: "active", fetchedAt: null });
    expect(view.label).toBe("有効");
    expect(view.canReset).toBe(false);
  });

  it("古いアプリ（status 無し）はトークンの有無で判断する", () => {
    expect(describeWidgetRefresh({ hasToken: false }).label).toBe("未設定");
    expect(describeWidgetRefresh({ hasToken: true }).label).toBe("有効");
  });

  it("時刻は端末の時計ではなくJSTで出す", () => {
    expect(formatFetchedAt(Date.UTC(2026, 9, 12, 18, 18) / 1000)).toBe("3:18");
    expect(formatFetchedAt(null)).toBeNull();
  });
});
