import type { RemoteButtonSetting } from "@/lib/remote";

export type TimeRange = "day" | "week" | "month" | "year" | "custom";

/** グラフの表示幅（横スクロールのウィンドウサイズ） */
export type ChartViewRange = "day" | "week" | "month" | "year";

export type ChartMetric = "temperature" | "humidity" | "pressure" | "co2" | "illuminance";

export interface LatestData {
  device_id?: number;
  datetime?: string;
  temperature?: number;
  temperature_dht11?: number;
  humidity?: number;
  pressure?: number;
  co2?: number;
  illuminance?: number;
  outdoor_temperature?: number;
  outdoor_humidity?: number;
  outdoor_pressure?: number;
  outdoor_weather_code?: number | null;
  outdoor_weather_label?: string | null;
  outdoor_weather_icon?: string | null;
}

export interface SensorRecord {
  datetime: string;
  device_id: number;
  temperature?: number | null;
  temperature_dht11?: number | null;
  humidity?: number | null;
  pressure?: number | null;
  co2?: number | null;
  illuminance?: number | null;
}

export interface SensorRecordsResponse {
  records: SensorRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface HistoryPoint {
  datetime?: string;
  datetimeObj: number;
  temperature?: number;
  temperature_dht11?: number;
  humidity?: number;
  pressure?: number;
  co2?: number;
  illuminance?: number;
  outdoor_temperature?: number;
  outdoor_humidity?: number;
  outdoor_pressure?: number;
  temperatureRange?: [number, number] | null;
  humidityRange?: [number, number] | null;
  pressureRange?: [number, number] | null;
  co2Range?: [number, number] | null;
  illuminanceRange?: [number, number] | null;
  temperature_min?: number;
  temperature_max?: number;
  humidity_min?: number;
  humidity_max?: number;
  pressure_min?: number;
  pressure_max?: number;
  co2_min?: number;
  co2_max?: number;
  illuminance_min?: number;
  illuminance_max?: number;
}

export interface DailyStat {
  date: string;
  temp_min?: number;
  temp_max?: number;
  humid_min?: number;
  humid_max?: number;
  pressure_min?: number;
  pressure_max?: number;
  co2_min?: number;
  co2_max?: number;
  illuminance_min?: number;
  illuminance_max?: number;
}

export interface OutdoorLocation {
  latitude: number;
  longitude: number;
  name: string;
}

/** 登録済みの屋外地点（#308で複数登録に対応） */
export interface OutdoorLocationEntry {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_primary: boolean;
}

/** 特定の地点の「いまの天気」（#308） */
export interface OutdoorLocationWeather {
  id: string;
  name: string;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  weather_code: number | null;
  weather_label: string | null;
  weather_icon: string | null;
  observed_at: string | null;
}

export interface DeviceInfo {
  id: number;
  name: string;
  inherits_from?: number | null;
}

/** 屋外地点の表示名。以前は「地点データ(場所名)」の形だったが、冗長なため場所名だけにする（#308） */
export function formatOutdoorApiLabel(locationName?: string | null): string {
  const trimmed = locationName?.trim();
  return trimmed || "地点未登録";
}

/**
 * その場所の照明を「どこから判定するか」（#368）。
 *
 * `illuminance` は照度としきい値（`light_thresholds`・#258）から復元する。生の赤外線で
 * 操作する照明はクラウド側に状態が残らないため、この経路しか無い。
 * `remote` は Nature Remo に「照明」として登録した機器の状態を読む。`appliance_key` は
 * `GET /api/light-sources` が返す候補の `key` で、Nature Remo の appliance ID は画面へ出さない。
 */
export type LightSource =
  | { kind: "illuminance" }
  | { kind: "remo"; appliance_key: string };

export interface UiSettings {
  display_order: string[];
  /**
   * 「暮らし」のカードを並べる順。中身は `lib/dashboard-sections.ts` の `LIFE_CARDS` のキーで、
   * 空配列は「まだ並べ替えていない」（#283）
   */
  life_card_order: string[];
  chart_colors: Record<string, string>;
  hidden_devices: string[];
  stale_alert_excluded_devices: string[];
  pressure_offsets: Record<string, number>;
  /**
   * デバイスID -> 照明の点灯とみなす照度（lx）。
   * キーが無いデバイスは判定そのものを行わず、点灯・消灯を表示しない（#258）
   */
  light_thresholds: Record<string, number>;
  /**
   * デバイスID -> その場所の照明をどこから判定するか（#368）。
   * キーが無いデバイスは照明を紐付けておらず、詳細パネルに帯も一覧も出ない
   */
  light_sources: Record<string, LightSource>;
  /** 電気料金の単価（円/kWh）。使用量に掛けて電気代の目安を出す */
  energy_unit_price: number;
  /**
   * 消費電力の取得元（`tapo:冷蔵庫`）-> 画面に出す別名（#335）。
   * 既定の名前（Tapoアプリで付けた名前）のままの取得元は入らない
   */
  energy_source_names: Record<string, string>;
  /** 「電気の操作」のボタンID -> 付けた名前・隠す指定。既定のままのボタンは入らない */
  remote_buttons: Record<string, RemoteButtonSetting>;
  /** ゴミの日のPush通知を送るか（#293） */
  garbage_notify_enabled: boolean;
  /** ゴミの日の前日通知の時刻（"HH:MM"）。null は未設定（data/garbage.json の既定を使う） */
  garbage_notify_time: string | null;
  /** ゴミの日の当日通知を送るか（#347）。前日通知とは独立に設定できる */
  garbage_notify_same_day_enabled: boolean;
  /** ゴミの日の当日通知の時刻（"HH:MM"）。null は未設定（既定7:00） */
  garbage_notify_same_day_time: string | null;
  /**
   * 品目ごとの通知タイミング。{category_id: ["before" | "same_day", ...]}。
   * 前日・当日は排他ではなく両方を含められる。キーが無い品目は ["before"]（前日通知のみ）
   */
  garbage_notify_category_timing: Record<string, ("before" | "same_day")[]>;
  /** 室温・湿度の異常をPush通知するか */
  room_anomaly_notify_enabled: boolean;
  /** 指標ごとの上限・下限 */
  room_anomaly_thresholds: {
    temperature: { min: number; max: number };
    humidity: { min: number; max: number };
  };
  /** 同じ異常が続く間の再通知間隔（分） */
  room_anomaly_reminder_minutes: number;
  /**
   * 部屋の3Dビュー（`/room`・#399）で、3D上の場所とセンサー・エアコン・掃除タスクを
   * 結ぶ対応表。`zones` が空 = まだ一度も保存していない（既定の紐付けで開く）。
   * ゾーンの一覧・寸法の正は `lib/room-layout.ts` で、ここには紐付けだけが入る
   */
  room_layout: RoomLayoutSetting;
}

/** `UiSettings.room_layout` の中身。詳しくは `lib/room-layout.ts` */
export interface RoomLayoutSetting {
  zones: {
    key: string;
    device_id: number | null;
    ac_id: number | null;
    cleaning_task_ids: string[];
  }[];
}

export interface PushVapidPublicKeyResponse {
  publicKey: string;
  configured: boolean;
}

export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface PushTestResult {
  status: string;
  sent: number;
  total: number;
}

export interface ApnsStatusResponse {
  configured: boolean;
}

export interface EnergyTotal {
  kwh: number;
  cost_yen: number;
  /** 集計に入った日数（欠けている日は数えない） */
  days: number;
  start: string;
  end: string;
}

/**
 * 消費電力カードの1行。`daily_energy` の取得元（`aircon` / `tapo:<機器名>`）ごとに1件。
 */
export interface EnergySourceRow {
  /** `aircon` / `tapo:冷蔵庫` */
  source: string;
  /** 画面に出す名前。別名を付けていればそれ、無ければ `default_label` と同じ */
  label: string;
  /**
   * 別名を当てる前の名前（#335）。`tapo:` を落としただけの、Tapoアプリで付けた名前。
   * 設定画面が「Tapoの名前」を出すのと、上書き中かどうかの判定に使う
   */
  default_label: string;
  today_kwh: number | null;
  today_cost_yen: number | null;
  /** いまの消費電力（W）。返すのはスマートプラグだけで、エアコンは null */
  power_w: number | null;
  /**
   * `power_w` を受け取った時刻（UTC・ISO8601、#410）。スマートプラグが応答しなくなると
   * `power_w` は最後に受け取った値のまま残り続けるため、動作中判定はこの鮮度も見る
   * （`lib/room-layout.ts` の `isApplianceActive()`）。
   */
  power_updated_at: string | null;
  this_month_kwh: number;
  latest_date: string | null;
}

/** 日別の合計と、その日の取得元ごとの内訳（積み上げグラフに使う） */
export interface EnergyBreakdownDay {
  /** `2026-08-22` */
  date: string;
  kwh: number;
  cost_yen: number;
  /** `{ "aircon": 1.86, "tapo:冷蔵庫": 0.86 }`。値の無い取得元は入らない */
  by_source: Record<string, number>;
}

/** 家全体の1日ぶん。日数は常に1だが、期間合計と同じ形にして扱いを揃える */
export interface EnergyDayTotal {
  date: string;
  kwh: number;
  cost_yen: number;
  days: number;
}

/** 消費電力カードが使う集計。`GET /api/energy/breakdown` の戻り */
export interface EnergyBreakdown {
  unit_price: number;
  /** エアコンが先頭、以降は今月の使用量が多い順 */
  sources: EnergySourceRow[];
  today: EnergyDayTotal;
  this_month: EnergyTotal;
  last_month: EnergyTotal;
  /** 先月の同じ日まで。今月とそのまま比べられる */
  last_month_to_date: EnergyTotal;
  daily: EnergyBreakdownDay[];
  latest_date: string | null;
  updated_at: string | null;
}

/** 1時間ぶんの内訳。`kwh` が `null` なら、その時間帯はまだ記録が無い（未来か、記録開始前） */
export interface EnergyHourlyHour {
  /** 0〜23 */
  hour: number;
  kwh: number | null;
  cost_yen: number | null;
  /** `{ "aircon": 0.31, "tapo:冷蔵庫": 0.11 }`。値の無い取得元は入らない */
  by_source: Record<string, number>;
}

/** 消費電力カードの「時間ごと」表示が使う集計。`GET /api/energy/hourly?date=` の戻り */
export interface EnergyHourly {
  /** `2026-08-22` */
  date: string;
  unit_price: number;
  /** その日にデータのあった取得元 */
  sources: string[];
  /** false の場合、この日はまだ時間ごとの記録が無い（機能をリリースする前の日など） */
  has_data: boolean;
  hours: EnergyHourlyHour[];
}

/** KEPCO「みるでん」CSVの取り込み結果。`POST /api/energy/kepco/import` の戻り */
export interface EnergyKepcoImportResult {
  status: "ok" | "mock_ok";
  imported_rows: number;
  imported_days: number;
  period_start: string | null;
  period_end: string | null;
}

/** `today` / `yesterday` / `daily` の1件。取得元が値を返さなかった日は kwh が null */
export interface EnergySourceDayPoint {
  date: string;
  kwh: number | null;
  cost_yen: number | null;
}

/** 取得元1つぶんの集計。`GET /api/energy/summary?source=...` の戻り */
export interface EnergySourceSummary {
  source: string;
  unit_price: number;
  today: EnergySourceDayPoint | null;
  yesterday: EnergySourceDayPoint | null;
  this_month: EnergyTotal;
  last_month: EnergyTotal;
  last_month_to_date: EnergyTotal;
  daily: EnergySourceDayPoint[];
  latest_date: string | null;
  updated_at: string | null;
}

/**
 * 請求1か月ぶんの、電気またはガスの合計。
 * 引越しの月は契約が2つあるため、金額も使用量も足したものが入る（`contracts` が2になる）。
 */
export interface UtilityBillKindTotal {
  amount_yen: number;
  /** 電気は kWh、ガスは m3 */
  usage_value: number | null;
  usage_unit: string | null;
  /** `なっトクでんき`。契約が複数あれば ` / ` でつなぐ */
  plan_name: string | null;
  contracts: number;
}

/** 請求1か月ぶん。`GET /api/bills/summary` の `months` の1件 */
export interface UtilityBillMonth {
  /** `2026-08`。請求年月なので日にちは持たない */
  billing_month: string;
  electricity: UtilityBillKindTotal | null;
  gas: UtilityBillKindTotal | null;
  total_yen: number;
}

/** 最新の請求月と1つ前の比較。ガスの有無に振り回されないよう電気だけで比べる */
export interface UtilityBillComparison {
  cheaper: boolean;
  percent: number;
  base_amount_yen: number;
  base_billing_month: string;
}

/** 請求月の暦月ぶんの実測（エアコン＋スマートプラグ）。検針期間とはずれるので目安 */
export interface UtilityBillMeasured {
  kwh: number;
  cost_yen: number;
  /** 電気の請求額に対する割合（%）。請求が0円なら null */
  share_percent: number | null;
  start: string;
  end: string;
}

/** 電気・ガス料金カードが使う集計。`GET /api/bills/summary` の戻り */
export interface UtilityBillSummary {
  latest: UtilityBillMonth | null;
  previous: UtilityBillMonth | null;
  comparison: UtilityBillComparison | null;
  /** 記録のある月だけ。古い順。届いていない月は入らない */
  months: UtilityBillMonth[];
  total_yen: number;
  measured: UtilityBillMeasured | null;
  unit_price: number;
  updated_at: string | null;
}

export interface SensorDeviceStatus {
  device_id: number;
  name: string;
  last_seen: string | null;
  age_minutes: number | null;
  stale: boolean;
  has_data: boolean;
}

export interface SensorsStatusResponse {
  threshold_minutes: number;
  healthy: boolean;
  devices: SensorDeviceStatus[];
}

export interface AirconUnitInfo {
  ac_id: number;
  name: string;
}

export interface AirconData {
  ac_id?: number;
  datetime?: string;
  name?: string;
  source_name?: string;
  room_temperature?: number;
  target_temperature?: number;
  humidity?: number;
  mode?: string;
  power?: string;
  fan_speed?: string;
  fan_swing?: string;
  online?: boolean;
  model?: string;
}

export const AIRCON_MODE_LABELS: Record<string, string> = {
  HEATING: "暖房",
  COOLING: "冷房",
  FAN: "送風",
  DRY: "除湿",
  DRY_COOL: "除湿冷房",
  AUTO: "自動",
  UNKNOWN: "--",
};

export function formatAirconMode(mode?: string | null): string {
  if (!mode) return "--";
  return AIRCON_MODE_LABELS[mode] ?? mode;
}

/** 操作できる運転モード。`DRY_COOL` は機種が返すことはあっても、こちらから指定はできない */
export const AIRCON_CONTROL_MODES = [
  "COOLING",
  "HEATING",
  "DRY",
  "FAN",
  "AUTO",
] as const;
export type AirconControlMode = (typeof AIRCON_CONTROL_MODES)[number];

/** 風量。`LV1` が「静」で、数字が上がるほど強い */
export const AIRCON_FAN_SPEEDS = ["AUTO", "LV1", "LV2", "LV3", "LV4"] as const;
export type AirconFanSpeed = (typeof AIRCON_FAN_SPEEDS)[number];

export const AIRCON_FAN_SPEED_LABELS: Record<AirconFanSpeed, string> = {
  AUTO: "自動",
  LV1: "静",
  LV2: "弱",
  LV3: "中",
  LV4: "強",
};

/**
 * 風向。**実機が返すのは `VERTICAL`**（#213で実機確認）。`AUTO` は返ってこない。
 * 画面は「自動（振る）」と「固定」の2択にする。
 */
export const AIRCON_FAN_SWINGS = ["VERTICAL", "OFF"] as const;
export type AirconFanSwing = (typeof AIRCON_FAN_SWINGS)[number];

export const AIRCON_FAN_SWING_LABELS: Record<AirconFanSwing, string> = {
  VERTICAL: "自動",
  OFF: "固定",
};

/**
 * 実機が返した風向を、画面の2択のどちらとして選択状態にするか。
 * 機種によっては `HORIZONTAL` / `BOTH` を返すため、**止まっていない値はすべて「自動」**に寄せる。
 */
export function resolveAirconFanSwingChoice(value?: string | null): AirconFanSwing {
  return (value ?? "").toUpperCase() === "OFF" ? "OFF" : "VERTICAL";
}

export const AIRCON_MIN_TEMPERATURE = 16;
export const AIRCON_MAX_TEMPERATURE = 32;
export const AIRCON_TEMPERATURE_STEP = 0.5;

/** モードごとの色。カードのピルと操作パネルのアクセントに使う */
export const AIRCON_MODE_COLORS: Record<string, string> = {
  COOLING: "#3498db",
  HEATING: "#e8743b",
  DRY: "#56ccf2",
  DRY_COOL: "#56ccf2",
  FAN: "#95a5a6",
  AUTO: "#1abc9c",
};

export function getAirconModeColor(mode?: string | null): string {
  if (!mode) return AIRCON_MODE_COLORS.AUTO;
  return AIRCON_MODE_COLORS[mode.toUpperCase()] ?? AIRCON_MODE_COLORS.AUTO;
}

/** 操作パネルが読み書きする運転状態。DBの最新記録ではなく、エアコンの現在値 */
export interface AirconControlState {
  ac_id: number;
  name?: string;
  power?: string;
  mode?: string;
  room_temperature?: number | null;
  target_temperature?: number | null;
  humidity?: number | null;
  fan_speed?: string;
  fan_swing?: string;
  online?: boolean;
  model?: string | null;
}

/** 運転指示。**指定した項目だけが変わる** */
export interface AirconControlCommand {
  power?: "ON" | "OFF";
  mode?: AirconControlMode;
  target_temperature?: number;
  fan_speed?: AirconFanSpeed;
  fan_swing?: AirconFanSwing;
}

/**
 * 温度の増減。自動運転はシフト量（-5.0〜+5.0）、それ以外は設定温度（16〜32℃）で
 * 範囲が変わる（`backend/aircon_control.py` の `validate_target_temperature()` と対）。
 */
export function stepAirconTemperature(
  value: number,
  delta: number,
  mode?: string | null
): number {
  const isAuto = (mode ?? "").toUpperCase() === "AUTO";
  const min = isAuto ? -AIRCON_AUTO_TARGET_OFFSET_LIMIT : AIRCON_MIN_TEMPERATURE;
  const max = isAuto ? AIRCON_AUTO_TARGET_OFFSET_LIMIT : AIRCON_MAX_TEMPERATURE;
  const next = value + delta * AIRCON_TEMPERATURE_STEP;
  const clamped = Math.min(max, Math.max(min, next));
  // 0.5 刻みに丸める。浮動小数の誤差で 25.999999 のような値を送らないため
  return Math.round(clamped / AIRCON_TEMPERATURE_STEP) * AIRCON_TEMPERATURE_STEP;
}

/** モードを切り替えたときの温度の初期値。バックエンドの `merge_command()` と揃える */
export function defaultAirconTargetForMode(
  mode: string,
  current: number | null | undefined,
  previousMode: string | null | undefined
): number {
  const wasAuto = (previousMode ?? "").toUpperCase() === "AUTO";
  const isAuto = mode.toUpperCase() === "AUTO";
  if (wasAuto === isAuto && current != null) return current;
  return isAuto ? 0 : 26;
}

/** カードに出す運転状態のピル */
export function buildAirconStatusPill(
  data: Pick<AirconData, "mode" | "power" | "target_temperature"> | null | undefined
): { label: string; color: string | null } {
  if (!data || (data.power == null && data.mode == null)) {
    return { label: "--", color: null };
  }
  if (isAirconPowerOff(data.power)) {
    return { label: "停止中", color: null };
  }
  return {
    label: formatAirconModeTarget(data),
    color: getAirconModeColor(data.mode),
  };
}

export function hasAirconData(data: AirconData | null | undefined): boolean {
  if (!data) return false;
  return (
    data.room_temperature != null ||
    data.target_temperature != null ||
    data.power != null ||
    data.mode != null
  );
}

/** センサーカードのデータ取得結果 */
export type DeviceDataLoadStatus = "ok" | "empty" | "error";

export function hasLatestSensorValues(data: LatestData | null | undefined): boolean {
  if (!data) return false;
  return (
    data.temperature != null ||
    data.humidity != null ||
    data.pressure != null ||
    data.co2 != null ||
    data.illuminance != null
  );
}

export function hasOutdoorValues(data: LatestData | null | undefined): boolean {
  if (!data) return false;
  return (
    data.outdoor_temperature != null ||
    data.outdoor_humidity != null ||
    data.outdoor_pressure != null
  );
}

export function pickOutdoorLatestSource(
  latestByDevice: Record<number, LatestData | null | undefined>
): LatestData | null {
  const primary = latestByDevice[PRIMARY_SENSOR_DEVICE_ID];
  if (hasOutdoorValues(primary)) return primary ?? null;

  for (const data of Object.values(latestByDevice)) {
    if (hasOutdoorValues(data)) return data ?? null;
  }

  return primary ?? null;
}

export function resolveOutdoorBatchLoadStatus(
  latestByDevice: Record<number, LatestData | null | undefined>,
  loadStatusByDevice: Record<number, DeviceDataLoadStatus>
): DeviceDataLoadStatus {
  if (hasOutdoorValues(pickOutdoorLatestSource(latestByDevice))) return "ok";

  const statuses = Object.values(loadStatusByDevice);
  if (statuses.length > 0 && statuses.every((status) => status === "error")) {
    return "error";
  }
  return "empty";
}

export function resolveLatestDataLoadStatus(
  data: LatestData | null | undefined,
  fetchFailed: boolean
): DeviceDataLoadStatus {
  if (fetchFailed) return "error";
  if (hasLatestSensorValues(data)) return "ok";
  return "empty";
}

/** 地点ごとの「いまの天気」に値が入っているか（#321） */
export function hasOutdoorLocationValues(
  data: OutdoorLocationWeather | null | undefined
): boolean {
  if (!data) return false;
  return (
    data.temperature != null || data.humidity != null || data.pressure != null
  );
}

/**
 * 地点ごとの屋外カードの読み込み状態（#321）。
 * `fetchFailed` は全地点ぶんの取得に失敗したかどうか。
 */
export function resolveOutdoorLocationLoadStatus(
  data: OutdoorLocationWeather | null | undefined,
  fetchFailed: boolean
): DeviceDataLoadStatus {
  if (hasOutdoorLocationValues(data)) return "ok";
  if (fetchFailed) return "error";
  return "empty";
}

/**
 * `/api/latest` に混ざっている基準地点の天気を、地点ごとの形へ詰め替える（#321）。
 * 一括取得がまだ終わっていないときとオフラインのときに、基準地点のカードだけは
 * これまでどおりの値を出せる。
 */
export function outdoorLocationWeatherFromLatest(
  location: OutdoorLocationEntry,
  latest: LatestData | null | undefined
): OutdoorLocationWeather | null {
  if (!hasOutdoorValues(latest)) return null;
  return {
    id: location.id,
    name: location.name,
    temperature: latest?.outdoor_temperature ?? null,
    humidity: latest?.outdoor_humidity ?? null,
    pressure: latest?.outdoor_pressure ?? null,
    weather_code: latest?.outdoor_weather_code ?? null,
    weather_label: latest?.outdoor_weather_label ?? null,
    weather_icon: latest?.outdoor_weather_icon ?? null,
    observed_at: latest?.datetime ?? null,
  };
}

export function resolveOutdoorDataLoadStatus(
  data: LatestData | null | undefined,
  sourceFetchFailed: boolean
): DeviceDataLoadStatus {
  if (hasOutdoorValues(data)) return "ok";
  if (sourceFetchFailed) return "error";
  return "empty";
}

export function resolveAirconDataLoadStatus(
  data: AirconData | null | undefined,
  fetchFailed: boolean
): DeviceDataLoadStatus {
  if (fetchFailed) return "error";
  if (hasAirconData(data)) return "ok";
  return "empty";
}

/** グラフ・日次記録に使うデバイス */
export const PRIMARY_SENSOR_DEVICE_ID = 1;

/** デバイス一覧取得前のフォールバック */
export const FALLBACK_SENSOR_DEVICE_IDS = [1, 2] as const;

/** @deprecated API のデバイス一覧を使う。互換用フォールバックのみ */
export const DASHBOARD_SENSOR_DEVICE_IDS = FALLBACK_SENSOR_DEVICE_IDS;

/** グラフ用の仮想デバイスID（エアコン室温）。実センサーの device_id と重複しない値 */
export const AIRCON_CHART_DEVICE_ID = 9001;

/** @deprecated 旧バージョンでエアコン室温に使っていた ID（localStorage 移行用） */
export const LEGACY_AIRCON_CHART_DEVICE_ID = 3;

/** /api/devices から屋内センサーの device_id 一覧を得る */
export function getSensorDeviceIds(devices: DeviceInfo[]): number[] {
  const ids = devices
    .map((device) => device.id)
    .filter((id) => id !== AIRCON_CHART_DEVICE_ID)
    .sort((a, b) => a - b);
  return ids.length > 0 ? ids : [...FALLBACK_SENSOR_DEVICE_IDS];
}

export const CHART_METRICS: ChartMetric[] = [
  "temperature",
  "humidity",
  "pressure",
  "co2",
  "illuminance",
];

export function deviceMetricKey(deviceId: number, metric: ChartMetric): string {
  return `d${deviceId}_${metric}`;
}

export function deviceDht11TemperatureKey(deviceId: number): string {
  return `d${deviceId}_temperature_dht11`;
}

export function deviceMetricMinKey(deviceId: number, metric: ChartMetric): string {
  return `d${deviceId}_${metric}_min`;
}

export function deviceMetricMaxKey(deviceId: number, metric: ChartMetric): string {
  return `d${deviceId}_${metric}_max`;
}

export function deviceTargetMetricKey(deviceId: number): string {
  return `d${deviceId}_target_temperature`;
}

export function deviceAirconPowerKey(deviceId: number): string {
  return `d${deviceId}_aircon_power`;
}

export function getDeviceMetricValue(
  point: HistoryPoint,
  deviceId: number,
  metric: ChartMetric
): number | undefined {
  const key = deviceMetricKey(deviceId, metric);
  const row = point as unknown as Record<string, unknown>;
  if (key in row) {
    const value = row[key];
    return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
  }
  if (deviceId === PRIMARY_SENSOR_DEVICE_ID) {
    const legacy = point[metric as keyof HistoryPoint];
    return typeof legacy === "number" && !Number.isNaN(legacy) ? legacy : undefined;
  }
  return undefined;
}

export function getDeviceDht11TemperatureValue(
  point: HistoryPoint,
  deviceId: number
): number | undefined {
  const key = deviceDht11TemperatureKey(deviceId);
  const row = point as unknown as Record<string, unknown>;
  if (key in row) {
    const value = row[key];
    return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
  }
  if (deviceId === PRIMARY_SENSOR_DEVICE_ID) {
    const legacy = point.temperature_dht11;
    return typeof legacy === "number" && !Number.isNaN(legacy) ? legacy : undefined;
  }
  return undefined;
}

export function getDeviceTargetMetricValue(
  point: HistoryPoint,
  deviceId: number
): number | undefined {
  const raw = getDeviceTargetMetricRawValue(point, deviceId);
  if (raw == null || isAirconAutoTarget(raw)) return undefined;
  return raw;
}

export function isAirconPowerOff(power: unknown): boolean {
  return typeof power === "string" && power.toUpperCase() === "OFF";
}

/**
 * AirCloud Home が eco / 自動運転時に返す設定温度は、温度そのものではなく
 * 室温からのシフト量（-3.0〜+3.0 程度、0 はシフトなし）。
 * 固定の設定温度は 16〜32℃ の範囲にしかならないため、この閾値で切り分ける。
 */
export const AIRCON_AUTO_TARGET_OFFSET_LIMIT = 5;

/** 設定温度がシフト量（自動運転）かどうか。0℃ の設定温度ではない */
export function isAirconAutoTarget(value: unknown): boolean {
  return (
    typeof value === "number" &&
    !Number.isNaN(value) &&
    Math.abs(value) <= AIRCON_AUTO_TARGET_OFFSET_LIMIT
  );
}

/** 自動運転時の室温からのシフト量。自動運転でなければ undefined */
export function getAirconAutoTargetOffset(value: unknown): number | undefined {
  return isAirconAutoTarget(value) ? (value as number) : undefined;
}

/** シフト量の表示（符号付き）。シフトなしのときは空文字 */
export function formatAirconAutoTargetOffset(
  offset: number,
  options?: { withUnit?: boolean }
): string {
  if (offset === 0) return "";
  const sign = offset > 0 ? "+" : "-";
  const formatted = `${sign}${Math.abs(offset).toFixed(1)}`;
  return options?.withUnit === false ? formatted : `${formatted}°C`;
}

export function getDeviceTargetMetricRawValue(
  point: HistoryPoint,
  deviceId: number
): number | undefined {
  const key = deviceTargetMetricKey(deviceId);
  const row = point as unknown as Record<string, unknown>;
  const value = row[key];
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function formatAirconTargetTemperature(
  value: number | null | undefined,
  options?: { withUnit?: boolean }
): string {
  if (value == null) return "--";
  const offset = getAirconAutoTargetOffset(value);
  if (offset != null) {
    const offsetLabel = formatAirconAutoTargetOffset(offset, options);
    return offsetLabel
      ? `${AIRCON_MODE_LABELS.AUTO} ${offsetLabel}`
      : AIRCON_MODE_LABELS.AUTO;
  }
  const formatted = value.toFixed(1);
  return options?.withUnit === false ? formatted : `${formatted}°C`;
}

/**
 * カードに出す「運転モード + 設定温度」。
 * 自動運転はモード名と設定温度の表示がどちらも「自動」になるため、1つにまとめる。
 */
export function formatAirconModeTarget(
  data: Pick<AirconData, "mode" | "power" | "target_temperature">
): string {
  const powerOff = isAirconPowerOff(data.power);
  const modeLabel = powerOff ? "停止" : formatAirconMode(data.mode);
  if (powerOff || data.target_temperature == null) return modeLabel;

  const offset = getAirconAutoTargetOffset(data.target_temperature);
  if (offset != null) {
    const autoLabel = AIRCON_MODE_LABELS.AUTO;
    const base = modeLabel === autoLabel ? autoLabel : `${modeLabel} ${autoLabel}`;
    const offsetLabel = formatAirconAutoTargetOffset(offset);
    return offsetLabel ? `${base} ${offsetLabel}` : base;
  }

  return `${modeLabel} ${formatAirconTargetTemperature(data.target_temperature)}`;
}

/** Recharts 用の設定温度系列キー */
export const AIRCON_TARGET_CHART_KEY = "airconTarget";

/** グラフのデバイスライン色（指標に関係なくデバイス固定） */
export const DEVICE_LINE_COLORS: Record<number, string> = {
  1: "#3498db",
  2: "#e67e22",
  3: "#9b59b6",
  [AIRCON_CHART_DEVICE_ID]: "#1abc9c",
};

/** エアコン設定温度ライン（室温とは別色） */
export const AIRCON_TARGET_LINE_COLORS = {
  light: "#9333ea",
  dark: "#e879f9",
} as const;

export function getDeviceLineColor(deviceId: number): string {
  return DEVICE_LINE_COLORS[deviceId] ?? "#95a5a6";
}

export function getAirconTargetLineColor(theme: "light" | "dark" = "light"): string {
  return AIRCON_TARGET_LINE_COLORS[theme];
}

export interface OutdoorLocationSearchResult {
  name: string;
  label: string;
  latitude: number;
  longitude: number;
}

export const METRIC_COLORS: Record<ChartMetric, string> = {
  temperature: "#3498db",
  humidity: "#2ecc71",
  pressure: "#9b59b6",
  co2: "#e67e22",
  illuminance: "#f1c40f",
};

export const METRIC_LABELS: Record<ChartMetric, string> = {
  temperature: "温度",
  humidity: "湿度",
  pressure: "気圧",
  co2: "CO2",
  illuminance: "照度",
};

export const METRIC_UNITS: Record<ChartMetric, string> = {
  temperature: "°C",
  humidity: "%",
  pressure: "hPa",
  co2: "ppm",
  illuminance: " lx",
};

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  day: "1D",
  week: "1W",
  month: "1M",
  year: "1Y",
  custom: "全期間",
};

export const CHART_VIEW_RANGE_LABELS: Record<ChartViewRange, string> = {
  day: "日",
  week: "週",
  month: "月",
  year: "年",
};
