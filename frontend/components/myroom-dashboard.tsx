"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Box, ChevronRight, LineChart, RefreshCw } from "lucide-react";
import { WeatherIcon } from "@/lib/weather-icon";
import { AppSettingsSheet } from "@/components/app-settings-sheet";
import { NotificationSettingsSheet } from "@/components/notification-settings-sheet";
import { LifeSettingsSheet } from "@/components/life-settings-sheet";
import { RemoteButtonSettingsSheet } from "@/components/remote-button-settings-sheet";
import { SettingsIconButton } from "@/components/ui/settings-icon-button";
import { AppLoadingScreen } from "@/components/app-loading-screen";
import { LoginScreen } from "@/components/login-screen";
import { METRIC_ICONS } from "@/components/current-readings";
import { TrendPanel } from "@/components/trend-panel";
import { BillCard } from "@/components/bill-card";
import { CleaningCard } from "@/components/cleaning-card";
import { PrinterCard } from "@/components/printer-card";
import { FilamentSheet } from "@/components/filament-sheet";
import {
  CleaningDetailPanel,
  CleaningSettingsPanel,
} from "@/components/cleaning-detail-panel";
import { ComingSoonCard } from "@/components/coming-soon-card";
import { GarbageCard } from "@/components/garbage-card";
import { NativeWidgetSnapshotSync } from "@/components/native-widget-snapshot-sync";
import { PowerCard } from "@/components/power-card";
import { RemoteCard, type RemoteAirconEntry } from "@/components/remote-card";
import { BillDetailPanel } from "@/components/bill-detail-panel";
import { PowerDetailPanel } from "@/components/power-detail-panel";
import { OutdoorDetailPanel } from "@/components/outdoor-detail-panel";
import { VersionHistoryDialog } from "@/components/version-history-dialog";
import { AirconControlPanel } from "@/components/aircon-control-panel";
import { AirconDetailPanel } from "@/components/aircon-detail-panel";
import {
  deleteCleaningDone,
  fetchBillsSummary,
  fetchBambuPrinter,
  fetchCleaningSchedule,
  fetchDashboardData,
  fetchDevices,
  fetchEnergyBreakdown,
  fetchFilament,
  fetchGarbageSchedule,
  fetchOutdoorLocations,
  fetchOutdoorLocationsWeather,
  fetchAirconUnitsResponse,
  fetchRemoteButtons,
  fetchSensorsStatus,
  markCleaningDone,
  saveRemoteConfig,
  updateCleaningTasks,
} from "@/lib/api";
import {
  buildDashboardOfflineSnapshot,
  getLatestDataTimestamp,
  isOffline,
  loadDashboardOfflineSnapshot,
  saveDashboardOfflineSnapshot,
  type DashboardOfflineSnapshot,
} from "@/lib/offline-cache";
import { useChartHistory } from "@/lib/use-chart-history";
import { useElementHeight } from "@/lib/use-element-height";
import {
  buildAirconReadings,
  buildIndoorReadings,
  buildOutdoorLocationReadings,
  formatReading,
  pickCardReadings,
  buildCo2CardRow,
  type MetricReading,
} from "@/lib/device-metrics";
import {
  DISPLAY_ORDER_CHANGED_EVENT,
  buildDefaultDisplayOrder,
  normalizeDisplayOrder,
  orderItemKey,
  outdoorOrderKey,
  type DisplayOrderItem,
  type OutdoorOrderContext,
} from "@/lib/display-order";
import {
  buildDefaultChartColors,
  CHART_COLORS_CHANGED_EVENT,
  getDeviceChartColor,
  type ChartColorSettings,
} from "@/lib/chart-colors";
import {
  buildDefaultChartLineVisibility,
  loadChartLineVisibility,
  saveChartLineVisibility,
  type ChartLineVisibilitySettings,
} from "@/lib/chart-line-visibility";
import {
  filterDisplayOrderByVisibility,
  getVisibleChartDeviceIds,
  getVisibleSensorDeviceIds,
  isAirconRoomVisible,
  isAirconTargetVisible,
  isHiddenKeyVisible,
  setHiddenKeyVisible,
  applyHiddenDevicesToLineVisibility,
  VISIBLE_DEVICES_CHANGED_EVENT,
} from "@/lib/visible-devices";
import {
  COMING_SOON_CARDS,
  BILL_CARD_KEY,
  CLEANING_CARD_KEY,
  COMING_SOON_SECTION_KEY,
  DASHBOARD_SECTION_LABELS,
  ENERGY_CARD_KEY,
  GARBAGE_CARD_KEY,
  REMOTE_CARD_KEY,
  PRINTER_CARD_KEY,
} from "@/lib/dashboard-sections";
import type { BambuPrinterResponse } from "@/lib/bambu";
import type { FilamentPayload } from "@/lib/filament";
import type {
  CleaningSchedule,
  CleaningTask,
  CleaningTaskInput,
} from "@/lib/cleaning";
import { buildGarbageHighlight, type GarbageSchedule } from "@/lib/garbage";
import type { WidgetSnapshot } from "@/lib/native-app";
import { buildWidgetAircons } from "@/lib/widget-aircon";
import { buildWidgetRemoteButtons } from "@/lib/widget-remote-buttons";
import { buildWidgetSensors, pickDefaultWidgetSensor } from "@/lib/widget-sensors";
import { buildWidgetEnergy } from "@/lib/widget-energy";
import {
  countRemoteButtons,
  countVisibleRemoteButtons,
  type RemoteButtons,
  type RemoteConfigUpdate,
} from "@/lib/remote";
import {
  buildDefaultLifeCardOrder,
  getOrderedLifeCards,
} from "@/lib/life-card-order";
import { STALE_ALERT_EXCLUDED_CHANGED_EVENT } from "@/components/device-visibility-page";
import { LightStatusBadge } from "@/components/light-status-badge";
import { getLightThreshold, resolveDeviceLightStatus } from "@/lib/light-status";
import {
  loadUiSettingsFromServer,
  getDefaultUiSettings,
  saveHiddenDevicesToServer,
  saveLifeCardOrderToServer,
} from "@/lib/ui-settings-client";
import {
  applyDailyStatsInheritance,
  getLocationName,
  isPredecessorDevice,
} from "@/lib/device-inheritance";
import { AuthError, signOutThisApp } from "@/lib/auth";
import { initializeNativeNotifications } from "@/lib/native-notifications";
import { resolveAuthGate, useAuthState } from "@/lib/use-auth";
import { APP_VERSION } from "@/lib/app-version";
import { formatUpdatedAt } from "@/lib/format-updated-at";
import {
  AIRCON_CHART_DEVICE_ID,
  buildAirconStatusPill,
  getSensorDeviceIds,
  formatOutdoorApiLabel,
  outdoorLocationWeatherFromLatest,
  pickOutdoorLatestSource,
  PRIMARY_SENSOR_DEVICE_ID,
  resolveAirconDataLoadStatus,
  resolveLatestDataLoadStatus,
  resolveOutdoorLocationLoadStatus,
  type AirconControlState,
  type AirconData,
  type AirconUnitInfo,
  type ChartMetric,
  type ChartViewRange,
  type DailyStat,
  type DeviceDataLoadStatus,
  type DeviceInfo,
  type EnergyBreakdown,
  type LatestData,
  type OutdoorLocationEntry,
  type OutdoorLocationWeather,
  type SensorDeviceStatus,
  type UtilityBillSummary,
} from "@/lib/types";

const DeviceDetailPanel = dynamic(
  () =>
    import("@/components/device-detail-panel").then((module) => module.DeviceDetailPanel),
  { ssr: false }
);

interface DeviceCardProps {
  title: string;
  readings: readonly MetricReading[];
  metricsState: MetricsDisplayState;
  accentColor?: string;
  action?: React.ReactNode;
  onClick?: () => void;
  statusNote?: string;
  /** 計測値の下に出す状態の表示（エアコンの運転状態など） */
  badge?: React.ReactNode;
  /** 見出しの左に出すアイコン（屋外など、アクセント色を持たないカード用） */
  titleIcon?: React.ReactNode;
  /** 計測値の下に足すCO2の行。測れないセンサーでは渡さない */
  co2?: ReturnType<typeof buildCo2CardRow>;
}

type MetricsDisplayState = "loading" | "error" | "empty" | "ready";

function resolveMetricsDisplayState(
  readings: readonly MetricReading[],
  loadStatus: DeviceDataLoadStatus | undefined,
  dashboardDataLoaded: boolean
): MetricsDisplayState {
  if (readings.length > 0) return "ready";
  if (!dashboardDataLoaded) return "loading";
  if (loadStatus === "error") return "error";
  return "empty";
}

function metricsStateMessage(state: MetricsDisplayState): string {
  switch (state) {
    case "loading":
      return "読み込み中...";
    case "error":
      return "データを読み込めませんでした";
    case "empty":
      return "データがありません";
    default:
      return "";
  }
}

