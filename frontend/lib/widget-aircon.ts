import type { AirconData, AirconUnitInfo } from "@/lib/types";

/** ホーム画面ウィジェット（エアコンの操作）に並べる1台ぶん（`SharedWidgetSnapshot.Aircon` と同じ形） */
export interface WidgetAircon {
  id: number;
  name: string;
  power: string | null;
  mode: string | null;
  roomTemperature: number | null;
  targetTemperature: number | null;
}

/** ウィジェットに載せる台数。ダッシュボードが状態を持つのは表示中の1台だけなので1台に絞る（#649） */
export const WIDGET_AIRCON_LIMIT = 1;

/** ウィジェットからの操作。`temp_up` / `temp_down` は0.5℃刻み */
export type WidgetAirconAction = "power_on" | "power_off" | "temp_up" | "temp_down";

export function isWidgetAirconAction(value: unknown): value is WidgetAirconAction {
  return value === "power_on" || value === "power_off" || value === "temp_up" || value === "temp_down";
}

/**
 * 操作できるエアコン。操作できない構成（`controllable` が false）では空。
 * 対象はダッシュボードが状態を持っている表示中の1台（`latest`）。状態の無い台のために
 * 取得を増やさない。`latest` がまだ無いときは先頭の台を、状態なしで出す。
 * 設定温度の値は自動運転ではシフト量（`mode` が AUTO）なので、読む側が `mode` で出し分ける。
 */
export function buildWidgetAircons(
  units: AirconUnitInfo[],
  latest: AirconData | null,
  controllable: boolean,
  limit: number = WIDGET_AIRCON_LIMIT
): WidgetAircon[] {
  if (!controllable) return [];
  const active = units.find((unit) => unit.ac_id === latest?.ac_id);
  const ordered = active ? [active, ...units.filter((unit) => unit !== active)] : units;
  return ordered.slice(0, limit).map((unit) => {
    const state = latest?.ac_id === unit.ac_id ? latest : null;
    return {
      id: unit.ac_id,
      name: unit.name,
      power: state?.power ?? null,
      mode: state?.mode ?? null,
      roomTemperature: state?.room_temperature ?? null,
      targetTemperature: state?.target_temperature ?? null,
    };
  });
}
