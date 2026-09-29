"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Trash2, X } from "lucide-react";
import { CurrentReadings } from "@/components/current-readings";
import { LightStatusStrip } from "@/components/light-status-badge";
import { LightHistorySection } from "@/components/light-history-section";
import { resolveLightStatus } from "@/lib/light-status";
import { formatLightSourceLabel, type LightHistory } from "@/lib/light-history";
import { EnvironmentChart } from "@/components/environment-chart";
import { Button } from "@/components/ui/button";
import {
  deleteSensorRecord,
  deleteSensorRecordsBulk,
  fetchLightHistory,
  fetchSensorRecords,
} from "@/lib/api";
import type { ChartColorSettings } from "@/lib/chart-colors";
import {
  buildDefaultChartLineVisibility,
  type ChartLineVisibilitySettings,
} from "@/lib/chart-line-visibility";
import type { DisplayOrderItem } from "@/lib/display-order";
import { getInheritanceChain } from "@/lib/device-inheritance";
import { buildIndoorReadings } from "@/lib/device-metrics";
import { getAvailableChartMetrics } from "@/lib/chart-utils";
import { useChartHistory } from "@/lib/use-chart-history";
import type {
  ChartMetric,
  ChartViewRange,
  DeviceInfo,
  HistoryPoint,
  LatestData,
  SensorRecord,
} from "@/lib/types";

type PanelView = "chart" | "records";

interface DeviceDetailPanelProps {
  open: boolean;
  deviceId: number;
  locationName: string;
  /** カードから外した気圧・CO2・照度を「いまの値」として出すための最新データ（#226） */
  latest?: LatestData | null;
  /** 照明の点灯とみなす照度（lx）。未設定なら判定そのものを行わない（#258） */
  lightThreshold?: number | null;
  chartColors: ChartColorSettings;
  lineVisibility?: ChartLineVisibilitySettings;
  devices: DeviceInfo[];
  isOfflineMode?: boolean;
  offlineHistory?: HistoryPoint[] | null;
  offlineCacheKey?: string | null;
  onClose: () => void;
  onChanged: () => void;
  onLineVisibilityChange?: (key: string, visible: boolean) => void;
}

