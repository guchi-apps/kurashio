import { describe, expect, it } from "vitest";
import {
  ENERGY_REFETCH_MAX_DAYS,
  earliestRefetchDate,
  formatRefetchDate,
  formatRefetchTime,
  isValidRefetchDate,
  refetchSpanDays,
} from "@/lib/energy-refetch";

const TODAY = "2026-10-05";

describe("energy-refetch", () => {
  it("当日を含めて日数を数える", () => {
    expect(refetchSpanDays("2026-10-05", TODAY)).toBe(1);
    expect(refetchSpanDays("2026-10-01", TODAY)).toBe(5);
    expect(refetchSpanDays("2026-09-30", TODAY)).toBe(6);
  });

  it("未来・遡りすぎ・形の不正は送れない日付として扱う", () => {
    expect(isValidRefetchDate("2026-10-06", TODAY)).toBe(false);
    expect(isValidRefetchDate("", TODAY)).toBe(false);
    expect(isValidRefetchDate("10/01", TODAY)).toBe(false);
    expect(isValidRefetchDate(earliestRefetchDate(TODAY), TODAY)).toBe(true);
    expect(refetchSpanDays(earliestRefetchDate(TODAY), TODAY)).toBe(ENERGY_REFETCH_MAX_DAYS);
    expect(isValidRefetchDate("2026-07-01", TODAY)).toBe(false);
  });

  it("日付と時刻をサーバーの表記のまま切り出す", () => {
    expect(formatRefetchDate("2026-10-01")).toBe("10月1日");
    expect(formatRefetchTime("2026-10-05T10:41:00+09:00")).toBe("10:41");
    expect(formatRefetchTime(null)).toBeNull();
  });
});
