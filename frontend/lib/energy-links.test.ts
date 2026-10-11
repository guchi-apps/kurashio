import { describe, expect, it } from "vitest";
import { describeLinkCandidate } from "@/lib/energy-links";

const base = {
  source: "tapo:サブPC",
  canonical: "tapo:PC",
  label: "サブPC",
  canonical_label: "PC",
  old_first_date: "2026-08-01",
  old_last_date: "2026-10-10",
  old_kwh_total: 82.44,
  new_first_date: "2026-10-11",
  gap_days: 1,
};

describe("describeLinkCandidate", () => {
  it("旧名の期間・量と新名の開始日を並べる", () => {
    expect(describeLinkCandidate(base)).toBe(
      "「サブPC」は8/1〜10/10（82.4 kWh）で止まり、「PC」が翌日から10/11から始まっています",
    );
  });

  it("間があいていればその日数を出す", () => {
    expect(describeLinkCandidate({ ...base, gap_days: 3 })).toContain("3日あけて");
  });
});
