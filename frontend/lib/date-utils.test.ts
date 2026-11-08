import { describe, expect, it } from "vitest";
import { formatMonthDay, shiftDate } from "@/lib/date-utils";

describe("shiftDate", () => {
  it("月をまたいでも1日ずれない", () => {
    expect(shiftDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("formatMonthDay", () => {
  it("月日だけに縮める", () => {
    expect(formatMonthDay("2026-08-26")).toBe("8/26");
    expect(formatMonthDay("不明")).toBe("不明");
  });
});
