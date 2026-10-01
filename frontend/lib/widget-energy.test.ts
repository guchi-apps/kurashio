import { describe, expect, it } from "vitest";
import { buildWidgetEnergy, previousDate } from "@/lib/widget-energy";
import type { EnergyBreakdown } from "@/lib/types";

function breakdown(daily: EnergyBreakdown["daily"]): EnergyBreakdown {
  return {
    unit_price: 31,
    sources: [],
    today: { date: "2026-10-01", kwh: 9.4, cost_yen: 312, days: 1 },
    this_month: { kwh: 9.4, cost_yen: 312, days: 1, start: "2026-10-01", end: "2026-10-01" },
    last_month: { kwh: 200, cost_yen: 6000, days: 30, start: "2026-09-01", end: "2026-09-30" },
    last_month_to_date: { kwh: 0, cost_yen: 0, days: 0, start: "2026-09-01", end: "2026-09-01" },
    daily,
    latest_date: "2026-10-01",
    updated_at: null,
  } as EnergyBreakdown;
}

describe("buildWidgetEnergy", () => {
  it("集計が無ければすべて null", () => {
    expect(buildWidgetEnergy(null)).toEqual({
      energyDate: null, todayKwh: null, todayCostYen: null, yesterdayKwh: null, monthKwh: null,
    });
  });

  it("昨日は daily から引き、KEPCOの「その他」は除く", () => {
    const result = buildWidgetEnergy(
      breakdown([{ date: "2026-09-30", kwh: 10, cost_yen: 300, by_source: { aircon: 6, kepco_other: 1.4 } }])
    );
    expect(result.yesterdayKwh).toBe(8.6);
    expect(result.energyDate).toBe("2026-10-01");
    expect(result.todayKwh).toBe(9.4);
    expect(result.monthKwh).toBe(9.4);
  });

  it("昨日の記録が無ければ yesterdayKwh は null", () => {
    expect(buildWidgetEnergy(breakdown([])).yesterdayKwh).toBeNull();
  });
});

describe("previousDate", () => {
  it("月・年をまたいで1日戻す", () => {
    expect(previousDate("2026-10-01")).toBe("2026-09-30");
    expect(previousDate("2026-01-01")).toBe("2025-12-31");
  });
});
