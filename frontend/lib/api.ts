import type { LightHistory } from "@/lib/light-history";
import {
  AIRCON_CHART_DEVICE_ID,
  DASHBOARD_SENSOR_DEVICE_IDS,
  FALLBACK_SENSOR_DEVICE_IDS,
  PRIMARY_SENSOR_DEVICE_ID,
  hasAirconData,
  resolveAirconDataLoadStatus,
  resolveLatestDataLoadStatus,
  type AirconControlCommand,
  type AirconControlState,
  type AirconData,
  type AirconUnitInfo,
  type DailyStat,
  type DeviceDataLoadStatus,
  type DeviceInfo,
  type EnergyBreakdown,
  type EnergyHourly,
  type EnergyKepcoImportResult,
  type EnergySourceSummary,
  type HistoryPoint,
  type LatestData,
  type OutdoorLocation,
  type OutdoorLocationEntry,
  type OutdoorLocationSearchResult,
  type OutdoorLocationWeather,
  type SensorRecordsResponse,
  type SensorsStatusResponse,
  type PushVapidPublicKeyResponse,
  type PushSubscribeBody,
  type PushTestResult,
  type ApnsStatusResponse,
  type TimeRange,
  type ChartViewRange,
  type UiSettings,
  type UtilityBillSummary,
} from "@/lib/types";
import type { BambuPrinterResponse } from "@/lib/bambu";
import type { CleaningSchedule, CleaningTaskInput } from "@/lib/cleaning";
import type {
  FilamentPayload,
  FilamentSpoolInput,
  FilamentSpoolPatch,
} from "@/lib/filament";
import type { GarbageSchedule } from "@/lib/garbage";
import type { EnergyRefetch } from "@/lib/energy-refetch";
import type { TapoCandidates } from "@/lib/tapo-candidates";
import type {
  RemoteButtons,
  RemoteCatalog,
  RemoteConfigUpdate,
  RemoteSendResult,
} from "@/lib/remote";
import { processHistoryData, processAirconHistoryData } from "@/lib/chart-utils";
import { toApiDateTime, type AirconHistoryPoint } from "@/lib/history-loader";
import { expandDeviceIdsForHistory } from "@/lib/device-inheritance";
import { authHeaders, AuthError, signOutThisApp } from "@/lib/auth";

/**
 * バックエンドがこのセッションを受け付けなかった。403 を返すのは認証（`backend/auth.py` の
 * 許可リスト・Googleログインの判定）だけなので、401 と同じくこのアプリのセッションを破棄して
 * ログイン画面へ戻す（#724）。以前は 403 を素通しし、どのAPIも失敗する空のダッシュボードが残っていた。
 */
function isAuthRejected(status: number): boolean {
  return status === 401 || status === 403;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(await authHeaders()),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch";
    throw new TypeError(`${message} (${url})`);
  }
  if (isAuthRejected(res.status)) {
    await signOutThisApp();
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(await authHeaders()),
      ...(init?.headers ?? {}),
    },
  });
  if (isAuthRejected(res.status)) {
    await signOutThisApp();
    throw new AuthError();
  }
  return res;
}

export async function fetchUiSettings(): Promise<UiSettings> {
  return fetchJson<UiSettings>("/api/ui-settings");
}

export async function updateUiSettings(
  settings: Partial<UiSettings>
): Promise<UiSettings> {
  const res = await fetchWithAuth("/api/ui-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<UiSettings>;
}

export async function fetchPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
  return fetchJson<PushVapidPublicKeyResponse>("/api/push/vapid-public-key");
}

