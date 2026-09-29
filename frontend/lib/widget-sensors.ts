import type { DisplayOrderItem } from "@/lib/display-order";
import type { LatestData } from "@/lib/types";

/** ホーム画面ウィジェットで選べるセンサー1つぶんの値（`SharedWidgetSnapshot.Sensor` と同じ形） */
export interface WidgetSensor {
  id: number;
  name: string;
  temperature: number | null;
  humidity: number | null;
  /** 受信が止まっている（値は最後に受信した時点のもの） */
  stale: boolean;
}

/**
 * iPhoneのホーム画面ウィジェット（#537）で選べるセンサーの一覧を、ダッシュボードのカードから作る（#560）。
 *
 * ウィジェットは「ウィジェットを編集」で表示するセンサーを選ぶ（`ios/KurashioWidget/SensorSelection.swift`）。
 * 選択肢はここで渡した一覧だけで、**ダッシュボードで表示中のセンサーのカード**を並び順どおりに並べる
 * （非表示のセンサーはダッシュボードが値を取得していないため載せない）。
 *
 * @param visibleDisplayOrder 非表示を除いたダッシュボードの並び
 * @param latestByDevice センサーごとの最新値
 * @param getName センサーの表示名
 * @param isStale 受信が止まっているか（状態を取得できていなければ false を返す）
 */
export function buildWidgetSensors(
  visibleDisplayOrder: readonly DisplayOrderItem[],
  latestByDevice: Record<number, LatestData | null | undefined>,
  getName: (deviceId: number) => string,
  isStale: (deviceId: number) => boolean
): WidgetSensor[] {
  return visibleDisplayOrder.flatMap((item) => {
    if (item.type !== "device") return [];
    const latest = latestByDevice[item.deviceId];
    return [
      {
        id: item.deviceId,
        name: getName(item.deviceId),
        temperature: latest?.temperature ?? null,
        humidity: latest?.humidity ?? null,
        stale: isStale(item.deviceId),
      },
    ];
  });
}

/**
 * ウィジェットでセンサーを選んでいないときに出すセンサー（#560）。
 *
 * **デバイスID 1（`PRIMARY_SENSOR_DEVICE_ID`）に固定しないこと。** ID 1 のセンサーが止まって
 * 非表示にされていると、ダッシュボードはそのIDを取得しないため、ウィジェットの室温が「—」のままになる
 * （実際に踏んだ）。一覧の先頭から見て、**受信が止まっていない最初の、室温を持つセンサー**を選ぶ。
 * 受信中のものが無ければ、止まっていても室温を持つ最初のセンサーへ倒す（空よりは分かる）。
 */
export function pickDefaultWidgetSensor(sensors: readonly WidgetSensor[]): WidgetSensor | null {
  const withTemperature = sensors.filter((sensor) => sensor.temperature != null);
  return withTemperature.find((sensor) => !sensor.stale) ?? withTemperature[0] ?? null;
}
