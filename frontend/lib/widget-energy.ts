import { KEPCO_OTHER_SOURCE } from "@/lib/energy";
import type { EnergyBreakdown } from "@/lib/types";

/** 「今日の電気」ウィジェット（`ios/KurashioWidget/EnergyWidget.swift`）に渡す値 */
export interface WidgetEnergy {
  /** 値の基準日（サーバーのJST。`breakdown.today.date`）。ウィジェットが日付またぎを見分ける */
  energyDate: string | null;
  todayKwh: number | null;
  todayCostYen: number | null;
  yesterdayKwh: number | null;
  monthKwh: number | null;
}

/** `2026-10-01` の前日。端末の時計・タイムゾーンに依らず、文字列の暦だけで数える */
export function previousDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * ダッシュボードの消費電力の集計から、ウィジェットに出す値を作る。
 *
 * `daily` にだけ KEPCO実測との差分（「その他」）が足し込まれており、`today`・`this_month` は
 * 機器の実測だけ。昨日を `daily` からそのまま取ると今日と基準がずれるため、「その他」を引く。
 */
export function buildWidgetEnergy(breakdown: EnergyBreakdown | null): WidgetEnergy {
  if (!breakdown) {
    return { energyDate: null, todayKwh: null, todayCostYen: null, yesterdayKwh: null, monthKwh: null };
  }
  const yesterday = previousDate(breakdown.today.date);
  const day = breakdown.daily.find((item) => item.date === yesterday);
  const yesterdayKwh = day
    ? Math.max(0, day.kwh - (day.by_source[KEPCO_OTHER_SOURCE] ?? 0))
    : null;
  return {
    energyDate: breakdown.today.date,
    todayKwh: breakdown.today.kwh,
    todayCostYen: breakdown.today.cost_yen,
    yesterdayKwh: yesterdayKwh == null ? null : Math.round(yesterdayKwh * 100) / 100,
    monthKwh: breakdown.this_month.kwh,
  };
}