export async function subscribePushNotifications(
  subscription: PushSubscribeBody
): Promise<void> {
  const res = await fetchWithAuth("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
}

export async function unsubscribePushNotifications(endpoint: string): Promise<void> {
  const res = await fetchWithAuth("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
}

export async function sendTestPushNotification(): Promise<PushTestResult> {
  const res = await fetchWithAuth("/api/push/test", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<PushTestResult>;
}

export async function fetchApnsStatus(): Promise<ApnsStatusResponse> {
  return fetchJson<ApnsStatusResponse>("/api/apns/status");
}

// 端末のAPNsトークンの登録・解除は lib/native-notifications.ts が持つ（#527）。
// `lib/auth.ts`（signOutThisApp）から使う都合上、ここ（api.ts）とは循環参照になるため
// 独立した最小限のfetchを直接持たせている。

export async function sendTestApnsNotification(): Promise<PushTestResult> {
  const res = await fetchWithAuth("/api/apns/test", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<PushTestResult>;
}

export async function fetchLatest(deviceId = PRIMARY_SENSOR_DEVICE_ID): Promise<LatestData> {
  return fetchJson<LatestData>(`/api/latest?device=${deviceId}`);
}

export async function fetchAirconLatest(acId?: number): Promise<AirconData | null> {
  const url =
    acId != null ? `/api/aircon/latest?ac_id=${acId}` : "/api/aircon/latest";
  const data = await fetchJson<AirconData>(url);
  return hasAirconData(data) ? data : null;
}

export async function fetchHistory(
  timeRange: TimeRange,
  customStartDate: string,
  customEndDate: string,
  deviceId = PRIMARY_SENSOR_DEVICE_ID
): Promise<HistoryPoint[]> {
  let url = `/api/history?range=${timeRange}&device=${deviceId}`;
  if (timeRange === "custom") {
    url = `/api/history?start=${customStartDate}&end=${customEndDate}&device=${deviceId}`;
  }
  const data = await fetchJson<Record<string, unknown>[]>(url);
  return processHistoryData(data);
}

export async function fetchOutdoorHistoryWindow(
  start: Date,
  end: Date,
  viewRange: ChartViewRange,
  locationId?: string | null
): Promise<HistoryPoint[]> {
  const params = new URLSearchParams({
    start: toApiDateTime(start),
    end: toApiDateTime(end),
  });
  if (viewRange === "year") {
    params.set("range", "year");
  }
  if (locationId) {
    params.set("location_id", locationId);
  }
  const data = await fetchJson<Record<string, unknown>[]>(
    `/api/outdoor-history?${params.toString()}`
  );
  return processHistoryData(data);
}

export async function fetchHistoryWindow(
  start: Date,
  end: Date,
  viewRange: ChartViewRange,
  deviceId = PRIMARY_SENSOR_DEVICE_ID
): Promise<HistoryPoint[]> {
  const params = new URLSearchParams({
    start: toApiDateTime(start),
    end: toApiDateTime(end),
    device: String(deviceId),
  });
  if (viewRange === "year") {
    params.set("range", "year");
  }
  const data = await fetchJson<Record<string, unknown>[]>(
    `/api/history?${params.toString()}`
  );
  return processHistoryData(data);
}

/**
 * その場所の照明が点いていた時間帯（#368）。
 *
 * **窓の指定は `fetchHistoryWindow()` と同じにする。** 推移グラフと同じ時間軸へ帯を重ねるので、
 * 取得する期間もグラフと揃っていないと、端で帯だけが途切れる。
 */
export async function fetchLightHistory(
  start: Date,
  end: Date,
  deviceId = PRIMARY_SENSOR_DEVICE_ID
): Promise<LightHistory> {
  const params = new URLSearchParams({
    start: toApiDateTime(start),
    end: toApiDateTime(end),
    device: String(deviceId),
  });
  return fetchJson<LightHistory>(`/api/light-history?${params.toString()}`);
}

/** `/devices` の「この場所の照明」に並べる候補（Nature Remo に「照明」として登録した機器） */
export async function fetchLightSourceCandidates(): Promise<{
  candidates: { key: string; name: string }[];
  catalog_fetched_at: string;
}> {
  return fetchJson("/api/light-sources");
}

export async function fetchAirconHistoryWindow(
  start: Date,
  end: Date,
  viewRange: ChartViewRange,
  acId = 1
): Promise<AirconHistoryPoint[]> {
  const params = new URLSearchParams({
    start: toApiDateTime(start),
    end: toApiDateTime(end),
    ac_id: String(acId),
  });
  if (viewRange === "year") {
    params.set("range", "year");
  }
  const data = await fetchJson<Record<string, unknown>[]>(
    `/api/aircon/history?${params.toString()}`
  );
  return processAirconHistoryData(data);
}

export async function fetchDailyStats(
  deviceId = PRIMARY_SENSOR_DEVICE_ID
): Promise<DailyStat[]> {
  return fetchJson<DailyStat[]>(`/api/daily-stats?device=${deviceId}`);
}

export async function fetchDailyStatsBatch(
  deviceIds: readonly number[] = DASHBOARD_SENSOR_DEVICE_IDS
): Promise<Record<number, DailyStat[]>> {
  const results = await Promise.allSettled(
    deviceIds.map((deviceId) => fetchDailyStats(deviceId))
  );

  const dailyStatsByDevice: Record<number, DailyStat[]> = {};
  deviceIds.forEach((deviceId, index) => {
    const result = results[index];
    dailyStatsByDevice[deviceId] =
      result.status === "fulfilled" ? result.value : [];
  });
  return dailyStatsByDevice;
}

export async function fetchAirconDailyStats(acId = 1): Promise<DailyStat[]> {
  return fetchJson<DailyStat[]>(`/api/aircon/daily-stats?ac_id=${acId}`);
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const data = await fetchJson<{ devices: DeviceInfo[] }>("/api/devices");
  return data.devices;
}

export async function updateDeviceName(
  deviceId: number,
  name: string,
  inheritsFrom?: number | null
): Promise<DeviceInfo> {
  const body: { name: string; inherits_from?: number | null } = { name };
  if (inheritsFrom !== undefined) {
    body.inherits_from = inheritsFrom;
  }
  const res = await fetchWithAuth(`/api/devices/${deviceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<DeviceInfo>;
}

export interface AirconUnitsResponse {
  units: AirconUnitInfo[];
  /** 操作パネルを出してよいか。白くまくんのログイン情報が未設定なら false */
  control_enabled: boolean;
}

export async function fetchAirconUnitsResponse(): Promise<AirconUnitsResponse> {
  const data = await fetchJson<AirconUnitsResponse>("/api/aircon/units");
  return { units: data.units ?? [], control_enabled: data.control_enabled ?? false };
}

export async function fetchAirconUnits(): Promise<AirconUnitInfo[]> {
  return (await fetchAirconUnitsResponse()).units;
}

/** 操作パネル用の現在状態。DBの最新記録ではなくエアコンから直接読む */
export async function fetchAirconControlState(
  acId: number
): Promise<AirconControlState> {
  return airconControlRequest(`/api/aircon/units/${acId}/state`);
}

export async function sendAirconControl(
  acId: number,
  command: AirconControlCommand
): Promise<AirconControlState> {
  return airconControlRequest(`/api/aircon/units/${acId}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

/**
 * 操作APIの呼び出し。**バックエンドが返した理由をそのまま画面へ運ぶ。**
 * 「つながらない」「混み合っている」「設定されていない」を区別できないと、
 * 送ったのに効かないときに打つ手が分からなくなる。
 */
async function airconControlRequest(
  url: string,
  init?: RequestInit
): Promise<AirconControlState> {
  const res = await fetchWithAuth(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `エアコンを操作できませんでした（${res.status}）`);
  }
  return res.json() as Promise<AirconControlState>;
}

export async function updateAirconUnitName(
  acId: number,
  name: string
): Promise<AirconUnitInfo> {
  const res = await fetchWithAuth(`/api/aircon/units/${acId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<AirconUnitInfo>;
}

export async function fetchOutdoorLocation(): Promise<OutdoorLocation> {
  return fetchJson<OutdoorLocation>("/api/outdoor-location");
}

export async function updateOutdoorLocation(
  location: OutdoorLocation
): Promise<OutdoorLocation> {
  const res = await fetchWithAuth("/api/outdoor-location", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(location),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<OutdoorLocation>;
}

export async function searchOutdoorLocations(
  query: string
): Promise<OutdoorLocationSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const data = await fetchJson<{ results: OutdoorLocationSearchResult[] }>(
    `/api/outdoor-location/search?${params}`
  );
  return data.results;
}

interface OutdoorLocationInput {
  name: string;
  latitude: number;
  longitude: number;
}

async function outdoorLocationRequest(
  url: string,
  init: RequestInit
): Promise<OutdoorLocationEntry> {
  const res = await fetchWithAuth(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<OutdoorLocationEntry>;
}

/** 登録済みの屋外地点の一覧（#308） */
export async function fetchOutdoorLocations(): Promise<OutdoorLocationEntry[]> {
  const data = await fetchJson<{ locations: OutdoorLocationEntry[] }>(
    "/api/outdoor-locations"
  );
  return data.locations;
}

export async function createOutdoorLocation(
  input: OutdoorLocationInput
): Promise<OutdoorLocationEntry> {
  return outdoorLocationRequest("/api/outdoor-locations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateOutdoorLocationById(
  id: string,
  input: OutdoorLocationInput
): Promise<OutdoorLocationEntry> {
  return outdoorLocationRequest(`/api/outdoor-locations/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteOutdoorLocation(id: string): Promise<void> {
  const res = await fetchWithAuth(`/api/outdoor-locations/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
}

export async function setPrimaryOutdoorLocation(
  id: string
): Promise<OutdoorLocationEntry> {
  return outdoorLocationRequest(`/api/outdoor-locations/${id}/primary`, {
    method: "PUT",
  });
}

/** 指定した地点の「いまの天気」（#308） */
export async function fetchOutdoorLocationWeather(
  id: string
): Promise<OutdoorLocationWeather> {
  return fetchJson<OutdoorLocationWeather>(`/api/outdoor-locations/${id}/weather`);
}

/** 全地点の「いまの天気」。ダッシュボードは地点ごとにカードを出す（#321） */
export async function fetchOutdoorLocationsWeather(): Promise<OutdoorLocationWeather[]> {
  const data = await fetchJson<{ locations: OutdoorLocationWeather[] }>(
    "/api/outdoor-locations/weather"
  );
  return data.locations;
}

export async function fetchSensorRecords(
  deviceId: number,
  offset = 0,
  limit = 100
): Promise<SensorRecordsResponse> {
  const params = new URLSearchParams({
    device: String(deviceId),
    limit: String(limit),
    offset: String(offset),
  });
  return fetchJson<SensorRecordsResponse>(`/api/records?${params.toString()}`);
}

export async function deleteSensorRecord(
  deviceId: number,
  datetime: string
): Promise<void> {
  const params = new URLSearchParams({
    device: String(deviceId),
    datetime,
  });
  const res = await fetchWithAuth(`/api/records?${params.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
}

export async function deleteSensorRecordsBulk(
  deviceId: number,
  datetimes: string[]
): Promise<number> {
  const res = await fetchWithAuth("/api/records/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: deviceId, datetimes }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  const data = (await res.json()) as { deleted_count: number };
  return data.deleted_count;
}

export async function fetchSensorsStatus(): Promise<SensorsStatusResponse> {
  return fetchJson<SensorsStatusResponse>("/api/sensors/status");
}

/**
 * ログインしたことをバックエンドへ知らせる（Signaly のログイン通知の起点。#240）。
 *
 * Supabase Auth ではコールバックが Supabase 側でホストされるため、バックエンドには
 * 「ログインした瞬間」が通らない。認証コールバックの完了時にここから1回だけ叩く。
 * **通知はおまけなので、失敗してもログインは通す。**
 */
export async function notifyLogin(): Promise<void> {
  try {
    // fetchWithAuth を使わないのは、401 でサインアウトさせないため。
    // 通知はおまけなので、ここでの失敗がセッションに影響してはいけない。
    await fetch("/api/auth/login-notify", {
      method: "POST",
      headers: await authHeaders(),
    });
  } catch {
    // 通知先が未設定・到達不能でもログインを止めない
  }
}

export async function fetchGarbageSchedule(): Promise<GarbageSchedule> {
  return fetchJson<GarbageSchedule>("/api/garbage");
}

/** 取得元の名前シートの「Tapoの候補」（#692） */
export async function fetchTapoCandidates(): Promise<TapoCandidates> {
  return fetchJson<TapoCandidates>("/api/energy/tapo-candidates");
}

/** 「候補を更新」。探索はサブPCが次の定期実行で行うので、応答は待ち状態（`pending`）になる */
export async function refreshTapoCandidates(): Promise<TapoCandidates> {
  return fetchJson<TapoCandidates>("/api/energy/tapo-candidates/refresh", {
    method: "POST",
  });
}

/** 消費電力の再取得の進み具合（#711） */
export async function fetchEnergyRefetch(): Promise<EnergyRefetch> {
  return fetchJson<EnergyRefetch>("/api/energy/refetch");
}

/**
 * 「指定日以降を再取得」。取り直すのはサブPCの収集で、応答は待ち状態（`pending`）になる。
 * すでに依頼中（409）・日付が不正（422）のときは、サーバーの理由をそのまま投げる。
 */
export async function requestEnergyRefetch(since: string): Promise<EnergyRefetch> {
  const res = await fetchWithAuth("/api/energy/refetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ since }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // 本文が読めなければ既定の文言にする
    }
    throw new Error(detail || "再取得を依頼できませんでした");
  }
  return res.json() as Promise<EnergyRefetch>;
}

/**
 * 3Dプリンターカード用（#436）。現在値は `online` のときだけ `printer` に入り、
 * 収集停止・接続なしのときは `lastKnown` に分かれて返る。
 */
export async function fetchBambuPrinter(): Promise<BambuPrinterResponse> {
  return fetchJson<BambuPrinterResponse>("/api/bambu/printer");
}

/**
 * 「取り出した」操作（#464）。完了・停止のときだけ確認済みにし、応答に最新の状態が入る。
 * 新しい印刷が始まると、バックエンドが確認状態を自動でリセットする。
 */
export async function acknowledgeBambuPrinter(): Promise<BambuPrinterResponse> {
  const res = await fetchWithAuth("/api/bambu/printer/ack", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<BambuPrinterResponse>;
}

/** 掃除カード用。場所ごとの次にやる日まで計算済みで返る */
export async function fetchCleaningSchedule(): Promise<CleaningSchedule> {
  return fetchJson<CleaningSchedule>("/api/cleaning");
}

/**
 * 掃除の定義をまとめて置き換える（追加・編集・削除・並べ替えを1回で送る）。
 * 実施履歴は送らない。同じ id の項目からサーバー側が引き継ぐ。
 */
export async function updateCleaningTasks(
  tasks: CleaningTaskInput[]
): Promise<CleaningSchedule> {
  const res = await fetchWithAuth("/api/cleaning/tasks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<CleaningSchedule>;
}

/**
 * 掃除をやった記録を足す。次にやる日はこの日から数え直される。
 *
 * `date`（YYYY-MM-DD）は掃除した日で、省略するとサーバーの今日（JST）。
 * 当日に押し忘れたときのために過去の日を渡せる。未来の日はサーバーが400で弾く（#294）。
 */
export async function markCleaningDone(
  taskId: string,
  date?: string
): Promise<CleaningSchedule> {
  const res = await fetchWithAuth(
    `/api/cleaning/tasks/${encodeURIComponent(taskId)}/done`,
    date
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date }),
        }
      : { method: "POST" }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<CleaningSchedule>;
}

/** 掃除の記録を1件取り消す。日付を間違えて登録したときの直し方（#294） */
export async function deleteCleaningDone(
  taskId: string,
  date: string
): Promise<CleaningSchedule> {
  const res = await fetchWithAuth(
    `/api/cleaning/tasks/${encodeURIComponent(taskId)}/done/${encodeURIComponent(date)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<CleaningSchedule>;
}

/** フィラメント在庫。残量は計量と使用量からサーバーが計算して返す（#445） */
export async function fetchFilament(): Promise<FilamentPayload> {
  return fetchJson<FilamentPayload>("/api/filament");
}

/** 操作は応答に最新の一覧が入る。失敗の理由（detail）はそのまま画面へ出す */
async function sendFilament(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown
): Promise<FilamentPayload> {
  const res = await fetchWithAuth(
    url,
    body === undefined
      ? { method }
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(
      typeof error?.detail === "string" ? error.detail : `Request failed: ${res.status}`
    );
  }
  return res.json() as Promise<FilamentPayload>;
}

const spoolUrl = (spoolId: string) => `/api/filament/spools/${encodeURIComponent(spoolId)}`;

export function createFilamentSpool(input: FilamentSpoolInput): Promise<FilamentPayload> {
  return sendFilament("/api/filament/spools", "POST", input);
}

export function updateFilamentSpool(
  spoolId: string,
  patch: FilamentSpoolPatch
): Promise<FilamentPayload> {
  return sendFilament(spoolUrl(spoolId), "PUT", patch);
}

export function deleteFilamentSpool(spoolId: string): Promise<FilamentPayload> {
  return sendFilament(spoolUrl(spoolId), "DELETE");
}

/** いま使っているスプールを選ぶ。null で外す */
export function setActiveFilamentSpool(spoolId: string | null): Promise<FilamentPayload> {
  return sendFilament("/api/filament/active", "PUT", { spool_id: spoolId });
}

/** 秤で量った全体重量（スプール込み・g）を記録する。以後の残量はこの値が基準になる */
export function recordFilamentWeighing(
  spoolId: string,
  grossG: number,
  date: string
): Promise<FilamentPayload> {
  return sendFilament(`${spoolUrl(spoolId)}/weigh`, "POST", { gross_g: grossG, date });
}

export function deleteFilamentWeighing(
  spoolId: string,
  weighingId: string
): Promise<FilamentPayload> {
  return sendFilament(`${spoolUrl(spoolId)}/weigh/${encodeURIComponent(weighingId)}`, "DELETE");
}

/** 印刷で使った量（スライサーが出すg数）を記録する */
export function recordFilamentUsage(
  spoolId: string,
  grams: number,
  date: string,
  note: string
): Promise<FilamentPayload> {
  return sendFilament(`${spoolUrl(spoolId)}/usage`, "POST", { grams, date, note });
}

export function deleteFilamentUsage(
  spoolId: string,
  usageId: string
): Promise<FilamentPayload> {
  return sendFilament(`${spoolUrl(spoolId)}/usage/${encodeURIComponent(usageId)}`, "DELETE");
}

/** 電気の操作カード用。押せるボタンの一覧だけを取る（Nature Remo は叩かない） */
export async function fetchRemoteButtons(): Promise<RemoteButtons> {
  return fetchJson<RemoteButtons>("/api/remote/buttons");
}

/** ボタンを押す。失敗した理由はそのままカードに出すため、detail を Error に載せる */
export async function sendRemoteButton(buttonId: string): Promise<RemoteSendResult> {
  let res: Response;
  try {
    res = await fetchWithAuth(
      `/api/remote/buttons/${encodeURIComponent(buttonId)}/send`,
      { method: "POST" }
    );
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // ここへ来るのは fetch 自体が失敗したとき。文言はそのままカードに出る
    throw new Error("通信できませんでした（オフラインかもしれません）");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<RemoteSendResult>;
}

/**
 * 登録できる操作の一覧。**Nature Remo は叩かない**（最後に取った控えを返す）。
 *
 * 取り直すのは `refreshRemoteCatalog()` のときだけ。Cloud API の上限が
 * 30回/5分しかないので、シートを開くたびに問い合わせない（#262）。
 */
export async function fetchRemoteCatalog(): Promise<RemoteCatalog> {
  return fetchJson<RemoteCatalog>("/api/remote/catalog");
}

/** Nature Remo へ問い合わせて一覧を取り直す。理由をそのままシートに出すため detail を拾う */
export async function refreshRemoteCatalog(): Promise<RemoteCatalog> {
  let res: Response;
  try {
    res = await fetchWithAuth("/api/remote/catalog/refresh", { method: "POST" });
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new Error("通信できませんでした（オフラインかもしれません）");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<RemoteCatalog>;
}

/** 並べるボタンの登録内容と、付けた名前・隠す指定を1回で保存する（#262） */
export async function saveRemoteConfig(
  update: RemoteConfigUpdate
): Promise<RemoteButtons> {
  return fetchJson<RemoteButtons>("/api/remote/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

/** 消費電力カード用。エアコンとスマートプラグをまとめた集計を取る */
export async function fetchEnergyBreakdown(days = 30): Promise<EnergyBreakdown> {
  const params = new URLSearchParams({ days: String(days) });
  return fetchJson<EnergyBreakdown>(`/api/energy/breakdown?${params.toString()}`);
}

/** 消費電力カードの「時間ごと」表示用。指定した1日の時間帯別の内訳を取る */
export async function fetchEnergyHourly(date: string): Promise<EnergyHourly> {
  const params = new URLSearchParams({ date });
  return fetchJson<EnergyHourly>(`/api/energy/hourly?${params.toString()}`);
}

/** 消費電力の詳細パネルでデバイスをクリックしたときに、そのデバイス単体の推移を取る */
export async function fetchEnergySummary(
  source: string,
  days = 30
): Promise<EnergySourceSummary> {
  const params = new URLSearchParams({ source, days: String(days) });
  return fetchJson<EnergySourceSummary>(`/api/energy/summary?${params.toString()}`);
}

/** KEPCO「みるでん」の時間ごとCSVを取り込む。「その他」（#302）の元データになる */
export async function importKepcoCsv(file: File): Promise<EnergyKepcoImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetchWithAuth("/api/energy/kepco/import", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<EnergyKepcoImportResult>;
}

/** 電気・ガス料金カード用。はぴeみる電のメール由来の月次請求を取る */
export async function fetchBillsSummary(months = 12): Promise<UtilityBillSummary> {
  const params = new URLSearchParams({ months: String(months) });
  return fetchJson<UtilityBillSummary>(`/api/bills/summary?${params.toString()}`);
}

export interface LatestBatchResult {
  latestByDevice: Record<number, LatestData | null>;
  loadStatusByDevice: Record<number, DeviceDataLoadStatus>;
}

export async function fetchLatestBatch(
  deviceIds: readonly number[] = DASHBOARD_SENSOR_DEVICE_IDS
): Promise<LatestBatchResult> {
  const results = await Promise.allSettled(
    deviceIds.map((deviceId) => fetchLatest(deviceId))
  );

  const latestByDevice: Record<number, LatestData | null> = {};
  const loadStatusByDevice: Record<number, DeviceDataLoadStatus> = {};
  deviceIds.forEach((deviceId, index) => {
    const result = results[index];
    if (result.status === "fulfilled") {
      latestByDevice[deviceId] = result.value;
      loadStatusByDevice[deviceId] = resolveLatestDataLoadStatus(result.value, false);
    } else {
      latestByDevice[deviceId] = null;
      loadStatusByDevice[deviceId] = "error";
    }
  });
  return { latestByDevice, loadStatusByDevice };
}

export async function fetchDashboardData(
  acId = 1,
  sensorDeviceIds: readonly number[] = FALLBACK_SENSOR_DEVICE_IDS,
  devices: readonly DeviceInfo[] = []
) {
  const dailyStatsIds = expandDeviceIdsForHistory(sensorDeviceIds, devices);

  const [latestByDevice, dailyStatsByDevice, airconDailyStats, airconLatest] =
    await Promise.allSettled([
      fetchLatestBatch(sensorDeviceIds),
      fetchDailyStatsBatch(dailyStatsIds.length > 0 ? dailyStatsIds : sensorDeviceIds),
      fetchAirconDailyStats(acId),
      fetchAirconLatest(acId),
    ]);

  const mergedDailyStats =
    dailyStatsByDevice.status === "fulfilled" ? { ...dailyStatsByDevice.value } : {};
  if (airconDailyStats.status === "fulfilled" && airconDailyStats.value.length > 0) {
    mergedDailyStats[AIRCON_CHART_DEVICE_ID] = airconDailyStats.value;
  }

  const latestBatch =
    latestByDevice.status === "fulfilled"
      ? latestByDevice.value
      : {
          latestByDevice: {} as Record<number, LatestData | null>,
          loadStatusByDevice: Object.fromEntries(
            sensorDeviceIds.map((deviceId) => [deviceId, "error" as const])
          ),
        };

  const airconFetchFailed = airconLatest.status === "rejected";
  const airconValue = airconLatest.status === "fulfilled" ? airconLatest.value : null;

  return {
    latestByDevice: latestBatch.latestByDevice,
    latestLoadStatusByDevice: latestBatch.loadStatusByDevice,
    latest:
      latestByDevice.status === "fulfilled"
        ? latestBatch.latestByDevice[PRIMARY_SENSOR_DEVICE_ID] ?? null
        : null,
    dailyStatsByDevice: mergedDailyStats,
    airconLatest: airconValue,
    airconLoadStatus: resolveAirconDataLoadStatus(airconValue, airconFetchFailed),
    dashboardFetchFailed:
      latestByDevice.status === "rejected" &&
      airconLatest.status === "rejected",
  };
}
