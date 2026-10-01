import type { GarbageSchedule } from "@/lib/garbage";

/** ウィジェットへ渡す品目1つぶん。色はアプリで設定したもの（`#rrggbb`） */
export interface WidgetGarbageCategory {
  name: string;
  color: string;
}

/** ウィジェットへ渡す収集日1日ぶん。`days_until` は渡さない（ウィジェットが端末の日付から数える） */
export interface WidgetGarbageDay {
  /** "2026-08-26" */
  date: string;
  /** "水" */
  weekday: string;
  categories: WidgetGarbageCategory[];
}

/** 渡す日数の上限。API は今日・明日と、2日後から最大3件を返すので、全部で5件になる */
export const WIDGET_GARBAGE_MAX_DAYS = 5;

/**
 * 「ごみの日」ウィジェット用に、収集がある日を日付順に最大5件へ整形する。
 *
 * **今日は `today_done` に関わらず含める。** 収集時刻を過ぎたら次の日へ切り替える判定はウィジェットが
 * 時刻で行う（ダッシュボードを開かないまま時刻を過ぎても切り替わるようにするため）。
 */
export function buildWidgetGarbageDays(schedule: GarbageSchedule): WidgetGarbageDay[] {
  return [schedule.today, schedule.tomorrow, ...schedule.upcoming]
    .filter((day) => day.categories.length > 0)
    .slice(0, WIDGET_GARBAGE_MAX_DAYS)
    .map((day) => ({
      date: day.date,
      weekday: day.weekday,
      categories: day.categories.map((category) => ({
        name: category.name,
        color: category.color,
      })),
    }));
}
