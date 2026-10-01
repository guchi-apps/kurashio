import { describe, expect, it } from "vitest";
import type { GarbageCategory, GarbageDay, GarbageSchedule } from "@/lib/garbage";
import { buildWidgetGarbageDays } from "@/lib/widget-garbage";

const burnable: GarbageCategory = { id: "burnable", name: "燃えるごみ", color: "#e67e22", note: "" };
const plastic: GarbageCategory = { id: "plastic", name: "資源", color: "#1abc9c", note: "" };

function day(date: string, weekday: string, daysUntil: number, categories: GarbageCategory[]): GarbageDay {
  return { date, weekday, days_until: daysUntil, categories, notes: [] };
}

function schedule(overrides: Partial<GarbageSchedule> = {}): GarbageSchedule {
  return {
    configured: true,
    area: "テスト",
    today: day("2026-08-25", "火", 0, [burnable]),
    tomorrow: day("2026-08-26", "水", 1, []),
    upcoming: [
      day("2026-08-27", "木", 2, [plastic]),
      day("2026-08-28", "金", 3, []),
      day("2026-08-29", "土", 4, [burnable]),
    ],
    ...overrides,
  };
}

describe("buildWidgetGarbageDays", () => {
  it("収集がある日だけを日付順に返し、品目の色も渡す", () => {
    expect(buildWidgetGarbageDays(schedule())).toEqual([
      { date: "2026-08-25", weekday: "火", categories: [{ name: "燃えるごみ", color: "#e67e22" }] },
      { date: "2026-08-27", weekday: "木", categories: [{ name: "資源", color: "#1abc9c" }] },
      { date: "2026-08-29", weekday: "土", categories: [{ name: "燃えるごみ", color: "#e67e22" }] },
    ]);
  });

  it("今日の収集が済んでいても今日を含める（切り替えはウィジェットが時刻で行う）", () => {
    const days = buildWidgetGarbageDays(schedule({ today_done: true }));
    expect(days[0]?.date).toBe("2026-08-25");
  });

  it("毎日収集があっても5件までに絞る", () => {
    const all = schedule({
      tomorrow: day("2026-08-26", "水", 1, [plastic]),
      upcoming: [
        day("2026-08-27", "木", 2, [plastic]),
        day("2026-08-28", "金", 3, [plastic]),
        day("2026-08-29", "土", 4, [plastic]),
        day("2026-08-30", "日", 5, [plastic]),
      ],
    });
    expect(buildWidgetGarbageDays(all)).toHaveLength(5);
  });

  it("収集が1件も無ければ空", () => {
    const none = schedule({
      today: day("2026-08-25", "火", 0, []),
      upcoming: [],
    });
    expect(buildWidgetGarbageDays(none)).toEqual([]);
  });
});
