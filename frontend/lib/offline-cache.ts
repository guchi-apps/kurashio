import type { ChartColorSettings } from "@/lib/chart-colors";
import type { CleaningSchedule } from "@/lib/cleaning";
import type { DisplayOrderItem } from "@/lib/display-order";
import type { FilamentPayload } from "@/lib/filament";
import type { GarbageSchedule } from "@/lib/garbage";
import type { RemoteButtons } from "@/lib/remote";
import type {
  AirconData,
  AirconUnitInfo,
  DailyStat,
  DeviceInfo,
  HistoryPoint,
  LatestData,
  OutdoorLocation,
  OutdoorLocationEntry,
  OutdoorLocationWeather,
  EnergyBreakdown,
  SensorDeviceStatus,
  UtilityBillSummary,
} from "@/lib/types";

export const OFFLINE_CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DB_NAME = "myroom-offline";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "dashboard";

/**
 * 表示設定（並び順・非表示など）。起動直後に前回と同じ並びで出すために持つ（#735）。
 * 設定の正はサーバー（`app_settings`）で、取り直せたらそちらで置き換える
 */
export interface DashboardSnapshotUiSettings {
  displayOrder: DisplayOrderItem[];
  lifeCardOrder: string[];
  chartColors: ChartColorSettings;
  /** `Set` は IndexedDB へそのまま入るが、読み書きの形を揃えるため配列で持つ */
  hiddenDeviceKeys: string[];
  staleAlertExcludedKeys: string[];
  lightThresholds: Record<string, number>;
}

/**
 * 「暮らし」のカードなど、センサー以外の表示データ（#735）。
 * **3Dプリンターの状態は持たない。** 印刷の進捗は分単位で変わり、「いま」の基準も応答の時刻なので、
 * 前回の値を出すと終わった印刷を印刷中と見せてしまう（フィラメント残量はアプリの記録なので持つ）
 */
export interface DashboardSnapshotLife {
  garbageSchedule: GarbageSchedule | null;
  energyBreakdown: EnergyBreakdown | null;
  remoteButtons: RemoteButtons | null;
  billSummary: UtilityBillSummary | null;
  cleaningSchedule: CleaningSchedule | null;
  filament: FilamentPayload | null;
  sensorStatuses: SensorDeviceStatus[];
  staleThresholdMinutes: number | null;
}

export interface DashboardOfflineSnapshot {
  cachedAt: string;
  dataLatestAt: string | null;
  sensorDeviceIds: number[];
  airconAcId: number;
  latestByDevice: Record<number, LatestData | null>;
  dailyStatsByDevice: Record<number, DailyStat[]>;
  airconLatest: AirconData | null;
  historyData: HistoryPoint[];
  devices: DeviceInfo[];
  airconUnits: AirconUnitInfo[];
  /** 基準地点。#321より前に保存されたスナップショットにはこれしか無い */
  outdoorLocation: OutdoorLocation | null;
  /** 登録済みの屋外地点。オフラインでも地点ごとのカードを並べるために持つ（#321） */
  outdoorLocations?: OutdoorLocationEntry[];
  /** 地点ごとの「いまの天気」（#321） */
  outdoorWeathers?: OutdoorLocationWeather[];
  /** #735 より前に保存されたスナップショットには無い */
  uiSettings?: DashboardSnapshotUiSettings;
  /** #735 より前に保存されたスナップショットには無い */
  life?: DashboardSnapshotLife;
}

export interface BuildDashboardOfflineSnapshotInput {
  sensorDeviceIds: number[];
  airconAcId: number;
  latestByDevice: Record<number, LatestData | null>;
  dailyStatsByDevice: Record<number, DailyStat[]>;
  airconLatest: AirconData | null;
  historyData: HistoryPoint[];
  devices: DeviceInfo[];
  airconUnits: AirconUnitInfo[];
  outdoorLocation: OutdoorLocation | null;
  outdoorLocations?: OutdoorLocationEntry[];
  outdoorWeathers?: OutdoorLocationWeather[];
  uiSettings?: DashboardSnapshotUiSettings;
  life?: DashboardSnapshotLife;
  windowMs?: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = run(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      })
  );
}

