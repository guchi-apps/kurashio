import type { DisplayOrderItem } from "@/lib/display-order";
import { getCo2Level, type Co2Level } from "@/lib/device-metrics";
import type { LatestData } from "@/lib/types";

/** ホーム画面ウィジェットで選べるセンサー1つぶんの値（`SharedWidgetSnapshot.Sensor` と同じ形） */
export interface WidgetSensor {
  id: number;
  name: string;
  temperature: number | null;
  humidity: number | null;
  /** CO2濃度（ppm）。CO2を測れないセンサーでは null（#569） */
  co2: number | null;
  /**
   * CO2の目安（`getCo2Level()`）。しきい値の判定はここだけに置き、ウィジェット（Swift）は
   * この段階に色を当てるだけにする（判定を2か所に持つと1500ppmちょうどなどで食い違う）
   */
  co2Level: Co2Level | null;
  /** 受信が止まっている（値は最後に受信した時点のもの） */
  stale: boolean;
  /**
   * 値を測った時刻（`LatestData.datetime` をそのまま。JSTの文字列）。Apple Watch が「いつの値か」を出す（#677）。
   * 端末の時計では解釈し直さず、Swift側で文字列から切り出す。届いていなければ null
   */
  measuredAt: string | null;
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
    const co2 = latest?.co2 ?? null;
    return [
      {
        id: item.deviceId,
        name: getName(item.deviceId),
        temperature: latest?.temperature ?? null,
        humidity: latest?.humidity ?? null,
        co2,
        co2Level: co2 == null ? null : getCo2Level(co2).level,
        stale: isStale(item.deviceId),
        measuredAt: latest?.datetime ?? null,
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