function buildLoadStatusFromLatest(
  latestByDevice: Record<number, LatestData | null>,
  deviceIds: readonly number[]
): Record<number, DeviceDataLoadStatus> {
  const status: Record<number, DeviceDataLoadStatus> = {};
  for (const deviceId of deviceIds) {
    status[deviceId] = resolveLatestDataLoadStatus(latestByDevice[deviceId], false);
  }
  return status;
}

/**
 * 「いまの環境」のカード。
 *
 * 計測値は先頭2つだけを出す（`pickCardReadings`）。1つ目を大きく、2つ目を右へ添えて
 * 高さを1行に収める。気圧・CO2・照度は詳細パネルの「いまの値」が受け持つ（#226）。
 */
function DeviceCard({
  title,
  readings,
  metricsState,
  accentColor,
  action,
  onClick,
  statusNote,
  badge,
  titleIcon,
  co2,
}: DeviceCardProps) {
  const className = onClick
    ? "device-card-compact cursor-pointer text-left transition-transform active:scale-[0.98]"
    : "device-card-compact text-left";
  const cardStyle = accentColor
    ? ({ borderLeft: `4px solid ${accentColor}` } satisfies CSSProperties)
    : undefined;
  const [primary, ...secondary] = readings;
  const content = (
    <>
      <div className="mb-1 flex items-start justify-between gap-2">
        <p
          className="device-card-compact-title flex min-w-0 flex-1 items-center gap-1.5"
          style={accentColor ? { color: accentColor } : undefined}
        >
          {titleIcon}
          <span className="min-w-0 truncate">{title}</span>
        </p>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      {statusNote && (
        <p className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          {statusNote}
        </p>
      )}
      {metricsState === "ready" ? (
        <div className="flex flex-col gap-1">
          {primary && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="device-card-compact-value">
                {primary.text}
                <span className="device-card-compact-unit">
                  {primary.unit === "°C" || primary.unit === "%"
                    ? primary.unit
                    : ` ${primary.unit}`}
                </span>
              </span>
              {secondary.map((reading) => {
                const Icon = METRIC_ICONS[reading.metric];
                return (
                  <span key={reading.metric} className="device-card-compact-sub">
                    <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
                    {formatReading(reading)}
                  </span>
                );
              })}
            </div>
          )}
          {co2 && (
            <p className="device-card-compact-co2">
              CO2
              <b>{co2.text}</b>
              {co2.unit}
              <span className={`device-card-compact-co2-pill is-${co2.level}`}>
                {co2.label}
              </span>
            </p>
          )}
          {badge}
        </div>
      ) : (
        <p
          className={`text-sm ${
            metricsState === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }`}
        >
          {metricsStateMessage(metricsState)}
        </p>
      )}
    </>
  );

  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        className={className}
        style={cardStyle}
      >
        {content}
      </div>
    );
  }

  return (
    <div className={className} style={cardStyle}>
      {content}
    </div>
  );
}