export function parseDataTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function getLatestDataTimestamp(
  latestByDevice: Record<number, LatestData | null>,
  airconLatest: AirconData | null,
  historyData: HistoryPoint[] = []
): number | null {
  const timestamps: number[] = [];

  for (const latest of Object.values(latestByDevice)) {
    const parsed = parseDataTimestamp(latest?.datetime);
    if (parsed != null) timestamps.push(parsed);
  }

  const airconTimestamp = parseDataTimestamp(airconLatest?.datetime);
  if (airconTimestamp != null) timestamps.push(airconTimestamp);

  for (const point of historyData) {
    if (Number.isFinite(point.datetimeObj)) {
      timestamps.push(point.datetimeObj);
    }
  }

  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function filterHistoryToOfflineWindow(
  historyData: HistoryPoint[],
  latestMs: number,
  windowMs = OFFLINE_CACHE_WINDOW_MS
): HistoryPoint[] {
  const minMs = latestMs - windowMs;
  return historyData.filter(
    (point) => point.datetimeObj >= minMs && point.datetimeObj <= latestMs
  );
}

export function filterDailyStatsToOfflineWindow(
  dailyStatsByDevice: Record<number, DailyStat[]>,
  latestMs: number,
  windowMs = OFFLINE_CACHE_WINDOW_MS
): Record<number, DailyStat[]> {
  const minDate = new Date(latestMs - windowMs).toISOString().slice(0, 10);
  const latestDate = new Date(latestMs).toISOString().slice(0, 10);
  const filtered: Record<number, DailyStat[]> = {};

  for (const [deviceId, stats] of Object.entries(dailyStatsByDevice)) {
    filtered[Number(deviceId)] = stats.filter((stat) => {
      const date = String(stat.date).slice(0, 10);
      return date >= minDate && date <= latestDate;
    });
  }

  return filtered;
}

export function buildDashboardOfflineSnapshot(
  input: BuildDashboardOfflineSnapshotInput
): DashboardOfflineSnapshot | null {
  const windowMs = input.windowMs ?? OFFLINE_CACHE_WINDOW_MS;
  const latestMs = getLatestDataTimestamp(
    input.latestByDevice,
    input.airconLatest,
    input.historyData
  );

  if (latestMs == null) return null;

  const historyData = filterHistoryToOfflineWindow(input.historyData, latestMs, windowMs);
  if (historyData.length === 0) return null;

  return {
    cachedAt: new Date().toISOString(),
    dataLatestAt: new Date(latestMs).toISOString(),
    sensorDeviceIds: [...input.sensorDeviceIds],
    airconAcId: input.airconAcId,
    latestByDevice: input.latestByDevice,
    dailyStatsByDevice: filterDailyStatsToOfflineWindow(
      input.dailyStatsByDevice,
      latestMs,
      windowMs
    ),
    airconLatest: input.airconLatest,
    historyData,
    devices: input.devices,
    airconUnits: input.airconUnits,
    outdoorLocation: input.outdoorLocation,
    outdoorLocations: input.outdoorLocations ?? [],
    outdoorWeathers: input.outdoorWeathers ?? [],
    ...(input.uiSettings ? { uiSettings: input.uiSettings } : {}),
    ...(input.life ? { life: input.life } : {}),
  };
}

export async function saveDashboardOfflineSnapshot(
  snapshot: DashboardOfflineSnapshot
): Promise<void> {
  await runTransaction("readwrite", (store) => store.put(snapshot, SNAPSHOT_KEY));
}

export async function loadDashboardOfflineSnapshot(): Promise<DashboardOfflineSnapshot | null> {
  try {
    const snapshot = await runTransaction<DashboardOfflineSnapshot | undefined>("readonly", (store) =>
      store.get(SNAPSHOT_KEY)
    );
    return snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * 端末に残した前回のデータを消す。ログアウト時に呼ぶ（#735）。
 * 起動直後に前回のデータを出すようになったため、残すと次にログインした別のアカウントに一瞬見える
 */
export async function clearDashboardOfflineSnapshot(): Promise<void> {
  try {
    await runTransaction("readwrite", (store) => store.delete(SNAPSHOT_KEY));
  } catch {
    // IndexedDB が使えない環境では残っているものも無い
  }
}

/**
 * iOSアプリが閉じている間に取っておいたセンサーの値（#735・`ios/Kurashio/BackgroundRefresh.swift`）。
 * 形は `GET /api/device/sensors` の1件と同じ
 */
export interface BackgroundSensorReading {
  deviceId: number;
  measuredAt: string | null;
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
}

/**
 * 前回のデータへ、アプリが閉じている間に取った値を重ねる（#735）。
 *
 * **測った時刻（`measuredAt`）が前回の値より新しいセンサーだけ**を置き換え、届いた項目（室温・湿度・CO2）
 * だけを差し替える。前回のデータに無いセンサーは足さない（どのセンサーを出すかはダッシュボードの設定が正）。
 * 何も変わらなければ同じオブジェクトを返す
 */
export function overlayBackgroundSensors(
  latestByDevice: Record<number, LatestData | null>,
  readings: readonly BackgroundSensorReading[]
): Record<number, LatestData | null> {
  let next: Record<number, LatestData | null> | null = null;
  for (const reading of readings) {
    if (!(reading.deviceId in latestByDevice)) continue;
    const current = latestByDevice[reading.deviceId];
    const readingMs = parseDataTimestamp(reading.measuredAt);
    if (readingMs == null) continue;
    const currentMs = parseDataTimestamp(current?.datetime);
    if (currentMs != null && readingMs <= currentMs) continue;

    next ??= { ...latestByDevice };
    next[reading.deviceId] = {
      ...current,
      datetime: reading.measuredAt ?? undefined,
      ...(reading.temperature != null ? { temperature: reading.temperature } : {}),
      ...(reading.humidity != null ? { humidity: reading.humidity } : {}),
      ...(reading.co2 != null ? { co2: reading.co2 } : {}),
    };
  }
  return next ?? latestByDevice;
}

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
