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

/** ウィジェットに載せる上限。Mediumで2台並べる（#649） */
export const WIDGET_AIRCON_LIMIT = 2;

/** ウィジェットからの操作。`temp_up` / `temp_down` は0.5℃刻み */
export type WidgetAirconAction = "power_on" | "power_off" | "temp_up" | "temp_down";

export function isWidgetAirconAction(value: unknown): value is WidgetAirconAction {
  return value === "power_on" || value === "power_off" || value === "temp_up" || value === "temp_down";
}

/**
 * 操作できるエアコンを先頭から `limit` 台。操作できない構成（`controllable` が false）では空。
 * ダッシュボードが状態を持っているのは表示中の1台だけなので、状態はその台にだけ入れる
 * （他の台のために取得を増やさない）。操作は状態に頼らず、押した時点でWeb側が読み直す。
 */
export function buildWidgetAircons(
  units: AirconUnitInfo[],
  latest: AirconData | null,
  controllable: boolean,
  limit: number = WIDGET_AIRCON_LIMIT
): WidgetAircon[] {
  if (!controllable) return [];
  return units.slice(0, limit).map((unit) => {
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