export function MyRoomDashboard() {
  const { isAuthenticated, setIsAuthenticated } = useAuthState();
  // ヘッダーを fixed にしたので、同じ高さの余白を本文の前に置く（#513）
  const [headerBarRef, headerBarHeight] = useElementHeight<HTMLDivElement>();
  const [latestByDevice, setLatestByDevice] = useState<Record<number, LatestData | null>>(
    {}
  );
  const [dailyStatsByDevice, setDailyStatsByDevice] = useState<
    Record<number, DailyStat[]>
  >({});
  const [refreshing, setRefreshing] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("temperature");
  const [viewRange, setViewRange] = useState<ChartViewRange>("day");
  const [dailyLimit, setDailyLimit] = useState(7);
  // 屋外の地点は複数登録できる（#308）。#321でカードも地点ごとに1枚並べる
  const [outdoorLocations, setOutdoorLocations] = useState<OutdoorLocationEntry[]>([]);
  const [outdoorWeatherById, setOutdoorWeatherById] = useState<
    Record<string, OutdoorLocationWeather>
  >({});
  const [outdoorWeatherFailed, setOutdoorWeatherFailed] = useState(false);
  const [outdoorPanelOpen, setOutdoorPanelOpen] = useState(false);
  /** 押した屋外カードの地点。詳細パネルはこの地点を選んだ状態で開く（#321） */
  const [outdoorPanelLocationId, setOutdoorPanelLocationId] = useState<string | null>(null);
  const [trendPanelOpen, setTrendPanelOpen] = useState(false);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [devicePanelId, setDevicePanelId] = useState(PRIMARY_SENSOR_DEVICE_ID);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [sensorStatuses, setSensorStatuses] = useState<SensorDeviceStatus[]>([]);
  const [garbageSchedule, setGarbageSchedule] = useState<GarbageSchedule | null>(null);
  const [garbageError, setGarbageError] = useState(false);
  const [cleaningSchedule, setCleaningSchedule] = useState<CleaningSchedule | null>(null);
  const [cleaningError, setCleaningError] = useState(false);
  const [cleaningTaskId, setCleaningTaskId] = useState<string | null>(null);
  const [cleaningSettingsOpen, setCleaningSettingsOpen] = useState(false);
  const [cleaningBusyId, setCleaningBusyId] = useState<string | null>(null);
  const [cleaningSaving, setCleaningSaving] = useState(false);
  const [cleaningSaveError, setCleaningSaveError] = useState<string | null>(null);
  const [bambuPrinter, setBambuPrinter] = useState<BambuPrinterResponse | null>(null);
  const [bambuError, setBambuError] = useState(false);
  // フィラメント在庫（#445）。プリンターの接続とは別に取り、取れなかったときは欄を出さない
  const [filament, setFilament] = useState<FilamentPayload | null>(null);
  const [filamentOpen, setFilamentOpen] = useState(false);
  const [remoteButtons, setRemoteButtons] = useState<RemoteButtons | null>(null);
  const [remoteError, setRemoteError] = useState(false);
  const [energyBreakdown, setEnergyBreakdown] = useState<EnergyBreakdown | null>(null);
  const [energyError, setEnergyError] = useState(false);
  const [energyPanelOpen, setEnergyPanelOpen] = useState(false);
  const [billSummary, setBillSummary] = useState<UtilityBillSummary | null>(null);
  const [billError, setBillError] = useState(false);
  const [billPanelOpen, setBillPanelOpen] = useState(false);
  const [staleAlertDismissed, setStaleAlertDismissed] = useState(false);
  const [staleAlertExcludedKeys, setStaleAlertExcludedKeys] = useState<Set<string>>(() => new Set());
  const [displayOrder, setDisplayOrder] = useState<DisplayOrderItem[]>(() =>
    buildDefaultDisplayOrder()
  );
  const [hiddenDeviceKeys, setHiddenDeviceKeys] = useState<Set<string>>(() => new Set());
  // 「暮らし」のカードを並べる順（#283）。見出しの設定アイコンから変える
  const [lifeCardOrder, setLifeCardOrder] = useState<string[]>(() =>
    buildDefaultLifeCardOrder()
  );
  const [lifeSettingsOpen, setLifeSettingsOpen] = useState(false);
  const [remoteSheetOpen, setRemoteSheetOpen] = useState(false);
  const [chartColors, setChartColors] = useState<ChartColorSettings>(() =>
    buildDefaultChartColors()
  );
  const [defaultLineVisibility, setDefaultLineVisibility] =
    useState<ChartLineVisibilitySettings>(() => buildDefaultChartLineVisibility());
  // デバイスID -> 照明の点灯とみなす照度（lx）。設定したデバイスだけがバッジを持つ（#258）
  const [lightThresholds, setLightThresholds] = useState<Record<string, number>>({});

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [airconLatest, setAirconLatest] = useState<AirconData | null>(null);
  const [airconUnits, setAirconUnits] = useState<AirconUnitInfo[]>([]);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [offlineSnapshot, setOfflineSnapshot] = useState<DashboardOfflineSnapshot | null>(
    null
  );
  const [layoutReady, setLayoutReady] = useState(false);
  const [dashboardDataLoaded, setDashboardDataLoaded] = useState(false);
  const [latestLoadStatusByDevice, setLatestLoadStatusByDevice] = useState<
    Record<number, DeviceDataLoadStatus>
  >({});
  const [airconLoadStatus, setAirconLoadStatus] = useState<DeviceDataLoadStatus>("empty");
  // 白くまくんのログイン情報がバックエンドに無ければ操作パネルを出さない（#213）
  const [airconControlEnabled, setAirconControlEnabled] = useState(false);
  const [airconControlOpen, setAirconControlOpen] = useState(false);
  const [airconDetailOpen, setAirconDetailOpen] = useState(false);

  const activeAirconId = airconLatest?.ac_id ?? 1;
  const airconChartTitle =
    airconLatest?.name ??
    airconUnits.find((unit) => unit.ac_id === activeAirconId)?.name ??
    "エアコン";

  const sensorDeviceIds = useMemo(() => getSensorDeviceIds(devices), [devices]);

  const primaryOutdoorLocation = useMemo(
    () => outdoorLocations.find((loc) => loc.is_primary) ?? outdoorLocations[0] ?? null,
    [outdoorLocations]
  );

  // 並び順・非表示のキーを地点ごとに引くための材料（#321）
  const outdoorOrderContext = useMemo<OutdoorOrderContext>(
    () => ({
      locationIds: outdoorLocations.map((loc) => loc.id),
      primaryId: primaryOutdoorLocation?.id ?? null,
    }),
    [outdoorLocations, primaryOutdoorLocation]
  );

  const effectiveLineVisibility = useMemo(
    () =>
      applyHiddenDevicesToLineVisibility(
        defaultLineVisibility,
        hiddenDeviceKeys,
        sensorDeviceIds,
        outdoorOrderKey(primaryOutdoorLocation?.id)
      ),
    [defaultLineVisibility, hiddenDeviceKeys, sensorDeviceIds, primaryOutdoorLocation]
  );

  const visibleSensorDeviceIds = useMemo(
    () => getVisibleSensorDeviceIds(sensorDeviceIds, hiddenDeviceKeys),
    [sensorDeviceIds, hiddenDeviceKeys]
  );

  const chartDeviceIds = useMemo(
    () => getVisibleChartDeviceIds(sensorDeviceIds, hiddenDeviceKeys),
    [sensorDeviceIds, hiddenDeviceKeys]
  );

  // 地点を足した直後は保存済みの並びにその地点が無い。設定を取り直さずに済むよう、
  // ここで毎回いまの地点一覧に照らして整える（#321）
  const normalizedDisplayOrder = useMemo(
    () => normalizeDisplayOrder(displayOrder, sensorDeviceIds, outdoorOrderContext),
    [displayOrder, sensorDeviceIds, outdoorOrderContext]
  );

  const visibleDisplayOrder = useMemo(
    () => filterDisplayOrderByVisibility(normalizedDisplayOrder, hiddenDeviceKeys),
    [normalizedDisplayOrder, hiddenDeviceKeys]
  );

  // 暮らしのカードは設定した順に並べ、隠したものだけを落とす（#283）
  const visibleLifeCards = useMemo(
    () =>
      getOrderedLifeCards(lifeCardOrder).filter((card) =>
        isHiddenKeyVisible(hiddenDeviceKeys, card.key)
      ),
    [lifeCardOrder, hiddenDeviceKeys]
  );

  // 「電気の操作」の行に出す説明。何件出ているかが分かると、編集を開く前に判断できる
  const remoteButtonSummary = useMemo(() => {
    const total = countRemoteButtons(remoteButtons);
    if (total === 0) return "操作するボタンが未設定です";
    return `ボタン${countVisibleRemoteButtons(remoteButtons)}件を表示中（全${total}件）`;
  }, [remoteButtons]);

  // 開いている項目は id で覚える。実施を記録すると一覧が作り直されるため、
  // オブジェクトを持つと古い「次にやる日」がシートに残る
  const activeCleaningTask =
    cleaningSchedule?.tasks.find((task) => task.id === cleaningTaskId) ?? null;
  const comingSoonVisible = isHiddenKeyVisible(hiddenDeviceKeys, COMING_SOON_SECTION_KEY);

  const {
    historyData,
    historyLoading,
    awaitingLatest,
    loadingRange,
    historyEpoch,
    noMoreOlderData,
    resetAndLoad,
    refreshLatest,
    ensureVisibleRangeLoaded,
  } = useChartHistory(visibleSensorDeviceIds, viewRange, {
    airconAcId: activeAirconId,
    airconChartDeviceId: AIRCON_CHART_DEVICE_ID,
    devices,
    pollIntervalMs: 30000,
    offlineMode: isOfflineMode,
    offlineHistory: offlineSnapshot?.historyData ?? null,
    offlineCacheKey: offlineSnapshot?.cachedAt ?? null,
  });

  const applyOfflineSnapshot = useCallback((snapshot: DashboardOfflineSnapshot) => {
    const sensorIds = getSensorDeviceIds(snapshot.devices);
    setLatestByDevice(snapshot.latestByDevice);
    setDailyStatsByDevice(snapshot.dailyStatsByDevice);
    setAirconLatest(snapshot.airconLatest);
    setDevices(snapshot.devices);
    setAirconUnits(snapshot.airconUnits);
    setOutdoorLocations(snapshot.outdoorLocations ?? []);
    setOutdoorWeatherById(
      Object.fromEntries(
        (snapshot.outdoorWeathers ?? []).map((weather) => [weather.id, weather])
      )
    );
    setOutdoorWeatherFailed(false);
    setLatestLoadStatusByDevice(
      buildLoadStatusFromLatest(snapshot.latestByDevice, sensorIds)
    );
    setAirconLoadStatus(resolveAirconDataLoadStatus(snapshot.airconLatest, false));
    setDashboardDataLoaded(true);
    setLayoutReady(true);
    setOfflineSnapshot(snapshot);
    setIsOfflineMode(true);
  }, []);

  const deviceNames = useMemo(() => {
    const names: Record<number, string> = {};
    for (const deviceId of sensorDeviceIds) {
      const device = devices.find((item) => item.id === deviceId);
      names[deviceId] =
        device?.name ??
        (deviceId === 1 ? "リビング" : deviceId === 2 ? "寝室" : `デバイス ${deviceId}`);
    }
    names[AIRCON_CHART_DEVICE_ID] = airconChartTitle;
    return names;
  }, [devices, sensorDeviceIds, airconChartTitle]);

  const reloadUiSettings = useCallback(async () => {
    try {
      const settings = await loadUiSettingsFromServer(sensorDeviceIds, outdoorOrderContext);
      setDisplayOrder(settings.displayOrder);
      setLifeCardOrder(settings.lifeCardOrder);
      setChartColors(settings.chartColors);
      setHiddenDeviceKeys(settings.hiddenDeviceKeys);
      setStaleAlertExcludedKeys(settings.staleAlertExcludedKeys);
      setLightThresholds(settings.lightThresholds);
    } catch (err) {
      if (err instanceof AuthError) {
        setIsAuthenticated(false);
      }
    }
  }, [sensorDeviceIds, outdoorOrderContext, setIsAuthenticated]);

  const handleLifeCardOrderChange = useCallback(
    (order: string[]) => {
      setLifeCardOrder(order);
      void saveLifeCardOrderToServer(order).catch((err) => {
        if (err instanceof AuthError) setIsAuthenticated(false);
      });
    },
    [setIsAuthenticated]
  );

  const handleLifeCardVisibilityChange = useCallback(
    (key: string, visible: boolean) => {
      const next = setHiddenKeyVisible(hiddenDeviceKeys, key, visible);
      setHiddenDeviceKeys(next);
      void saveHiddenDevicesToServer(next).catch((err) => {
        if (err instanceof AuthError) setIsAuthenticated(false);
      });
    },
    [hiddenDeviceKeys, setIsAuthenticated]
  );

  /**
   * 「電気の操作」に並べるボタンの登録内容を保存する（#262）。
   * シートは保存の結果を見て閉じるため、失敗はシート側へ返す。
   */
  const handleRemoteConfigSave = useCallback(
    async (update: RemoteConfigUpdate) => {
      try {
        setRemoteButtons(await saveRemoteConfig(update));
      } catch (err) {
        if (err instanceof AuthError) setIsAuthenticated(false);
        throw err;
      }
    },
    [setIsAuthenticated]
  );

  useEffect(() => {
    if (!isAuthenticated) {
      setLayoutReady(false);
      setDashboardDataLoaded(false);
      return;
    }

    let cancelled = false;

    async function bootstrap() {
      try {
        const [deviceList, airconUnitsResponse, outdoorList] = await Promise.all([
          fetchDevices().catch(() => [] as DeviceInfo[]),
          fetchAirconUnitsResponse().catch(() => ({
            units: [] as AirconUnitInfo[],
            control_enabled: false,
          })),
          fetchOutdoorLocations().catch(() => [] as OutdoorLocationEntry[]),
        ]);
        if (cancelled) return;

        const sensorIds = getSensorDeviceIds(deviceList);
        // 並び順・非表示のキーは地点ごとなので、地点の一覧が揃ってから設定を読む（#321）
        const outdoorContext: OutdoorOrderContext = {
          locationIds: outdoorList.map((loc) => loc.id),
          primaryId:
            (outdoorList.find((loc) => loc.is_primary) ?? outdoorList[0])?.id ?? null,
        };
        let settings;
        try {
          settings = await loadUiSettingsFromServer(sensorIds, outdoorContext);
        } catch (err) {
          if (err instanceof AuthError) {
            setIsAuthenticated(false);
            return;
          }
          settings = getDefaultUiSettings(sensorIds, outdoorContext);
        }
        if (cancelled) return;

        setDevices(deviceList);
        setAirconUnits(airconUnitsResponse.units);
        setAirconControlEnabled(airconUnitsResponse.control_enabled);
        setOutdoorLocations(outdoorList);
        setDisplayOrder(settings.displayOrder);
        setLifeCardOrder(settings.lifeCardOrder);
        setChartColors(settings.chartColors);
        setHiddenDeviceKeys(settings.hiddenDeviceKeys);
        setStaleAlertExcludedKeys(settings.staleAlertExcludedKeys);
        setLightThresholds(settings.lightThresholds);
        setDefaultLineVisibility(loadChartLineVisibility(sensorIds));
        setLayoutReady(true);
      } catch {
        if (!cancelled) setLayoutReady(true);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, setIsAuthenticated]);

  useEffect(() => {
    const reloadVisibility = () => {
      void reloadUiSettings();
    };
    const reloadChartColors = () => {
      void reloadUiSettings();
    };

    window.addEventListener(VISIBLE_DEVICES_CHANGED_EVENT, reloadVisibility);
    window.addEventListener(CHART_COLORS_CHANGED_EVENT, reloadChartColors);
    window.addEventListener(DISPLAY_ORDER_CHANGED_EVENT, reloadVisibility);
    window.addEventListener(STALE_ALERT_EXCLUDED_CHANGED_EVENT, reloadVisibility);
    return () => {
      window.removeEventListener(VISIBLE_DEVICES_CHANGED_EVENT, reloadVisibility);
      window.removeEventListener(CHART_COLORS_CHANGED_EVENT, reloadChartColors);
      window.removeEventListener(DISPLAY_ORDER_CHANGED_EVENT, reloadVisibility);
      window.removeEventListener(STALE_ALERT_EXCLUDED_CHANGED_EVENT, reloadVisibility);
    };
  }, [reloadUiSettings]);

  /**
   * 日別の集計を取り直す。単価を変えたとき（金額はサーバー側で掛けている）と、
   * KEPCOのCSVを取り込んだとき（日別の「その他」が変わる・#319）に呼ぶ。
   */
  const refreshEnergyBreakdown = useCallback(async () => {
    try {
      const breakdown = await fetchEnergyBreakdown();
      setEnergyBreakdown(breakdown);
      setEnergyError(false);
    } catch {
      setEnergyError(true);
    }
  }, []);

  /**
   * 掃除をやった記録を足す。応答が次の予定まで含んだ一覧なので、
   * 取り直さずにそのまま置き換える。
   *
   * `date` は掃除した日。カードの「やった」ボタンは渡さず、サーバーの今日になる。
   * 詳細シートからは選んだ日が渡る（当日に押し忘れたぶんを後から入れられる・#294）。
   */
  const handleMarkCleaningDone = useCallback(async (task: CleaningTask, date?: string) => {
    setCleaningBusyId(task.id);
    try {
      setCleaningSchedule(await markCleaningDone(task.id, date));
      setCleaningError(false);
    } catch (err) {
      if (err instanceof AuthError) {
        setIsAuthenticated(false);
        return;
      }
      setCleaningError(true);
    } finally {
      setCleaningBusyId(null);
    }
  }, [setIsAuthenticated]);

  /** 掃除の記録を1件取り消す。日付を間違えて登録したときの直し方（#294） */
  const handleDeleteCleaningDone = useCallback(async (task: CleaningTask, date: string) => {
    setCleaningBusyId(task.id);
    try {
      setCleaningSchedule(await deleteCleaningDone(task.id, date));
      setCleaningError(false);
    } catch (err) {
      if (err instanceof AuthError) {
        setIsAuthenticated(false);
        return;
      }
      setCleaningError(true);
    } finally {
      setCleaningBusyId(null);
    }
  }, [setIsAuthenticated]);

  const handleSaveCleaningTasks = useCallback(async (tasks: CleaningTaskInput[]) => {
    setCleaningSaving(true);
    setCleaningSaveError(null);
    try {
      setCleaningSchedule(await updateCleaningTasks(tasks));
      setCleaningError(false);
      setCleaningSettingsOpen(false);
    } catch (err) {
      if (err instanceof AuthError) {
        setIsAuthenticated(false);
        return;
      }
      setCleaningSaveError(
        err instanceof Error ? err.message : "保存できませんでした"
      );
    } finally {
      setCleaningSaving(false);
    }
  }, [setIsAuthenticated]);

  const fetchData = useCallback(
    async (options?: { showChartLoading?: boolean; reloadHistory?: boolean }) => {
      const showChartLoading = options?.showChartLoading ?? false;
      const reloadHistory = options?.reloadHistory ?? false;
      setRefreshing(true);
      if (showChartLoading) setChartLoading(true);
      try {
        if (isOffline()) {
          const snapshot = await loadDashboardOfflineSnapshot();
          if (snapshot) {
            applyOfflineSnapshot(snapshot);
            return;
          }
        }

        const [
          data,
          sensorsStatus,
          garbage,
          energy,
          remote,
          bills,
          cleaning,
          bambu,
          filamentData,
          outdoorList,
          outdoorWeathers,
        ] = await Promise.all([
          fetchDashboardData(airconLatest?.ac_id ?? 1, visibleSensorDeviceIds, devices),
          fetchSensorsStatus().catch(() => null),
          fetchGarbageSchedule().catch(() => null),
          fetchEnergyBreakdown().catch(() => null),
          fetchRemoteButtons().catch(() => null),
          fetchBillsSummary().catch(() => null),
          fetchCleaningSchedule().catch(() => null),
          fetchBambuPrinter().catch(() => null),
          fetchFilament().catch(() => null),
          fetchOutdoorLocations().catch(() => null),
          fetchOutdoorLocationsWeather().catch(() => null),
        ]);
        setIsOfflineMode(false);
        setOfflineSnapshot(null);
        setLatestByDevice(data.latestByDevice);
        setDailyStatsByDevice(data.dailyStatsByDevice);
        setAirconLatest(data.airconLatest);
        setLatestLoadStatusByDevice(data.latestLoadStatusByDevice);
        setAirconLoadStatus(data.airconLoadStatus);
        if (sensorsStatus) {
          setSensorStatuses(sensorsStatus.devices);
          setStaleAlertDismissed(false);
        }
        // 取得できなかったときは直前の内容を残したまま、エラー表示だけを出す
        if (garbage) setGarbageSchedule(garbage);
        setGarbageError(garbage == null);
        if (energy) setEnergyBreakdown(energy);
        setEnergyError(energy == null);
        if (remote) setRemoteButtons(remote);
        setRemoteError(remote == null);
        if (bills) setBillSummary(bills);
        setBillError(bills == null);
        if (cleaning) setCleaningSchedule(cleaning);
        setCleaningError(cleaning == null);
        if (bambu) setBambuPrinter(bambu);
        setBambuError(bambu == null);
        if (filamentData) setFilament(filamentData);
        // 地点そのものは `/devices` からしか変わらないので、取れなかったときは前回を残す
        if (outdoorList) setOutdoorLocations(outdoorList);
        if (outdoorWeathers) {
          setOutdoorWeatherById(
            Object.fromEntries(outdoorWeathers.map((weather) => [weather.id, weather]))
          );
        }
        setOutdoorWeatherFailed(outdoorWeathers == null);
        if (reloadHistory) {
          await resetAndLoad();
        }
      } catch (err) {
        if (err instanceof AuthError) {
          setIsAuthenticated(false);
          return;
        }
        console.error(err);
        const snapshot = await loadDashboardOfflineSnapshot();
        if (snapshot) {
          applyOfflineSnapshot(snapshot);
        } else {
          setLatestLoadStatusByDevice((prev) => {
            const next = { ...prev };
            for (const deviceId of visibleSensorDeviceIds) {
              next[deviceId] = "error";
            }
            return next;
          });
          setAirconLoadStatus("error");
        }
      } finally {
        setDashboardDataLoaded(true);
        setRefreshing(false);
        if (showChartLoading) setChartLoading(false);
      }
    },
    [
      resetAndLoad,
      airconLatest?.ac_id,
      visibleSensorDeviceIds,
      devices,
      applyOfflineSnapshot,
      setIsAuthenticated,
    ]
  );

  useEffect(() => {
    if (!isAuthenticated || isOfflineMode || isOffline()) return;
    if (!historyData.length || Object.keys(latestByDevice).length === 0) return;

    const snapshot = buildDashboardOfflineSnapshot({
      sensorDeviceIds,
      airconAcId: activeAirconId,
      latestByDevice,
      dailyStatsByDevice,
      airconLatest,
      historyData,
      devices,
      airconUnits,
      outdoorLocation: primaryOutdoorLocation,
      outdoorLocations,
      outdoorWeathers: Object.values(outdoorWeatherById),
    });

    if (!snapshot) return;
    void saveDashboardOfflineSnapshot(snapshot);
  }, [
    isAuthenticated,
    isOfflineMode,
    sensorDeviceIds,
    activeAirconId,
    latestByDevice,
    dailyStatsByDevice,
    airconLatest,
    historyData,
    devices,
    airconUnits,
    primaryOutdoorLocation,
    outdoorLocations,
    outdoorWeatherById,
  ]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleOnline = () => {
      setIsOfflineMode(false);
      setOfflineSnapshot(null);
      void fetchData({ showChartLoading: true });
      void refreshLatest();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [isAuthenticated, fetchData, refreshLatest]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchData({ showChartLoading: true });
        void refreshLatest();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isAuthenticated, fetchData, refreshLatest]);

  useEffect(() => {
    if (!isAuthenticated || !layoutReady) return;
    fetchData();
    const interval = setInterval(() => fetchData(), 30000);
    return () => clearInterval(interval);
  }, [isAuthenticated, layoutReady, fetchData]);

  useEffect(() => {
    // iOSアプリ（#526）でのAPNs通知（#527）。ログイン後、この画面が開いているあいだ
    // 端末のトークンをバックエンドの登録と同期し続ける（通知設定シートを開いていなくてもよい）
    if (!isAuthenticated) return;
    return initializeNativeNotifications();
  }, [isAuthenticated]);

  const handleLogout = () => {
    setIsAuthenticated(false);
    void signOutThisApp();
  };

  const mergedDailyStatsByDevice = useMemo(
    () => applyDailyStatsInheritance(dailyStatsByDevice, sensorDeviceIds, devices),
    [dailyStatsByDevice, sensorDeviceIds, devices]
  );

  const maxDailyStatsDays = useMemo(() => {
    const dates = new Set<string>();
    for (const deviceId of [...sensorDeviceIds, AIRCON_CHART_DEVICE_ID]) {
      for (const day of mergedDailyStatsByDevice[deviceId] ?? []) {
        dates.add(String(day.date).slice(0, 10));
      }
    }
    return dates.size;
  }, [mergedDailyStatsByDevice, sensorDeviceIds]);

  const dailyStatsDeviceIds = useMemo(() => {
    const ids: number[] = [];
    for (const item of visibleDisplayOrder) {
      if (item.type === "device" && !isPredecessorDevice(item.deviceId, devices)) {
        ids.push(item.deviceId);
      } else if (
        item.type === "aircon" &&
        isAirconRoomVisible(hiddenDeviceKeys) &&
        (mergedDailyStatsByDevice[AIRCON_CHART_DEVICE_ID]?.length ?? 0) > 0
      ) {
        ids.push(AIRCON_CHART_DEVICE_ID);
      }
    }
    return ids;
  }, [visibleDisplayOrder, mergedDailyStatsByDevice, devices, hiddenDeviceKeys]);

  /**
   * 操作パネルでの送信が成功したとき、カードの表示も合わせる。
   *
   * **DBへ入るのはラズパイの取り込み待ち（5分ごと）。** それを待つと、操作した直後だけ
   * カードが古い状態を出し続けることになる。
   */
  const handleAirconControlApplied = useCallback((next: AirconControlState) => {
    setAirconLatest((prev) => ({
      ...(prev ?? {}),
      ac_id: next.ac_id,
      name: next.name ?? prev?.name,
      power: next.power,
      mode: next.mode,
      target_temperature: next.target_temperature ?? undefined,
      room_temperature: next.room_temperature ?? prev?.room_temperature,
      humidity: next.humidity ?? prev?.humidity,
      fan_speed: next.fan_speed,
      fan_swing: next.fan_swing,
    }));
    setAirconLoadStatus("ok");
  }, []);

  const handleChartLineVisibleChange = (key: string, visible: boolean) => {
    setDefaultLineVisibility((prev) => {
      const next = { ...prev, [key]: visible };
      saveChartLineVisibility(next);
      return next;
    });
  };

  const latestForDailyStats = useMemo(() => {
    const merged = { ...latestByDevice };
    if (airconLatest?.room_temperature != null) {
      merged[AIRCON_CHART_DEVICE_ID] = {
        device_id: AIRCON_CHART_DEVICE_ID,
        datetime: airconLatest.datetime,
        temperature: airconLatest.room_temperature,
      };
    }
    return merged;
  }, [latestByDevice, airconLatest]);

  const staleByDevice = useMemo(() => {
    const map = new Map<number, SensorDeviceStatus>();
    for (const status of sensorStatuses) {
      map.set(status.device_id, status);
    }
    return map;
  }, [sensorStatuses]);

  const monitoredStaleStatuses = useMemo(
    () => sensorStatuses.filter((s) => s.stale && !staleAlertExcludedKeys.has(`device:${s.device_id}`)),
    [sensorStatuses, staleAlertExcludedKeys]
  );

  const hasStaleSensors = monitoredStaleStatuses.length > 0;

  const staleDeviceNames = useMemo(
    () => monitoredStaleStatuses.map((s) => `${s.name}（ID:${s.device_id}）`),
    [monitoredStaleStatuses]
  );

  const formatStaleNote = (deviceId: number): string | undefined => {
    const status = staleByDevice.get(deviceId);
    if (!status?.stale) return undefined;
    if (!status.has_data) return "データ未受信";
    if (status.age_minutes != null) {
      return `約${Math.round(status.age_minutes)}分間データなし`;
    }
    return "データ未到達";
  };

  // iOSアプリのホーム画面ウィジェット（#537）へ渡す値。JWTは含めず、表示中の値だけを渡す
  const garbageHighlight = garbageSchedule ? buildGarbageHighlight(garbageSchedule) : null;
  // どのセンサーを出すかはウィジェットの「ウィジェットを編集」で選ぶ。選んでいないときは
  // 並び順で最初の受信中のセンサー（ID 1 固定だと、止めて隠したときに「—」になる。#560）
  const widgetSensors = useMemo(
    () =>
      buildWidgetSensors(
        visibleDisplayOrder,
        latestByDevice,
        (deviceId) =>
          devices.find((device) => device.id === deviceId)?.name ??
          deviceNames[deviceId] ??
          `デバイス ${deviceId}`,
        (deviceId) => staleByDevice.get(deviceId)?.stale ?? false
      ),
    [visibleDisplayOrder, latestByDevice, devices, deviceNames, staleByDevice]
  );
  const defaultWidgetSensor = pickDefaultWidgetSensor(widgetSensors);
  const garbageLabel = garbageHighlight
    ? garbageHighlight.day.categories.map((category) => category.name).join("・")
    : null;
  const garbageDaysUntil = garbageHighlight?.day.days_until ?? null;
  const { todayKwh, todayCostYen, yesterdayKwh, monthKwh, energyDate } = useMemo(
    () => buildWidgetEnergy(energyBreakdown),
    [energyBreakdown]
  );
  // **フックなので、下の認証ゲートの早期 return より前に置くこと**（後ろに置くと
  // ログイン判定の前後でフックの数が変わり、React #310 で画面ごと落ちる。#559）。
  // 無関係な再描画のたびにWidgetの再読み込み（WidgetKitの1日あたりの上限あり）が
  // 走らないよう、値の中身が変わったときだけ新しいオブジェクトを作る
  // （センサーの一覧は30秒ごとの取得で作り直されるため、同じ内容なら送らない判定は
  // `NativeWidgetSnapshotSync` が中身で行う）
  const widgetRemoteButtons = useMemo(() => buildWidgetRemoteButtons(remoteButtons), [remoteButtons]);
  const widgetAircons = useMemo(
    () => buildWidgetAircons(airconUnits, airconLatest, airconControlEnabled && !isOfflineMode),
    [airconUnits, airconLatest, airconControlEnabled, isOfflineMode]
  );
  const widgetSnapshot: WidgetSnapshot = useMemo(
    () => ({
      roomTemperature: defaultWidgetSensor?.temperature ?? null,
      roomHumidity: defaultWidgetSensor?.humidity ?? null,
      defaultSensorId: defaultWidgetSensor?.id ?? null,
      sensors: widgetSensors,
      garbageLabel,
      garbageDaysUntil,
      todayKwh,
      todayCostYen,
      yesterdayKwh,
      monthKwh,
      energyDate,
      remoteButtons: widgetRemoteButtons,
      aircons: widgetAircons,
    }),
    [
      defaultWidgetSensor,
      widgetSensors,
      garbageLabel,
      garbageDaysUntil,
      todayKwh,
      todayCostYen,
      yesterdayKwh,
      monthKwh,
      energyDate,
      widgetRemoteButtons,
      widgetAircons,
    ]
  );

  // ログイン状態が確定するまでと、確定後の初期読み込みが終わるまでは読み込み画面（#250）
  const authGate = resolveAuthGate(isAuthenticated, layoutReady);
  if (authGate === "loading") {
    return <AppLoadingScreen />;
  }
  if (authGate === "login") {
    return <LoginScreen />;
  }

  const getDeviceInfo = (deviceId: number): DeviceInfo =>
    devices.find((device) => device.id === deviceId) ?? {
      id: deviceId,
      name: deviceNames[deviceId] ?? `デバイス ${deviceId}`,
    };

  const outdoorLatest = pickOutdoorLatestSource(latestByDevice);
  /**
   * カードに出す地点ごとの天気（#321）。一括取得がまだ終わっていない・オフラインの
   * ときだけ、基準地点は `/api/latest` に混ざっている値で埋める。
   */
  const resolveOutdoorWeather = (
    location: OutdoorLocationEntry
  ): OutdoorLocationWeather | null =>
    outdoorWeatherById[location.id] ??
    (location.id === primaryOutdoorLocation?.id
      ? outdoorLocationWeatherFromLatest(location, outdoorLatest)
      : null);
  const airconTitle = airconChartTitle;
  /**
   * 「電気の操作」カードからも同じ操作パネルを開けるようにする（#268）。
   *
   * センサーのエアコンカードと同じ条件で出す。操作できないバックエンド
   * （ログイン情報が未設定）とオフラインでは入口ごと出さない。
   */
  const remoteAircon: RemoteAirconEntry | null =
    airconControlEnabled && !isOfflineMode
      ? {
          title: airconTitle,
          // 「ダッシュボードに表示（設定温度）」を切っているときは状態も出さない。
          // エアコンカードのバッジと同じ出し分けにする（#226）
          status: isAirconTargetVisible(hiddenDeviceKeys)
            ? buildAirconStatusPill(airconLatest)
            : null,
          onOpen: () => setAirconControlOpen(true),
        }
      : null;
  const lastUpdatedMs = getLatestDataTimestamp(latestByDevice, airconLatest);
  // ヘッダーでは当日ならば時刻だけにする。年から出すとアプリ名と同じ幅を取り、
  // どちらが主役か分からなくなっていた（#277）
  const lastUpdated = formatUpdatedAt(lastUpdatedMs);
  const offlineCachedAt = offlineSnapshot?.dataLatestAt
    ? new Date(offlineSnapshot.dataLatestAt).toLocaleString("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="w-full pb-10">
      <NativeWidgetSnapshotSync snapshot={widgetSnapshot} />
      {/*
        ヘッダーは「いつのデータか」と「アプリの操作」がまとまる場所（#277）。右の3つは
        左から データを取り直す・部屋のようす・アプリ全体の設定。フッターは設定シートへ畳んだ。
        フッターが無いので、ヘッダーの下に引く線が本文との区切りになる。

        1段へ詰めた（#457）。それまでは上余白32pt＋右側2段で約100ptあり、最初の画面の
        3割近くを取っていた。**帯は画面の端まで伸ばし、中身だけ本文と同じ最大幅**に揃える
        （PC・iPad は本文が中央に寄るので、帯まで寄せると端が切れて見える）。

        帯の色は本文の背景（`--background`）と同じにしてあり（`globals.css` の
        `--header-band`。#483）、ヘッダーだけ色が付いて見えないようにする。右の3つの
        アイコンも枠・白背景を外し、セクション見出しの設定アイコン（`tone="inline"`）と
        同じ枠なしの見た目に揃えている。

        左はブランド画像、右は「最終更新」と操作ボタン（#447）。ブランド画像は元の素材が
        PNGしか無いため、ロゴ文字を明るく塗り替えたダーク版を別に持ち、テーマで出し分ける
        （`scripts/generate-icons.mjs` が両方を書き出す）。最終更新は390px以上ならボタンの
        左横に置いて1段にし、それより狭い端末（375pt幅など）では横幅が足りないので
        ボタン列の下へ右寄せで回す。

        スクロールしても常に見える固定表示にする（#488）。**画面の上端（y=0）から始まる
        `position: fixed` の1枚にし、iOSの安全領域（ステータスバーの裏）も `padding-top` で
        ヘッダー自身が塗る**（#513）。iOS 26以降のPWAは、上端に接した不透明な固定ヘッダーが
        無いとステータスバーの下へ約40ptのぼかしを重ね、それがヘッダーの上半分まで届いて
        ロゴやアイコンがぼけていた。以前は安全領域の帯（`app/layout.tsx`・#478/#482）と
        ヘッダー（安全領域の下から始まる `sticky`）が別要素で、どちらも「上端に接した固定
        ヘッダー」にならなかった。fixed で流れから外れるぶん、直後に同じ高さの余白を置く
        （安全領域ぶんは layout.tsx の外側の `padding-top` がすでに取っている）。
        `z-[45]`は安全領域の帯と #482 の要素（どちらも z-40）より上、ボトムシート系モーダルの
        暗幕（z-50）より下。ダッシュボードでは上端の最前面をこのヘッダーにして、iOS が上端で
        拾う要素を確実にこれにする（帯の下に置くと、#478/#482 と同じ判定のままになり得る）。

        iOS 27ではこの固定ヘッダー自体があってもステータスバー下のぼかしが消えないため（#521）、
        `--pwa-header-safe-gap`（globals.css・PWA standalone限定）ぶんだけ中身の開始位置を
        安全領域よりさらに下げ、ロゴ・アイコンがぼかしの範囲に重ならないようにする。ヘッダーの
        `padding-top`にではなく、`useElementHeight`が実測しているこの内側の div の
        `padding-top` に足すことで、直後の余白（`headerBarHeight`）が自動で追従する
        （ヘッダー側に足すと、実測されない差分だけ本文の先頭が隠れる）。
      */}
      <header className="fixed inset-x-0 top-0 z-[45] border-b border-header-band-border bg-header-band pt-[env(safe-area-inset-top)]">
        <div
          ref={headerBarRef}
          className="mx-auto w-full max-w-[480px] px-5 pt-[calc(0.625rem+var(--pwa-header-safe-gap))] pb-2.5 md:max-w-none md:px-8 lg:max-w-[1280px]"
        >
          <div className="flex items-center justify-between gap-3 px-0.5">
            <h1 className="shrink-0">
              {/* 表示サイズ固定のローカル画像で、`output: "export"`では最適化も効かないため素の<img>で出す */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/kurashio-brand.png"
                alt="kurashio"
                width={469}
                height={144}
                className="h-9 w-auto dark:hidden sm:h-10"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/kurashio-brand-dark.png"
                alt="kurashio"
                width={469}
                height={144}
                className="hidden h-9 w-auto dark:block sm:h-10"
              />
            </h1>
            <div className="flex min-w-0 flex-col-reverse items-end gap-1 min-[390px]:flex-row min-[390px]:items-center min-[390px]:gap-3">
              <p className="whitespace-nowrap text-right text-[11px] leading-tight text-muted-foreground sm:text-[11.5px]">
                最終更新 {lastUpdated}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (isOfflineMode) return;
                    fetchData({ showChartLoading: true });
                    void refreshLatest();
                  }}
                  disabled={isOfflineMode}
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="データを更新"
                  title="データを更新"
                >
                  <RefreshCw
                    className={`size-[18px] ${refreshing ? "animate-spin" : ""}`}
                    strokeWidth={1.75}
                  />
                </button>
                {/*
                  部屋のようす（#399）。3Dは縦に大きく取りたいので、ダッシュボードの
                  カードにはせず独立した画面にしてある。設定の歯車と並ぶが、こちらは
                  設定ではなく別の見かたへの入口なので `SettingsIconButton` は使わない。
                */}
                <Link
                  href="/room"
                  aria-label="部屋のようす"
                  title="部屋のようす"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Box className="size-[18px]" strokeWidth={1.75} />
                </Link>
                <SettingsIconButton
                  label="設定"
                  tone="header"
                  onClick={() => setAppSettingsOpen(true)}
                />
              </div>
            </div>
          </div>
        </div>
      </header>
      {/*
        fixed のヘッダーと同じ高さ（安全領域と下線を除いた中身＋下線1px）。測れるまでは
        いちばん多い1段の高さ（py-2.5＋ロゴ h-9、sm 以上は h-10）で埋めておき、JS が
        走ったあとの本文の飛びを小さくする
      */}
      <div
        aria-hidden="true"
        className="h-[57px] sm:h-[61px]"
        style={headerBarHeight === null ? undefined : { height: headerBarHeight + 1 }}
      />

      {/* 帯の下は、これまでどおり本文の幅・余白（バナーもここから並ぶ） */}
      <div className="mx-auto w-full max-w-[480px] space-y-6 px-5 pt-5 md:max-w-none md:px-8 lg:max-w-[1280px]">
        {isOfflineMode && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
            オフライン表示中
            {offlineCachedAt ? `（${offlineCachedAt} 時点・直近24時間）` : "（直近24時間）"}
          </div>
        )}
        {hasStaleSensors && !isOfflineMode && !staleAlertDismissed && (
          <div className="relative rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 pr-10 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
            <p>
              センサーからのデータがしばらく届いていません（{staleDeviceNames.join("・")}）。通知設定からプッシュ通知を有効にできます。
            </p>
            <button
              onClick={() => setStaleAlertDismissed(true)}
              className="absolute right-2 top-2 rounded p-1 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
              aria-label="通知を閉じる"
            >
              ✕
            </button>
          </div>
        )}
        {/*
          上段に「いまの環境」、下段に暮らし。センサーの計測値を2つへ絞ってカードが
          低くなったため、いまの状態をひと目で見せる位置へ上げた（#226）。
          PCは上段を4列、下段を2列にして、左右の列の長さが極端に食い違わないようにする。
        */}
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
              <h2 className="section-title">{DASHBOARD_SECTION_LABELS.sensors}</h2>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setTrendPanelOpen(true)}
                  className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs font-bold text-foreground transition-colors hover:bg-accent"
                >
                  <LineChart className="size-4" strokeWidth={1.75} />
                  推移
                </button>
                <SettingsIconButton label="表示設定" href="/devices" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {visibleDisplayOrder.map((item) => {
                if (item.type === "device") {
                  const deviceId = item.deviceId;
                  const device = getDeviceInfo(deviceId);
                  const accentColor = getDeviceChartColor(chartColors, deviceId);
                  const indoorReadings = buildIndoorReadings(latestByDevice[deviceId]);
                  // 照度を送ってこないデバイス・しきい値が未設定のデバイスでは null に
                  // なり、カードはこれまでどおりバッジ無しで並ぶ（#258）。
                  // **データが届いていないデバイスでは出さない。** カードの計測値は最新の
                  // レコードを持ち続けるため、そのまま判定すると「約120分間データなし」の
                  // 注記の横に「照明 点灯」が並び、いまの状態として読めてしまう
                  const lightStatus = staleByDevice.get(deviceId)?.stale
                    ? null
                    : resolveDeviceLightStatus(
                        latestByDevice[deviceId],
                        lightThresholds,
                        deviceId
                      );
                  return (
                    <DeviceCard
                      key={`device-${deviceId}`}
                      title={device.name}
                      accentColor={accentColor}
                      action={
                        <ChevronRight
                          className="size-5 shrink-0 text-muted-foreground/60"
                          strokeWidth={1.75}
                        />
                      }
                      onClick={() => {
                        setDevicePanelId(deviceId);
                        setDevicePanelOpen(true);
                      }}
                      readings={pickCardReadings(indoorReadings)}
                      co2={buildCo2CardRow(
                        latestByDevice[deviceId],
                        pickCardReadings(indoorReadings)
                      )}
                      metricsState={resolveMetricsDisplayState(
                        indoorReadings,
                        latestLoadStatusByDevice[deviceId],
                        dashboardDataLoaded
                      )}
                      statusNote={formatStaleNote(deviceId)}
                      badge={
                        lightStatus ? <LightStatusBadge result={lightStatus} /> : undefined
                      }
                    />
                  );
                }

                // 屋外は登録した地点のぶんだけカードが並ぶ（#321）。
                // 地点を持たない項目は、まだ一覧を読めていない場面の基準地点1枚ぶん
                if (item.type === "outdoor") {
                  const locationId = item.locationId ?? primaryOutdoorLocation?.id ?? null;
                  const location =
                    outdoorLocations.find((loc) => loc.id === locationId) ??
                    primaryOutdoorLocation;
                  const outdoorWeather = location ? resolveOutdoorWeather(location) : null;
                  const outdoorReadings = buildOutdoorLocationReadings(outdoorWeather);
                  return (
                    <DeviceCard
                      key={orderItemKey(item)}
                      title={formatOutdoorApiLabel(location?.name)}
                      titleIcon={
                        <WeatherIcon
                          icon={outdoorWeather?.weather_icon}
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.75}
                        />
                      }
                      readings={pickCardReadings(outdoorReadings)}
                      metricsState={resolveMetricsDisplayState(
                        outdoorReadings,
                        resolveOutdoorLocationLoadStatus(
                          outdoorWeather,
                          outdoorWeatherFailed
                        ),
                        dashboardDataLoaded
                      )}
                      badge={
                        outdoorWeather?.weather_label ? (
                          <span className="inline-flex w-fit items-center rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-bold text-muted-foreground">
                            {outdoorWeather.weather_label}
                          </span>
                        ) : undefined
                      }
                      action={
                        <ChevronRight
                          className="size-5 shrink-0 text-muted-foreground/60"
                          strokeWidth={1.75}
                        />
                      }
                      onClick={() => {
                        setOutdoorPanelLocationId(location?.id ?? null);
                        setOutdoorPanelOpen(true);
                      }}
                    />
                  );
                }

                // 室温だけをカードに出す。運転モードと設定温度はバッジが持っており、
                // 計測値にも同じ文字列を並べると同じことを2回言うことになる（#226）
                const airconReadings = isAirconRoomVisible(hiddenDeviceKeys)
                  ? buildAirconReadings(airconLatest?.room_temperature)
                  : [];
                const airconPill = buildAirconStatusPill(airconLatest);
                // 運転モードと設定温度はバッジ1つが受け持つため、`/devices` の
                // 「ダッシュボードに表示（設定温度）」はバッジの出し分けで引き継ぐ（#226）
                const airconBadge = !isAirconTargetVisible(hiddenDeviceKeys)
                  ? null
                  : airconPill.color ? (
                      <span
                        className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold"
                        style={{
                          color: airconPill.color,
                          backgroundColor: `${airconPill.color}24`,
                        }}
                      >
                        <span className="size-1.5 rounded-full bg-current" aria-hidden />
                        {airconPill.label}
                      </span>
                    ) : airconLatest ? (
                      <span className="inline-flex w-fit items-center rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-bold text-muted-foreground">
                        {airconPill.label}
                      </span>
                    ) : null;
                const airconState = resolveMetricsDisplayState(
                  airconReadings,
                  airconLoadStatus,
                  dashboardDataLoaded
                );
                return (
                  <DeviceCard
                    key="aircon"
                    title={airconTitle}
                    accentColor={getDeviceChartColor(chartColors, AIRCON_CHART_DEVICE_ID)}
                    badge={airconBadge}
                    action={
                      <ChevronRight
                        className="size-5 shrink-0 text-muted-foreground/60"
                        strokeWidth={1.75}
                      />
                    }
                    onClick={() => setAirconDetailOpen(true)}
                    readings={airconReadings}
                    // 室温を非表示にしていても、運転状態のバッジが出ているなら
                    // 「データがありません」とは言わない
                    metricsState={
                      airconState !== "ready" && airconBadge != null
                        ? "ready"
                        : airconState
                    }
                  />
                );
              })}
            </div>
          </section>

          {/*
            カードを全部隠していても節ごと消さない（#283）。見出しと設定アイコンが
            残っていないと、隠したあとで戻す入口が画面から無くなる。
          */}
          <section>
            <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
              <h2 className="section-title">{DASHBOARD_SECTION_LABELS.life}</h2>
              <SettingsIconButton
                label="暮らしの設定"
                onClick={() => setLifeSettingsOpen(true)}
              />
            </div>
            {visibleLifeCards.length > 0 ? (
              <div className="flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start">
                {visibleLifeCards.map((card) => {
                  if (card.key === REMOTE_CARD_KEY) {
                    return (
                      <RemoteCard
                        key={card.key}
                        buttons={remoteButtons}
                        loading={!dashboardDataLoaded && remoteButtons == null}
                        error={remoteError && remoteButtons == null}
                        aircon={remoteAircon}
                      />
                    );
                  }
                  if (card.key === GARBAGE_CARD_KEY) {
                    return (
                      <GarbageCard
                        key={card.key}
                        schedule={garbageSchedule}
                        loading={!dashboardDataLoaded && garbageSchedule == null}
                        error={garbageError && garbageSchedule == null}
                      />
                    );
                  }
                  if (card.key === ENERGY_CARD_KEY) {
                    return (
                      <PowerCard
                        key={card.key}
                        breakdown={energyBreakdown}
                        loading={!dashboardDataLoaded && energyBreakdown == null}
                        error={energyError && energyBreakdown == null}
                        onOpenDetail={() => setEnergyPanelOpen(true)}
                      />
                    );
                  }
                  if (card.key === BILL_CARD_KEY) {
                    return (
                      <BillCard
                        key={card.key}
                        summary={billSummary}
                        loading={!dashboardDataLoaded && billSummary == null}
                        error={billError && billSummary == null}
                        onOpenDetail={() => setBillPanelOpen(true)}
                      />
                    );
                  }
                  if (card.key === CLEANING_CARD_KEY) {
                    return (
                      <CleaningCard
                        key={card.key}
                        schedule={cleaningSchedule}
                        loading={!dashboardDataLoaded && cleaningSchedule == null}
                        error={cleaningError && cleaningSchedule == null}
                        busyTaskId={cleaningBusyId}
                        onOpenTask={(task) => setCleaningTaskId(task.id)}
                        onOpenSettings={() => {
                          setCleaningSaveError(null);
                          setCleaningSettingsOpen(true);
                        }}
                        onMarkDone={(task) => {
                          void handleMarkCleaningDone(task);
                        }}
                      />
                    );
                  }
                  if (card.key === PRINTER_CARD_KEY) {
                    return (
                      <PrinterCard
                        key={card.key}
                        printer={bambuPrinter}
                        loading={!dashboardDataLoaded && bambuPrinter == null}
                        error={bambuError && bambuPrinter == null}
                        filament={filament}
                        onOpenFilament={() => setFilamentOpen(true)}
                        onAcknowledged={setBambuPrinter}
                      />
                    );
                  }
                  return null;
                })}
              </div>
            ) : (
              <p className="rounded-[18px] border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                表示するカードがありません。右の設定から戻せます。
              </p>
            )}
          </section>

          {comingSoonVisible && COMING_SOON_CARDS.length > 0 && (
            <section>
              <div className="mb-3 px-0.5">
                <h2 className="section-title text-muted-foreground">
                  {DASHBOARD_SECTION_LABELS.comingSoon}
                </h2>
              </div>
              <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:items-start">
                {COMING_SOON_CARDS.map((card) => (
                  <ComingSoonCard key={card.key} card={card} />
                ))}
              </div>
            </section>
          )}
        </div>

        {/*
          再読み込み・ログアウト・更新履歴はヘッダーの設定シートへ移した（#277）。
          末尾に残すのは、いま動いているのがどのビルドかを見分けるための一行だけ。
        */}
        <p className="pt-2 text-center text-[11.5px] text-muted-foreground/70">
          kurashio v{APP_VERSION}
        </p>
      </div>

      <LifeSettingsSheet
        open={lifeSettingsOpen}
        order={lifeCardOrder}
        hiddenKeys={hiddenDeviceKeys}
        remoteSummary={remoteButtonSummary}
        onClose={() => setLifeSettingsOpen(false)}
        onOrderChange={handleLifeCardOrderChange}
        onVisibilityChange={handleLifeCardVisibilityChange}
        onEditRemoteButtons={() => setRemoteSheetOpen(true)}
      />

      {/* 設定シートの上に重ねる。閉じると暮らしの設定へ戻る */}
      {remoteSheetOpen ? (
        <RemoteButtonSettingsSheet
          onClose={() => setRemoteSheetOpen(false)}
          buttons={remoteButtons}
          onSave={handleRemoteConfigSave}
        />
      ) : null}

      <AppSettingsSheet
        open={appSettingsOpen}
        onClose={() => setAppSettingsOpen(false)}
        onReload={() => window.location.reload()}
        onLogout={() => {
          setAppSettingsOpen(false);
          handleLogout();
        }}
        onOpenVersionHistory={() => {
          setAppSettingsOpen(false);
          setVersionHistoryOpen(true);
        }}
        onOpenNotificationSettings={() => {
          setAppSettingsOpen(false);
          setNotificationSettingsOpen(true);
        }}
      />

      {/* 設定シートの上に重ねる。閉じると設定へ戻る */}
      {notificationSettingsOpen ? (
        <NotificationSettingsSheet
          open={notificationSettingsOpen}
          onClose={() => setNotificationSettingsOpen(false)}
        />
      ) : null}

      <TrendPanel
        open={trendPanelOpen}
        onClose={() => setTrendPanelOpen(false)}
        historyData={historyData}
        chartDeviceIds={chartDeviceIds}
        deviceNames={deviceNames}
        chartMetric={chartMetric}
        onChartMetricChange={setChartMetric}
        viewRange={viewRange}
        onViewRangeChange={setViewRange}
        chartLoading={chartLoading}
        historyLoading={historyLoading || loadingRange}
        awaitingLatest={awaitingLatest}
        historyEpoch={historyEpoch}
        noMoreOlderData={noMoreOlderData}
        onVisibleDomainChange={ensureVisibleRangeLoaded}
        airconTargetDeviceId={AIRCON_CHART_DEVICE_ID}
        outdoorLocationName={primaryOutdoorLocation?.name}
        outdoorPrimaryLocationId={primaryOutdoorLocation?.id}
        legendOrder={visibleDisplayOrder}
        chartColors={chartColors}
        lineVisibility={effectiveLineVisibility}
        onLineVisibilityChange={handleChartLineVisibleChange}
        dailyStatsByDevice={mergedDailyStatsByDevice}
        dailyStatsDeviceIds={dailyStatsDeviceIds}
        latestByDevice={latestForDailyStats}
        dailyLimit={dailyLimit}
        onLoadMoreDailyStats={() =>
          setDailyLimit((prev) => Math.min(prev + 7, maxDailyStatsDays))
        }
      />

      <DeviceDetailPanel
        open={devicePanelOpen}
        deviceId={devicePanelId}
        locationName={getLocationName(devicePanelId, devices, deviceNames)}
        latest={latestByDevice[devicePanelId] ?? null}
        lightThreshold={getLightThreshold(lightThresholds, devicePanelId)}
        chartColors={chartColors}
        lineVisibility={effectiveLineVisibility}
        devices={devices}
        isOfflineMode={isOfflineMode}
        offlineHistory={offlineSnapshot?.historyData ?? null}
        offlineCacheKey={offlineSnapshot?.cachedAt ?? null}
        onLineVisibilityChange={handleChartLineVisibleChange}
        onClose={() => setDevicePanelOpen(false)}
        onChanged={() => fetchData({ reloadHistory: true })}
      />

      {outdoorPanelOpen && (
        <OutdoorDetailPanel
          open={outdoorPanelOpen}
          initialLocationId={outdoorPanelLocationId}
          locationName={
            outdoorLocations.find((loc) => loc.id === outdoorPanelLocationId)?.name ??
            primaryOutdoorLocation?.name
          }
          latest={outdoorLatest}
          chartColors={chartColors}
          lineVisibility={defaultLineVisibility}
          isOfflineMode={isOfflineMode}
          offlineHistory={offlineSnapshot?.historyData ?? null}
          offlineCacheKey={offlineSnapshot?.cachedAt ?? null}
          onLineVisibilityChange={handleChartLineVisibleChange}
          onClose={() => setOutdoorPanelOpen(false)}
        />
      )}

      {energyPanelOpen && (
        <PowerDetailPanel
          open={energyPanelOpen}
          breakdown={energyBreakdown}
          onClose={() => setEnergyPanelOpen(false)}
          onUnitPriceSaved={() => {
            void refreshEnergyBreakdown();
          }}
          onKepcoImported={() => {
            void refreshEnergyBreakdown();
          }}
          onSourceNamesSaved={() => {
            void refreshEnergyBreakdown();
          }}
        />
      )}

      {billPanelOpen && (
        <BillDetailPanel
          open={billPanelOpen}
          summary={billSummary}
          onClose={() => setBillPanelOpen(false)}
        />
      )}

      {activeCleaningTask && (
        <CleaningDetailPanel
          open={cleaningTaskId != null}
          task={activeCleaningTask}
          today={cleaningSchedule?.today ?? ""}
          busy={cleaningBusyId === activeCleaningTask.id}
          onClose={() => setCleaningTaskId(null)}
          onMarkDone={(task, date) => {
            void handleMarkCleaningDone(task, date);
          }}
          onDeleteDone={(task, date) => {
            void handleDeleteCleaningDone(task, date);
          }}
        />
      )}

      {cleaningSettingsOpen && (
        <CleaningSettingsPanel
          open={cleaningSettingsOpen}
          schedule={cleaningSchedule}
          saving={cleaningSaving}
          error={cleaningSaveError}
          onClose={() => setCleaningSettingsOpen(false)}
          onSave={(tasks) => {
            void handleSaveCleaningTasks(tasks);
          }}
        />
      )}

      {filamentOpen && filament && (
        <FilamentSheet
          payload={filament}
          suggestedNote={
            bambuPrinter?.printer?.state === "finished"
              ? (bambuPrinter.printer.job.name ?? null)
              : null
          }
          onChange={setFilament}
          onClose={() => setFilamentOpen(false)}
        />
      )}

      {airconDetailOpen && (
        <AirconDetailPanel
          open={airconDetailOpen}
          title={airconTitle}
          acId={activeAirconId}
          latest={airconLatest}
          controllable={airconControlEnabled && !isOfflineMode}
          chartColors={chartColors}
          lineVisibility={defaultLineVisibility}
          isOfflineMode={isOfflineMode}
          offlineHistory={offlineSnapshot?.historyData ?? null}
          offlineCacheKey={offlineSnapshot?.cachedAt ?? null}
          onLineVisibilityChange={handleChartLineVisibleChange}
          onClose={() => setAirconDetailOpen(false)}
          onOpenControl={() => {
            setAirconDetailOpen(false);
            setAirconControlOpen(true);
          }}
        />
      )}

      {airconControlOpen && (
        <AirconControlPanel
          acId={activeAirconId}
          title={airconTitle}
          onClose={() => setAirconControlOpen(false)}
          onApplied={handleAirconControlApplied}
        />
      )}

      <VersionHistoryDialog
        open={versionHistoryOpen}
        onClose={() => setVersionHistoryOpen(false)}
      />
    </div>
  );
}
