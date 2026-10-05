import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnergyRefetchSheet, refetchSubtitle } from "@/components/energy-refetch-sheet";
import type { EnergyRefetch } from "@/lib/energy-refetch";

function state(overrides: Partial<EnergyRefetch> = {}): EnergyRefetch {
  return {
    requested_at: "2026-10-05T10:00:00+09:00",
    since: "2026-10-01",
    pending: true,
    sources: {
      tapo: { status: "done", done_at: "2026-10-05T10:05:00+09:00", max_days: 92 },
      aircon: { status: "waiting", done_at: null, max_days: 31 },
    },
    ...overrides,
  };
}

describe("EnergyRefetchSheet", () => {
  it("最初は日付の入力と、既定（5日前）の再取得ボタンを出す", () => {
    const html = renderToStaticMarkup(
      <EnergyRefetchSheet today="2026-10-05" onClose={() => {}} onCompleted={() => {}} />
    );
    expect(html).toContain("データの再取得");
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain("10月1日以降を再取得する");
    expect(html).toContain("依頼前");
  });

  it("状況の一文は依頼中・完了・未完了で変わる", () => {
    expect(refetchSubtitle(null)).toBe("取得できなかった日を取り直します");
    expect(refetchSubtitle(state())).toBe("10月1日以降を依頼しました");
    const done = state({
      pending: false,
      sources: {
        tapo: { status: "done", done_at: null, max_days: 92 },
        aircon: { status: "done", done_at: null, max_days: 31 },
      },
    });
    expect(refetchSubtitle(done)).toBe("10月1日以降の取得が済みました");
    const timedOut = state({
      pending: false,
      sources: {
        tapo: { status: "done", done_at: null, max_days: 92 },
        aircon: { status: "timed_out", done_at: null, max_days: 31 },
      },
    });
    expect(refetchSubtitle(timedOut)).toBe("10月1日以降の取得が完了しませんでした");
  });
});