function formatRecordDatetime(value: string): string {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCell(value: number | null | undefined, unit: string): string {
  if (value == null) return "--";
  if (unit === "hPa" || unit === "ppm") {
    return `${Math.round(value)}${unit === "ppm" ? " ppm" : " hPa"}`;
  }
  if (unit === "lx") {
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} lx`;
  }
  return `${value.toFixed(1)}${unit}`;
}

function getDeviceLabel(deviceId: number, devices: readonly DeviceInfo[]): string {
  const device = devices.find((item) => item.id === deviceId);
  return device?.name?.trim() || `デバイス ${deviceId}`;
}

export function DeviceDetailPanel({
  open,
  deviceId,
  locationName,
  latest = null,
  lightThreshold = null,
  chartColors,
  lineVisibility: lineVisibilityProp,
  devices,
  isOfflineMode = false,
  offlineHistory = null,
  offlineCacheKey = null,
  onClose,
  onChanged,
  onLineVisibilityChange,
}: DeviceDetailPanelProps) {
  const [view, setView] = useState<PanelView>("chart");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("temperature");
  const [viewRange, setViewRange] = useState<ChartViewRange>("day");
  const [recordsDeviceId, setRecordsDeviceId] = useState(deviceId);
  const [records, setRecords] = useState<SensorRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedDatetimes, setSelectedDatetimes] = useState<Set<string>>(
    () => new Set()
  );
  const [error, setError] = useState("");
  //`source: null`（照明を紐付けていない）と、取得前の null を同じ状態で持つ。
  // どちらでも帯・一覧を出さないので、区別する必要が無い
  const [lightHistory, setLightHistory] = useState<LightHistory | null>(null);
  // グラフが今見せている時間軸。帯と一覧の範囲をそろえるために覚える
  const [visibleDomain, setVisibleDomain] = useState<[number, number] | null>(null);

  const inheritanceChain = useMemo(
    () => getInheritanceChain(deviceId, devices),
    [deviceId, devices]
  );

  const deviceIds = useMemo(() => [deviceId] as const, [deviceId]);
  const chartDeviceNames = useMemo(
    () => ({ [deviceId]: locationName }),
    [deviceId, locationName]
  );
  const legendOrder = useMemo(
    (): DisplayOrderItem[] => [{ type: "device", deviceId }],
    [deviceId]
  );
  const lineVisibility = useMemo(
    () => lineVisibilityProp ?? buildDefaultChartLineVisibility([deviceId]),
    [lineVisibilityProp, deviceId]
  );

  // しきい値が未設定か、照度が届いていなければ null。「いまの値」の下には何も出ない（#258）
  const lightStatus = useMemo(
    () => resolveLightStatus(latest?.illuminance, lightThreshold),
    [latest?.illuminance, lightThreshold]
  );

  const {
    historyData,
    historyLoading,
    awaitingLatest,
    loadingRange,
    historyEpoch,
    noMoreOlderData,
    ensureVisibleRangeLoaded,
  } = useChartHistory(deviceIds, viewRange, {
    devices,
    offlineMode: isOfflineMode,
    offlineHistory,
    offlineCacheKey,
    pollIntervalMs: open && view === "chart" && !isOfflineMode ? 30000 : 0,
  });

  useEffect(() => {
    if (!open) return;
    setView("chart");
    setRecordsDeviceId(deviceId);
    setSelectedDatetimes(new Set());
    setError("");
    // 別の場所を開いたときに、前の場所の帯が残らないようにする
    setLightHistory(null);
    setVisibleDomain(null);
  }, [open, deviceId]);

  const loadPage = useCallback(
    async (targetDeviceId: number, offset: number, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError("");
      try {
        const data = await fetchSensorRecords(targetDeviceId, offset);
        setTotal(data.total);
        setRecords((prev) => (append ? [...prev, ...data.records] : data.records));
        if (!append) {
          setSelectedDatetimes(new Set());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
        if (!append) {
          setRecords([]);
          setTotal(0);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!open || view !== "records" || isOfflineMode) return;
    loadPage(recordsDeviceId, 0, false);
  }, [open, view, recordsDeviceId, loadPage, isOfflineMode]);

  //`useChartHistory` が読み込んだ範囲。照明の履歴も同じ窓で取らないと、グラフの端で
  // 帯だけが途切れる（#368）。ポーリングで末尾が伸びるたびに取り直すので、
  //「継続中」の長さもグラフと同じ間隔で更新される
  // タイルを押して指標を切り替える（#592）。押せる指標はグラフ自身の自動フォールバックと
  // 同じ関数で決める。履歴の取得前は空になるので、そのあいだはタイルを無効化しない
  const indoorReadings = useMemo(() => buildIndoorReadings(latest), [latest]);
  const availableMetrics = useMemo(
    () => getAvailableChartMetrics(historyData, deviceIds),
    [historyData, deviceIds]
  );
  // タブは既定で出さない（読み込み中に一瞬出て消えるとグラフが動く）。タイルが無い（＝読み値が空、
  // またはグラフに出せるのにタイルが無い指標がある）ときだけ、切り替える手段として残す
  const showMetricTabs =
    indoorReadings.length === 0 ||
    availableMetrics.some(
      (metric) => !indoorReadings.some((reading) => reading.metric === metric)
    );
  const historyStartMs = historyData.length ? historyData[0].datetimeObj : null;
  const historyEndMs = historyData.length
    ? historyData[historyData.length - 1].datetimeObj
    : null;

  useEffect(() => {
    if (!open || view !== "chart" || isOfflineMode) return;
    if (historyStartMs == null || historyEndMs == null) return;

    let cancelled = false;
    fetchLightHistory(new Date(historyStartMs), new Date(historyEndMs), deviceId)
      .then((data) => {
        if (!cancelled) setLightHistory(data);
      })
      .catch(() => {
        // 履歴が取れなくてもグラフは出す。帯と一覧が消えるだけに留める
        if (!cancelled) setLightHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, view, isOfflineMode, historyStartMs, historyEndMs, deviceId]);

  const handleVisibleDomainChange = useCallback(
    (visibleMin: number, visibleMax: number) => {
      setVisibleDomain([visibleMin, visibleMax]);
      ensureVisibleRangeLoaded(visibleMin, visibleMax);
    },
    [ensureVisibleRangeLoaded]
  );

  const lightSource = lightHistory?.source ?? null;

  const selectedCount = selectedDatetimes.size;
  const allLoadedSelected =
    records.length > 0 && records.every((record) => selectedDatetimes.has(record.datetime));
  const isDeleting = deletingKey !== null || bulkDeleting;

  const toggleSelected = (datetime: string) => {
    setSelectedDatetimes((prev) => {
      const next = new Set(prev);
      if (next.has(datetime)) {
        next.delete(datetime);
      } else {
        next.add(datetime);
      }
      return next;
    });
  };

  const toggleSelectAllLoaded = () => {
    if (allLoadedSelected) {
      setSelectedDatetimes(new Set());
      return;
    }
    setSelectedDatetimes(new Set(records.map((record) => record.datetime)));
  };

  const handleBulkDelete = async () => {
    const datetimes = Array.from(selectedDatetimes);
    if (datetimes.length === 0) return;
    if (!window.confirm(`選択した ${datetimes.length} 件の記録を削除しますか？`)) return;

    setBulkDeleting(true);
    setError("");
    try {
      const deletedCount = await deleteSensorRecordsBulk(recordsDeviceId, datetimes);
      const deletedSet = new Set(datetimes);
      setRecords((prev) => prev.filter((item) => !deletedSet.has(item.datetime)));
      setTotal((prev) => Math.max(0, prev - deletedCount));
      setSelectedDatetimes(new Set());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleDelete = async (record: SensorRecord) => {
    const label = formatRecordDatetime(record.datetime);
    if (!window.confirm(`${label} の記録を削除しますか？`)) return;

    setDeletingKey(record.datetime);
    setError("");
    try {
      await deleteSensorRecord(recordsDeviceId, record.datetime);
      setRecords((prev) => prev.filter((item) => item.datetime !== record.datetime));
      setTotal((prev) => Math.max(0, prev - 1));
      setSelectedDatetimes((prev) => {
        if (!prev.has(record.datetime)) return prev;
        const next = new Set(prev);
        next.delete(record.datetime);
        return next;
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeletingKey(null);
    }
  };

  if (!open) return null;

  const hasPressure = records.some((record) => record.pressure != null);
  const hasCo2 = records.some((record) => record.co2 != null);
  const hasIlluminance = records.some((record) => record.illuminance != null);
  const canLoadMore = records.length < total;
  const activeDeviceLabel = getDeviceLabel(deviceId, devices);

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex min-h-0 max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[88vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            {view === "records" ? (
              <button
                type="button"
                onClick={() => setView("chart")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent"
                aria-label="グラフに戻る"
              >
                <ArrowLeft className="size-5" />
              </button>
            ) : null}
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">{locationName}</h2>
              <p className="text-xs text-muted-foreground">
                {view === "chart"
                  ? `使用中: ${activeDeviceLabel} (ID: ${deviceId})`
                  : "記録一覧・外れ値の削除"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent"
            aria-label="閉じる"
          >
            <X className="size-5" />
          </button>
        </div>

        {inheritanceChain.length > 1 && view === "chart" ? (
          <div className="shrink-0 border-b px-5 py-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">デバイス履歴</p>
            <div className="flex flex-wrap items-center gap-1 text-xs text-foreground">
              {inheritanceChain.map((chainDeviceId, index) => {
                const label = getDeviceLabel(chainDeviceId, devices);
                const isActive = chainDeviceId === deviceId;
                return (
                  <span key={chainDeviceId} className="inline-flex items-center gap-1">
                    {index > 0 ? (
                      <span className="text-muted-foreground" aria-hidden="true">
                        →
                      </span>
                    ) : null}
                    <span
                      className={
                        isActive
                          ? "rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                          : "text-muted-foreground"
                      }
                    >
                      {label} (ID: {chainDeviceId})
                      {isActive ? " · 現在" : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          {view === "chart" ? (
            <>
            <CurrentReadings
              readings={indoorReadings}
              measuredAt={latest?.datetime}
              selectedMetric={chartMetric}
              onSelectMetric={setChartMetric}
              selectableMetrics={availableMetrics.length > 0 ? availableMetrics : undefined}
            />
            {lightStatus ? <LightStatusStrip result={lightStatus} /> : null}
            <div className="px-3 py-3">
              <EnvironmentChart
                historyData={historyData}
                deviceIds={deviceIds}
                deviceNames={chartDeviceNames}
                chartMetric={chartMetric}
                onChartMetricChange={setChartMetric}
                viewRange={viewRange}
                onViewRangeChange={setViewRange}
                loading={false}
                historyLoading={historyLoading || loadingRange}
                awaitingLatest={awaitingLatest}
                historyEpoch={historyEpoch}
                noMoreOlderData={noMoreOlderData}
                onVisibleDomainChange={handleVisibleDomainChange}
                legendOrder={legendOrder}
                chartColors={chartColors}
                lineVisibility={lineVisibility}
                onLineVisibilityChange={onLineVisibilityChange ?? (() => {})}
                pinMetricTabsOnMobile={false}
                hideMetricTabs={!showMetricTabs}
                lightSegments={lightSource ? lightHistory?.segments : undefined}
                lightSourceLabel={lightSource ? formatLightSourceLabel(lightSource) : undefined}
                lightThreshold={lightSource?.threshold ?? null}
              />
            </div>
            {lightHistory && lightSource ? (
              <LightHistorySection history={lightHistory} visibleDomain={visibleDomain} />
            ) : null}
            </>
          ) : loading ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              読み込み中...
            </p>
          ) : isOfflineMode ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              オフライン中は記録一覧を表示できません
            </p>
          ) : records.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              記録がありません
            </p>
          ) : (
            <div className="space-y-2 px-5 py-3">
              {records.map((record) => {
                const isSelected = selectedDatetimes.has(record.datetime);
                return (
                <div
                  key={record.datetime}
                  className={`rounded-xl border bg-background/60 px-3 py-2.5 ${
                    isSelected ? "border-primary/40 bg-primary/5" : ""
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelected(record.datetime)}
                        disabled={isDeleting}
                        className="size-4 shrink-0 rounded border-input accent-primary"
                        aria-label={`${formatRecordDatetime(record.datetime)} を選択`}
                      />
                      <p className="truncate text-sm font-semibold text-foreground">
                        {formatRecordDatetime(record.datetime)}
                      </p>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDelete(record)}
                      disabled={isDeleting}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                      aria-label="この記録を削除"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>温度: {formatCell(record.temperature, "°C")}</span>
                    <span>湿度: {formatCell(record.humidity, "%")}</span>
                    {hasPressure && (
                      <span>気圧: {formatCell(record.pressure, "hPa")}</span>
                    )}
                    {hasCo2 && <span>CO2: {formatCell(record.co2, "ppm")}</span>}
                    {hasIlluminance && (
                      <span>照度: {formatCell(record.illuminance, "lx")}</span>
                    )}
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t px-5 py-4">
          {error && (
            <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {view === "chart" ? (
            <Button
              className="h-10 w-full rounded-xl"
              onClick={() => setView("records")}
              disabled={isOfflineMode}
            >
              データを表示する
            </Button>
          ) : (
            <div className="space-y-3">
              {inheritanceChain.length > 1 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">表示デバイス</p>
                  <div className="flex flex-wrap gap-2">
                    {inheritanceChain.map((chainDeviceId) => {
                      const label = getDeviceLabel(chainDeviceId, devices);
                      const selected = chainDeviceId === recordsDeviceId;
                      return (
                        <button
                          key={chainDeviceId}
                          type="button"
                          onClick={() => setRecordsDeviceId(chainDeviceId)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            selected
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {label} (ID: {chainDeviceId})
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {selectedCount > 0 ? (
                <Button
                  variant="destructive"
                  className="h-10 w-full rounded-xl"
                  onClick={handleBulkDelete}
                  disabled={isDeleting}
                >
                  {bulkDeleting
                    ? "削除中..."
                    : `選択した ${selectedCount} 件を削除`}
                </Button>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={allLoadedSelected}
                      onChange={toggleSelectAllLoaded}
                      disabled={isDeleting || records.length === 0}
                      className="size-4 rounded border-input accent-primary"
                    />
                    表示中を全選択
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {total > 0 ? `${records.length} / ${total} 件` : "0 件"}
                    {selectedCount > 0 ? ` · ${selectedCount} 件選択` : ""}
                  </p>
                </div>
                {canLoadMore && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl"
                    onClick={() => loadPage(recordsDeviceId, records.length, true)}
                    disabled={loadingMore || isDeleting}
                  >
                    {loadingMore ? "読み込み中..." : "もっと見る"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
