"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { Droplets, Eye, EyeOff, Gauge, Sun, Thermometer, Wind } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AIRCON_CHART_DEVICE_ID,
  AIRCON_TARGET_CHART_KEY,
  ChartMetric,
  CHART_VIEW_RANGE_LABELS,
  ChartViewRange,
  deviceMetricKey,
  deviceMetricMinKey,
  deviceMetricMaxKey,
  deviceDht11TemperatureKey,
  deviceTargetMetricKey,
  formatAirconTargetTemperature,
  HistoryPoint,
  isAirconAutoTarget,
  METRIC_COLORS,
  METRIC_LABELS,
  METRIC_UNITS,
  formatOutdoorApiLabel,
} from "@/lib/types";
import {
  clampDomainOffset,
  computeChartDomain,
  type ChartDomain,
  computeDomainOffsetForSelectionTime,
  computeVisibleYDomain,
  buildAirconTargetChartSegments,
  buildDailyMinMaxHistory,
  type AirconTargetChartSegment,
  downsampleMultiDeviceHistoryForChart,
  filterHistoryForDomain,
  formatActivePointLabel,
  formatChartAxisDate,
  getAvailableChartMetrics,
  getChartTicksForDomain,
  getDeviceDht11TemperatureValueAtTime,
  getDeviceMetricMinMaxAtTime,
  getDeviceMetricValueAtTime,
  getDeviceTargetMetricStateAtTime,
  getDeviceTargetMetricValueAtTime,
  getDevicesWithDht11TemperatureData,
  getDevicesWithMetricData,
  getMaxPositiveDomainOffset,
  getOutdoorMetricValueAtTime,
  getSelectionTime,
  hasDeviceDht11TemperatureData,
  hasDeviceMetricData,
  hasDeviceTargetChartData,
  hasDeviceTargetStateData,
  hasOutdoorMetricData,
  isAirconOffAtTime,
  isAggregatedRange,
  withSelectionEndPoints,
} from "@/lib/chart-utils";
import {
  getAirconTargetChartColor,
  getDeviceChartColor,
  getOutdoorChartColor,
  type ChartColorSettings,
} from "@/lib/chart-colors";
import {
  AIRCON_TARGET_VISIBILITY_KEY,
  deviceDht11VisibilityKey,
  deviceMetricVisibilityKey,
  isChartLineVisible,
  outdoorMetricVisibilityKey,
  type ChartLineVisibilitySettings,
} from "@/lib/chart-line-visibility";
import { cn } from "@/lib/utils";
import { buildBandPieces, type LightSegment } from "@/lib/light-history";
import type { DisplayOrderItem } from "@/lib/display-order";
import {
  buildDefaultDisplayOrder,
  getChartDeviceSeriesOrder,
  orderItemKey,
} from "@/lib/display-order";

const METRIC_ICONS = {
  temperature: Thermometer,
  humidity: Droplets,
  pressure: Gauge,
  co2: Wind,
  illuminance: Sun,
} as const;

const VIEW_RANGES: ChartViewRange[] = ["day", "week", "month", "year"];

const CHART_MARGIN = { top: 28, right: 6, left: 0, bottom: 0 };
const Y_AXIS_WIDTH = 32;
/** recharts の XAxis デフォルト height（明示指定していないため既定値を使用） */
const X_AXIS_HEIGHT = 30;

/**
 * ComposedChart のプロット領域（margin + 軸の幅・高さ）を表す。選択位置の線・点は
 * recharts の外側に自前で重ねて描画しているため、ここが実際の margin/軸サイズと
 * ずれると線と点の表示位置が食い違う。CHART_MARGIN・Y_AXIS_WIDTH・X_AXIS_HEIGHT から
 * 導出することで実際のグラフ設定と同期させる。
 */
const PLOT_INSET = {
  left: CHART_MARGIN.left + Y_AXIS_WIDTH,
  right: CHART_MARGIN.right,
  top: CHART_MARGIN.top,
  bottom: CHART_MARGIN.bottom + X_AXIS_HEIGHT,
};

interface EnvironmentChartProps {
  historyData: HistoryPoint[];
  deviceIds: readonly number[];
  deviceNames: Record<number, string>;
  chartMetric: ChartMetric;
  onChartMetricChange: (metric: ChartMetric) => void;
  viewRange: ChartViewRange;
  onViewRangeChange: (range: ChartViewRange) => void;
  loading: boolean;
  historyLoading?: boolean;
  /** 最新データの取得待ち。true の間はグラフを描かずスケルトンを出す */
  awaitingLatest?: boolean;
  historyEpoch?: number;
  noMoreOlderData?: boolean;
  onVisibleDomainChange?: (visibleMin: number, visibleMax: number) => void;
  airconTargetDeviceId?: number;
  outdoorLocationName?: string;
  /**
   * 屋外ラインが指す基準地点のID。並び順には地点ごとの項目が並ぶため、どの項目を
   * 屋外ラインの凡例にするかをこれで決める（#358）。省略時は最初の屋外の項目。
   */
  outdoorPrimaryLocationId?: string | null;
  legendOrder?: readonly DisplayOrderItem[];
  chartColors: ChartColorSettings;
  lineVisibility: ChartLineVisibilitySettings;
  onLineVisibilityChange: (key: string, visible: boolean) => void;
  /** スマホ表示時に指標タブを画面下部に固定する（モーダル内では false） */
  pinMetricTabsOnMobile?: boolean;
  /** 指標の切り替えを別の場所（詳細パネルの「いまの値」）へ移したときに、上部のタブを描かない（#592） */
  hideMetricTabs?: boolean;
  /**
   * 照明が点いていた時間帯（#368）。グラフの真下に、同じ時間軸で帯として敷く。
   * 空配列なら帯の枠だけを描き（＝記録が無い日）、省略すれば帯そのものを出さない。
   */
  lightSegments?: readonly LightSegment[];
  /** 帯の見出しに添える判定元。「リビング照明 · Nature Remo の状態」 */
  lightSourceLabel?: string;
  /**
   * 点灯とみなす照度（lx）。**指標が「照度」のときだけ基準線として引く。**
   * 線が跨いだところで帯が切り替わるので、しきい値のずれをその場で見つけられる。
   */
  lightThreshold?: number | null;
}

/**
 * 日射の可能性がある区間の塗り（#371）。
 *
 * **「日中」を時間軸の固定位置で描かないこと。** `domain` は `computeChartDomain()` が返す
 * ローリングウィンドウで、日付の境界にも 6:00 にも整列しない（週・月の表示では1本の帯に
 * 何日ぶんも乗る）。日中を割合の決め打ちで塗ると、実際の時間帯とは無関係な場所が光る。
 * 印を付ける相手は時間軸ではなく**区間そのもの**で、どの区間が日中に収まるかはバックエンドが
 * `daylight` として返している。
 */
const DAYLIGHT_FILL =
  "repeating-linear-gradient(45deg, var(--remote-color) 0 3px," +
  " color-mix(in srgb, var(--remote-color) 30%, transparent) 3px 6px)";

/**
 * グラフの真下に敷く、照明が点いていた時間帯の帯（#368）。
 *
 * **プロット領域と同じ余白を取る。** `PLOT_INSET` はY軸の幅・グラフの margin から
 * 導いた値で、ここを合わせておかないと帯とグラフの時間軸が横にずれる。
 * 期間の切り替え・横スクロールでは `domain` が変わるだけなので、帯も自動で追従する。
 */
function LightBand({
  segments,
  domain,
  label,
}: {
  segments: readonly LightSegment[];
  domain: readonly [number, number];
  label?: string;
}) {
  const pieces = useMemo(() => buildBandPieces(segments, domain), [segments, domain]);
  const hasDaylight = pieces.some((piece) => piece.daylight);

  return (
    <div
      className="pb-1 pt-0.5"
      style={{ paddingLeft: PLOT_INSET.left, paddingRight: PLOT_INSET.right }}
    >
      {label ? (
        <p className="mb-1 text-[10.5px] text-muted-foreground">照明（{label}）</p>
      ) : null}
      <div className="relative h-3.5 overflow-hidden rounded-[7px] bg-muted">
        {pieces.map((piece) => (
          <div
            key={piece.key}
            className="absolute inset-y-0"
            // 日射の可能性がある区間は縞で塗る。一覧の「日射の可能性」と同じ区間を指す
            title={piece.daylight ? "日射の可能性" : undefined}
            style={{
              left: `${piece.left * 100}%`,
              width: `${piece.width * 100}%`,
              background: piece.daylight ? DAYLIGHT_FILL : "var(--remote-color)",
              // 期間の外へ続いている端は丸めない。「ここで消したわけではない」を形で伝える
              borderTopLeftRadius: piece.openStart ? 2 : 7,
              borderBottomLeftRadius: piece.openStart ? 2 : 7,
              borderTopRightRadius: piece.openEnd ? 2 : 7,
              borderBottomRightRadius: piece.openEnd ? 2 : 7,
            }}
          />
        ))}
      </div>
      {hasDaylight ? (
        <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span
            className="inline-block h-2 w-4 shrink-0 rounded-[3px]"
            style={{ background: DAYLIGHT_FILL }}
            aria-hidden
          />
          縞の区間は日射の可能性があります
        </p>
      ) : null}
    </div>
  );
}

/** 最新データの取得待ちに出すグラフ領域のスケルトン */
function ChartLoadingSkeleton() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <svg
        className="absolute inset-0 size-full"
        viewBox="0 0 440 240"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <g stroke="var(--chart-grid)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke">
          <line x1="34" y1="50" x2="432" y2="50" />
          <line x1="34" y1="110" x2="432" y2="110" />
          <line x1="34" y1="170" x2="432" y2="170" />
        </g>
        <path
          className="animate-pulse"
          fill="var(--muted)"
          d="M34,228 L34,150 C90,122 118,174 174,142 C230,110 258,156 316,118 C366,84 398,126 432,104 L432,228 Z"
        />
      </svg>
      <div className="relative flex flex-col items-center gap-2 text-muted-foreground">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground" />
        <p className="text-sm">最新データを取得中</p>
      </div>
    </div>
  );
}

interface ChartSeriesRow {
  id: string;
  name: string;
  color: string;
  value: number | undefined;
  minValue?: number;
  maxValue?: number;
  visible: boolean;
  visibilityKey: string;
}

function getMetricKeys(metric: ChartMetric) {
  return {
    outdoorKey: `outdoor_${metric}` as keyof HistoryPoint,
  };
}

function formatMetricValue(value: number | undefined, metric: ChartMetric): string {
  if (value == null) return "--";
  if (metric === "pressure" || metric === "co2") return String(Math.round(value));
  if (metric === "illuminance") return value.toFixed(1);
  return value.toFixed(1);
}

function formatSeriesRowValue(
  row: ChartSeriesRow,
  metric: ChartMetric,
  unit: string
): string {
  if (row.id === "aircon-target") {
    return formatAirconTargetTemperature(row.value);
  }
  if (row.value == null) {
    return `--${unit}`;
  }
  return `${formatMetricValue(row.value, metric)}${unit}`;
}

function computeSelectionXRatio(
  currentDomain: ReturnType<typeof computeChartDomain>,
  selectionTime: number | null
): number | null {
  if (selectionTime == null || currentDomain[0] === "dataMin") return null;

  const [minT, maxT] = currentDomain;
  const timeSpan = maxT - minT;
  if (timeSpan <= 0) return null;

  return Math.max(0, Math.min(1, (selectionTime - minT) / timeSpan));
}

function computePlotYRatio(
  visibleYDomain: ReturnType<typeof computeVisibleYDomain>,
  activeValue: number | undefined
): number | null {
  if (
    activeValue == null ||
    typeof visibleYDomain[0] !== "number" ||
    typeof visibleYDomain[1] !== "number"
  ) {
    return null;
  }

  const ymin = visibleYDomain[0];
  const ymax = visibleYDomain[1];
  const valueSpan = ymax - ymin;
  if (valueSpan <= 0) return null;

  return 1 - (activeValue - ymin) / valueSpan;
}

function computePlotPosition(
  currentDomain: ReturnType<typeof computeChartDomain>,
  visibleYDomain: ReturnType<typeof computeVisibleYDomain>,
  selectionLineX: number | undefined,
  activeValue: number | undefined
) {
  const xRatio = computeSelectionXRatio(
    currentDomain,
    selectionLineX ?? null
  );
  if (xRatio == null || activeValue == null) return null;

  const yRatio = computePlotYRatio(visibleYDomain, activeValue);
  if (yRatio == null) return null;

  return { xRatio, yRatio };
}

function plotHeightExpr(): string {
  return `(100% - ${PLOT_INSET.top + PLOT_INSET.bottom}px)`;
}

export function EnvironmentChart({
  historyData,
  deviceIds,
  deviceNames,
  chartMetric,
  onChartMetricChange,
  viewRange,
  onViewRangeChange,
  loading,
  historyLoading = false,
  awaitingLatest = false,
  historyEpoch = 0,
  noMoreOlderData = false,
  onVisibleDomainChange,
  airconTargetDeviceId,
  outdoorLocationName,
  outdoorPrimaryLocationId,
  legendOrder,
  chartColors,
  lineVisibility,
  onLineVisibilityChange,
  pinMetricTabsOnMobile = true,
  hideMetricTabs = false,
  lightSegments,
  lightSourceLabel,
  lightThreshold = null,
}: EnvironmentChartProps) {
  const resolvedLegendOrder = legendOrder ?? buildDefaultDisplayOrder(deviceIds.filter(
    (id) => id !== AIRCON_CHART_DEVICE_ID
  ));
  const deviceSeriesOrder = useMemo(
    () => getChartDeviceSeriesOrder([...resolvedLegendOrder]),
    [resolvedLegendOrder]
  );
  const airconTargetColor = getAirconTargetChartColor(chartColors);
  const outdoorLineColor = getOutdoorChartColor(chartColors);
  const { outdoorKey } = getMetricKeys(chartMetric);
  const aggregated = isAggregatedRange(viewRange);

  const availableMetrics = useMemo(
    () => getAvailableChartMetrics(historyData, deviceIds),
    [historyData, deviceIds]
  );

  const visibleDeviceIds = useMemo(
    () => getDevicesWithMetricData(historyData, deviceIds, chartMetric),
    [historyData, deviceIds, chartMetric]
  );

  const canShowOutdoor = hasOutdoorMetricData(historyData, chartMetric);
  const showAirconInOrder = resolvedLegendOrder.some((item) => item.type === "aircon");
  const showAirconTargetLine =
    chartMetric === "temperature" &&
    airconTargetDeviceId != null &&
    showAirconInOrder &&
    hasDeviceTargetStateData(historyData, airconTargetDeviceId);
  const showOutdoorInOrder = resolvedLegendOrder.some((item) => item.type === "outdoor");
  /**
   * 凡例に屋外の行を出す項目のキー。**屋外のラインは基準地点の1本だけ**（#308・#321）だが、
   * 並び順（`legendOrder`）には地点ごとの項目が並ぶため、当たるたびに行を足すと同じ線の凡例が
   * 地点数ぶん重複する（#358。地点を2つ登録すると基準地点の名前と値が2行出た）。
   * 基準地点の項目が並びにあればその位置に、無ければ最初の屋外の項目の位置に1行だけ出す。
   */
  const outdoorLegendItemKey = useMemo(() => {
    const outdoorItems = resolvedLegendOrder.filter((item) => item.type === "outdoor");
    if (!outdoorItems.length) return null;
    const primary = outdoorPrimaryLocationId
      ? outdoorItems.find(
          (item) => item.type === "outdoor" && item.locationId === outdoorPrimaryLocationId
        )
      : undefined;
    return orderItemKey(primary ?? outdoorItems[0]);
  }, [resolvedLegendOrder, outdoorPrimaryLocationId]);
  const showOutdoorLine =
    canShowOutdoor &&
    showOutdoorInOrder &&
    isChartLineVisible(lineVisibility, outdoorMetricVisibilityKey(chartMetric));
  const showTargetLine =
    showAirconTargetLine &&
    airconTargetDeviceId != null &&
    hasDeviceTargetChartData(historyData, airconTargetDeviceId) &&
    isChartLineVisible(lineVisibility, AIRCON_TARGET_VISIBILITY_KEY);
  const targetDeviceIds =
    showTargetLine && airconTargetDeviceId != null
      ? ([airconTargetDeviceId] as const)
      : undefined;

  const plottedDeviceIds = useMemo(
    () =>
      visibleDeviceIds.filter((deviceId) =>
        isChartLineVisible(lineVisibility, deviceMetricVisibilityKey(deviceId, chartMetric))
      ),
    [visibleDeviceIds, lineVisibility, chartMetric]
  );

  const dht11DeviceIds = useMemo(
    () =>
      chartMetric === "temperature"
        ? getDevicesWithDht11TemperatureData(historyData, deviceIds)
        : [],
    [chartMetric, historyData, deviceIds]
  );

  const plottedDht11DeviceIds = useMemo(
    () =>
      dht11DeviceIds.filter((deviceId) =>
        isChartLineVisible(lineVisibility, deviceDht11VisibilityKey(deviceId))
      ),
    [dht11DeviceIds, lineVisibility]
  );

  const orderedPlottedDeviceIds = useMemo(() => {
    const preferred = deviceSeriesOrder.filter((deviceId) =>
      plottedDeviceIds.includes(deviceId)
    );
    const rest = plottedDeviceIds.filter((deviceId) => !preferred.includes(deviceId));
    return [...preferred, ...rest];
  }, [deviceSeriesOrder, plottedDeviceIds]);

  const orderedPlottedDht11DeviceIds = useMemo(() => {
    const preferred = deviceSeriesOrder.filter((deviceId) =>
      plottedDht11DeviceIds.includes(deviceId)
    );
    const rest = plottedDht11DeviceIds.filter((deviceId) => !preferred.includes(deviceId));
    return [...preferred, ...rest];
  }, [deviceSeriesOrder, plottedDht11DeviceIds]);

  const isDeviceLineVisible = useCallback(
    (deviceId: number) =>
      isChartLineVisible(lineVisibility, deviceMetricVisibilityKey(deviceId, chartMetric)),
    [lineVisibility, chartMetric]
  );

  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [domainOffset, setDomainOffset] = useState(0);
  const [metricDisplayMode, setMetricDisplayMode] = useState<"average" | "minmax">("average");
  const showMinMaxToggle = viewRange !== "day";
  const isMinMaxMode = showMinMaxToggle && metricDisplayMode === "minmax";
  const chartRef = useRef<HTMLDivElement>(null);
  const dragDomainRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const preservedSelectionTimeRef = useRef<number | null>(null);
  const lastScrolledEpochRef = useRef(-1);
  const dataMaxTimeRef = useRef<number | null>(null);

  useEffect(() => {
    dragDomainRef.current = domainOffset;
  }, [domainOffset]);

  useEffect(() => {
    const epochChanged = lastScrolledEpochRef.current !== historyEpoch;
    if (epochChanged) {
      lastScrolledEpochRef.current = historyEpoch;
      preservedSelectionTimeRef.current = null;
    }
    const preserved = preservedSelectionTimeRef.current;
    const nextOffset =
      preserved != null && historyData.length
        ? computeDomainOffsetForSelectionTime(historyData, viewRange, preserved, {
            allowPastExtension: !noMoreOlderData,
            noMoreOlderData,
          })
        : getMaxPositiveDomainOffset(viewRange);
    dragDomainRef.current = nextOffset;
    setDomainOffset(nextOffset);
    dataMaxTimeRef.current = historyData.length
      ? historyData[historyData.length - 1].datetimeObj
      : null;
  }, [viewRange, historyEpoch]);

  /**
   * domainOffset は historyData 末尾時刻からの相対値のため、バックグラウンド更新などで
   * 新しいデータが継ぎ足されて末尾時刻が進むと、offset が同じでも表示域全体が未来方向へ
   * ずれてしまう（＝閲覧中の時刻が勝手に最新へ近づいていく）。最新追従中でない限り、
   * 進んだ分だけ offset を戻して閲覧中の絶対時刻を据え置く。
   */
  useEffect(() => {
    if (dragStartX !== null || !historyData.length) return;

    const dataMaxTime = historyData[historyData.length - 1].datetimeObj;
    const prevDataMaxTime = dataMaxTimeRef.current;
    dataMaxTimeRef.current = dataMaxTime;
    if (prevDataMaxTime == null) return;

    const delta = dataMaxTime - prevDataMaxTime;
    if (delta <= 0) return;

    const maxPositiveOffset = getMaxPositiveDomainOffset(viewRange);
    const isFollowingLive = dragDomainRef.current >= maxPositiveOffset - 1000;
    if (isFollowingLive) return;

    const nextOffset = dragDomainRef.current - delta;
    dragDomainRef.current = nextOffset;
    setDomainOffset(nextOffset);
  }, [historyData, viewRange, dragStartX]);

  useEffect(() => {
    if (!availableMetrics.length) return;
    if (!availableMetrics.includes(chartMetric)) {
      onChartMetricChange(availableMetrics[0]);
    }
  }, [availableMetrics, chartMetric, onChartMetricChange]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  const scheduleDomainOffset = useCallback(
    (nextOffset: number) => {
      dragDomainRef.current = nextOffset;
      if (historyData.length) {
        const domain = computeChartDomain(historyData, viewRange, nextOffset);
        const t = getSelectionTime(historyData, domain);
        if (t != null) preservedSelectionTimeRef.current = t;
      }
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        setDomainOffset(dragDomainRef.current);
        rafRef.current = null;
      });
    },
    [historyData, viewRange]
  );

  const currentDomain = useMemo(
    () => computeChartDomain(historyData, viewRange, domainOffset),
    [historyData, viewRange, domainOffset]
  );

  //`["dataMin", "dataMax"]`（データが無くて範囲が決まらないとき）は帯を敷けない。
  // 他の重ね描き（選択位置の線・点）と同じ判定にそろえる
  const bandDomain: ChartDomain | null =
    currentDomain[0] === "dataMin" ? null : (currentDomain as ChartDomain);

  const minMaxHistorySource = useMemo(() => {
    if (!isMinMaxMode) return null;
    if (viewRange === "year") return historyData;
    return buildDailyMinMaxHistory(historyData, plottedDeviceIds, chartMetric);
  }, [isMinMaxMode, viewRange, historyData, plottedDeviceIds, chartMetric]);

  useEffect(() => {
    if (currentDomain[0] === "dataMin" || !onVisibleDomainChange) return;

    const timer = window.setTimeout(() => {
      onVisibleDomainChange(currentDomain[0] as number, currentDomain[1] as number);
    }, 150);

    return () => window.clearTimeout(timer);
  }, [currentDomain, onVisibleDomainChange]);

  const selectionTime = useMemo(
    () => getSelectionTime(historyData, currentDomain),
    [historyData, currentDomain]
  );

  /** 最高/最低モードでは、横スクロール中も選択位置を最寄りの日の実データ点へスナップする（点の無い時刻を飛ばす） */
  const effectiveSelectionTime = useMemo(() => {
    if (!isMinMaxMode || selectionTime == null || !minMaxHistorySource?.length) {
      return selectionTime;
    }
    let nearest = minMaxHistorySource[0].datetimeObj;
    let bestDiff = Math.abs(nearest - selectionTime);
    for (const point of minMaxHistorySource) {
      const diff = Math.abs(point.datetimeObj - selectionTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = point.datetimeObj;
      }
    }
    return nearest;
  }, [isMinMaxMode, selectionTime, minMaxHistorySource]);

  const ticks = useMemo(() => {
    if (currentDomain[0] === "dataMin") return undefined;
    const [minT, maxT] = currentDomain;
    return getChartTicksForDomain(minT, maxT, viewRange);
  }, [currentDomain, viewRange]);

  const visibleYDomain = useMemo(
    () =>
      computeVisibleYDomain(
        isMinMaxMode ? minMaxHistorySource ?? [] : historyData,
        currentDomain,
        chartMetric,
        isMinMaxMode ? true : aggregated,
        plottedDeviceIds,
        showOutdoorLine,
        isMinMaxMode ? undefined : targetDeviceIds,
        isMinMaxMode ? undefined : plottedDht11DeviceIds
      ),
    [
      isMinMaxMode,
      minMaxHistorySource,
      historyData,
      currentDomain,
      chartMetric,
      aggregated,
      plottedDeviceIds,
      showOutdoorLine,
      targetDeviceIds,
      plottedDht11DeviceIds,
    ]
  );

  const historySource = useMemo(() => {
    const visible = filterHistoryForDomain(historyData, currentDomain);
    return visible.length > 0 ? visible : historyData;
  }, [historyData, currentDomain]);

  const downsampleDeviceIds = useMemo(() => {
    if (chartMetric !== "temperature") return plottedDeviceIds;
    return [...new Set([...plottedDeviceIds, ...plottedDht11DeviceIds])];
  }, [chartMetric, plottedDeviceIds, plottedDht11DeviceIds]);

  const chartPlotData = useMemo(() => {
    if (!historyData.length) return [];

    if (isMinMaxMode) {
      if (!minMaxHistorySource) return [];
      const visible = filterHistoryForDomain(minMaxHistorySource, currentDomain);
      return visible.length > 0 ? visible : minMaxHistorySource;
    }

    const source = historySource;
    const base = aggregated
      ? source
      : downsampleMultiDeviceHistoryForChart(
          source,
          chartMetric,
          320,
          downsampleDeviceIds
        );

    return withSelectionEndPoints(
      base,
      selectionTime,
      plottedDeviceIds,
      chartMetric,
      showOutdoorLine,
      targetDeviceIds,
      plottedDht11DeviceIds
    );
  }, [
    historyData,
    isMinMaxMode,
    minMaxHistorySource,
    currentDomain,
    historySource,
    chartMetric,
    aggregated,
    downsampleDeviceIds,
    selectionTime,
    showOutdoorLine,
    targetDeviceIds,
    plottedDht11DeviceIds,
  ]);

  const airconTargetSegments = useMemo(() => {
    if (
      isMinMaxMode ||
      !showTargetLine ||
      airconTargetDeviceId == null ||
      chartMetric !== "temperature"
    ) {
      return [] as AirconTargetChartSegment[];
    }

    const source = historySource;
    const maxPoints = aggregated ? 0 : 320;
    let segments = buildAirconTargetChartSegments(source, airconTargetDeviceId, maxPoints);

    if (selectionTime != null) {
      const state = getDeviceTargetMetricStateAtTime(
        source,
        airconTargetDeviceId,
        selectionTime
      );
      if (
        state != null &&
        !isAirconOffAtTime(source, airconTargetDeviceId, selectionTime)
      ) {
        const isAuto = isAirconAutoTarget(state);
        const value = isAuto
          ? getDeviceMetricValueAtTime(
              source,
              airconTargetDeviceId,
              "temperature",
              selectionTime
            )
          : getDeviceTargetMetricValueAtTime(
              source,
              airconTargetDeviceId,
              selectionTime
            );

        if (value != null) {
          segments = segments.map((segment) => {
            if (segment.auto !== isAuto) return segment;
            if (segment.points.some((point) => point.datetimeObj === selectionTime)) {
              return segment;
            }
            const first = segment.points[0]?.datetimeObj;
            const last = segment.points[segment.points.length - 1]?.datetimeObj;
            if (first == null || last == null) return segment;
            if (selectionTime < first || selectionTime > last) return segment;
            return {
              ...segment,
              points: [
                ...segment.points,
                { datetimeObj: selectionTime, airconTarget: value },
              ].sort((a, b) => a.datetimeObj - b.datetimeObj),
            };
          });
        }
      }
    }

    return segments;
  }, [
    isMinMaxMode,
    showTargetLine,
    airconTargetDeviceId,
    chartMetric,
    historySource,
    aggregated,
    selectionTime,
  ]);

  const airconTargetPointCount = airconTargetSegments.reduce(
    (count, segment) => count + segment.points.length,
    0
  );

  const referenceLines = ticks?.map((t) => (
    <ReferenceLine
      key={t}
      x={t}
      stroke="var(--chart-line)"
      strokeDasharray="3 3"
    />
  ));

  const activeDeviceValues = useMemo(() => {
    if (selectionTime == null || isMinMaxMode) return [];
    return orderedPlottedDeviceIds
      .map((deviceId) => ({
        deviceId,
        name: deviceNames[deviceId] ?? `デバイス ${deviceId}`,
        value: getDeviceMetricValueAtTime(
          chartPlotData,
          deviceId,
          chartMetric,
          selectionTime
        ),
        color: getDeviceChartColor(chartColors, deviceId),
      }))
      .filter((entry) => entry.value != null);
  }, [selectionTime, isMinMaxMode, orderedPlottedDeviceIds, deviceNames, chartMetric, chartPlotData, chartColors]);

  const activeDht11Values = useMemo(() => {
    if (selectionTime == null || chartMetric !== "temperature") return [];
    return orderedPlottedDht11DeviceIds
      .map((deviceId) => ({
        deviceId,
        seriesKey: `dht11-${deviceId}`,
        name: `${deviceNames[deviceId] ?? `デバイス ${deviceId}`} (DHT11)`,
        value: getDeviceDht11TemperatureValueAtTime(
          chartPlotData,
          deviceId,
          selectionTime
        ),
        color: getDeviceChartColor(chartColors, deviceId),
      }))
      .filter((entry) => entry.value != null);
  }, [
    selectionTime,
    chartMetric,
    orderedPlottedDht11DeviceIds,
    deviceNames,
    chartPlotData,
    chartColors,
  ]);

  const activeDeviceMinMaxValues = useMemo(() => {
    if (!isMinMaxMode || effectiveSelectionTime == null || !minMaxHistorySource) return [];
    return orderedPlottedDeviceIds
      .map((deviceId) => {
        const { min, max } = getDeviceMetricMinMaxAtTime(
          minMaxHistorySource,
          deviceId,
          chartMetric,
          effectiveSelectionTime
        );
        return {
          deviceId,
          name: deviceNames[deviceId] ?? `デバイス ${deviceId}`,
          min,
          max,
          color: getDeviceChartColor(chartColors, deviceId),
        };
      })
      .filter((entry) => entry.min != null || entry.max != null);
  }, [
    isMinMaxMode,
    effectiveSelectionTime,
    minMaxHistorySource,
    orderedPlottedDeviceIds,
    chartMetric,
    deviceNames,
    chartColors,
  ]);

  const activeOutdoor = useMemo(() => {
    if (selectionTime == null) return undefined;
    return getOutdoorMetricValueAtTime(historySource, chartMetric, selectionTime);
  }, [selectionTime, historySource, chartMetric]);

  const activeTargetState = useMemo(() => {
    if (
      selectionTime == null ||
      !showAirconTargetLine ||
      airconTargetDeviceId == null
    ) {
      return undefined;
    }
    return getDeviceTargetMetricStateAtTime(
      historySource,
      airconTargetDeviceId,
      selectionTime
    );
  }, [selectionTime, showAirconTargetLine, airconTargetDeviceId, historySource]);

  const chartSeriesRows = useMemo((): ChartSeriesRow[] => {
    const rows: ChartSeriesRow[] = [];

    for (const item of resolvedLegendOrder) {
      if (item.type === "device" || item.type === "aircon") {
        const deviceId =
          item.type === "device" ? item.deviceId : AIRCON_CHART_DEVICE_ID;
        // 設定温度は室温とは別の指標で、`/devices` の「ダッシュボードに表示」も別に持つ。
        // **室温の行が出ない場面（室温だけ非表示・室温の記録なし）でも線は描かれる**ため、
        // ここで一緒に落とすと凡例の無いラインが残る（#358）
        const showTargetRow =
          !isMinMaxMode && deviceId === airconTargetDeviceId && showAirconTargetLine;
        const inChart = deviceIds.includes(deviceId);

        const hasMetric =
          inChart && hasDeviceMetricData(historyData, deviceId, chartMetric);
        const hasDht11 =
          inChart &&
          chartMetric === "temperature" &&
          hasDeviceDht11TemperatureData(historyData, deviceId);

        if (hasMetric) {
          const minMaxEntry = isMinMaxMode
            ? activeDeviceMinMaxValues.find((entry) => entry.deviceId === deviceId)
            : undefined;
          rows.push({
            id: `device-${deviceId}`,
            name: deviceNames[deviceId] ?? `デバイス ${deviceId}`,
            color: getDeviceChartColor(chartColors, deviceId),
            value:
              isMinMaxMode || selectionTime == null
                ? undefined
                : getDeviceMetricValueAtTime(
                    historySource,
                    deviceId,
                    chartMetric,
                    selectionTime
                  ),
            minValue: minMaxEntry?.min,
            maxValue: minMaxEntry?.max,
            visible: isDeviceLineVisible(deviceId),
            visibilityKey: deviceMetricVisibilityKey(deviceId, chartMetric),
          });
        }

        if (hasDht11 && !isMinMaxMode) {
          rows.push({
            id: `device-dht11-${deviceId}`,
            name: `${deviceNames[deviceId] ?? `デバイス ${deviceId}`} (DHT11)`,
            color: getDeviceChartColor(chartColors, deviceId),
            value:
              selectionTime == null
                ? undefined
                : getDeviceDht11TemperatureValueAtTime(
                    historySource,
                    deviceId,
                    selectionTime
                  ),
            visible: isChartLineVisible(
              lineVisibility,
              deviceDht11VisibilityKey(deviceId)
            ),
            visibilityKey: deviceDht11VisibilityKey(deviceId),
          });
        }

        if (showTargetRow && airconTargetDeviceId != null) {
          rows.push({
            id: "aircon-target",
            name: `${deviceNames[airconTargetDeviceId] ?? "エアコン"}（設定温度）`,
            color: airconTargetColor,
            value: activeTargetState,
            visible: isChartLineVisible(lineVisibility, AIRCON_TARGET_VISIBILITY_KEY),
            visibilityKey: AIRCON_TARGET_VISIBILITY_KEY,
          });
        }
        continue;
      }

      if (
        item.type === "outdoor" &&
        canShowOutdoor &&
        orderItemKey(item) === outdoorLegendItemKey
      ) {
        rows.push({
          id: "outdoor",
          name: formatOutdoorApiLabel(outdoorLocationName),
          color: outdoorLineColor,
          value: activeOutdoor,
          visible: isChartLineVisible(lineVisibility, outdoorMetricVisibilityKey(chartMetric)),
          visibilityKey: outdoorMetricVisibilityKey(chartMetric),
        });
      }
    }

    return rows;
  }, [
    resolvedLegendOrder,
    deviceIds,
    historyData,
    chartMetric,
    deviceNames,
    selectionTime,
    historySource,
    isDeviceLineVisible,
    isMinMaxMode,
    activeDeviceMinMaxValues,
    airconTargetDeviceId,
    showAirconTargetLine,
    activeTargetState,
    airconTargetColor,
    canShowOutdoor,
    chartColors,
    outdoorLegendItemKey,
    outdoorLineColor,
    outdoorLocationName,
    activeOutdoor,
    lineVisibility,
  ]);

  const selectionLabel =
    effectiveSelectionTime != null
      ? formatActivePointLabel(effectiveSelectionTime, viewRange, isMinMaxMode)
      : "";

  const activeMinMaxDotEntries = useMemo(() => {
    if (!isMinMaxMode) return [];
    return activeDeviceMinMaxValues.flatMap((entry) => [
      {
        deviceId: entry.deviceId,
        seriesKey: `minmax-max-${entry.deviceId}`,
        name: `${entry.name}（最高）`,
        value: entry.max,
        color: entry.color,
      },
      {
        deviceId: entry.deviceId,
        seriesKey: `minmax-min-${entry.deviceId}`,
        name: `${entry.name}（最低）`,
        value: entry.min,
        color: entry.color,
      },
    ]);
  }, [isMinMaxMode, activeDeviceMinMaxValues]);

  const activeDots = useMemo(() => {
    if (effectiveSelectionTime == null) return [];
    return [...activeDeviceValues, ...activeDht11Values, ...activeMinMaxDotEntries]
      .map((entry) => {
        const plotPosition = computePlotPosition(
          currentDomain,
          visibleYDomain,
          effectiveSelectionTime,
          entry.value
        );
        return plotPosition?.yRatio != null
          ? { ...entry, plotPosition, deviceId: entry.deviceId }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  }, [
    activeDeviceValues,
    activeDht11Values,
    activeMinMaxDotEntries,
    currentDomain,
    effectiveSelectionTime,
    visibleYDomain,
  ]);

  const unit = METRIC_UNITS[chartMetric];

  const handleViewRangeChange = (range: ChartViewRange) => {
    if (historyData.length && currentDomain[0] !== "dataMin") {
      const t = getSelectionTime(historyData, currentDomain);
      if (t != null) preservedSelectionTimeRef.current = t;
    }
    if (range === "day") {
      setMetricDisplayMode("average");
    }
    onViewRangeChange(range);
  };

  const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    // スケルトン表示中はグラフが見えないため、ドラッグでの期間移動も受け付けない
    if (awaitingLatest) return;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    setDragStartX(clientX);
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (dragStartX === null || !historyData.length || currentDomain[0] === "dataMin") return;

      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const dx = clientX - dragStartX;

      if (chartRef.current) {
        const width = chartRef.current.clientWidth;
        const [minT, maxT] = currentDomain as [number, number];
        const timePerPixel = (maxT - minT) / width;
        const timeShift = -dx * timePerPixel;

        const next = clampDomainOffset(
          historyData,
          viewRange,
          dragDomainRef.current,
          timeShift,
          {
            allowPastExtension: !noMoreOlderData,
            noMoreOlderData,
          }
        );
        scheduleDomainOffset(next);
        setDragStartX(clientX);
      }
    },
    [dragStartX, historyData, currentDomain, viewRange, scheduleDomainOffset, noMoreOlderData]
  );

  const handleMouseUp = () => {
    setDragStartX(null);
  };

  const selectionXRatio = useMemo(
    () => computeSelectionXRatio(currentDomain, effectiveSelectionTime),
    [currentDomain, effectiveSelectionTime]
  );

  const plotWidthExpr = `(100% - ${PLOT_INSET.left + PLOT_INSET.right}px)`;
  const lineLeft =
    selectionXRatio != null
      ? `calc(${PLOT_INSET.left}px + ${plotWidthExpr} * ${selectionXRatio})`
      : undefined;

  const showSelectionOverlay =
    !awaitingLatest &&
    lineLeft != null &&
    chartPlotData.length > 0 &&
    (plottedDeviceIds.length > 0 ||
      plottedDht11DeviceIds.length > 0 ||
      (showOutdoorLine && activeOutdoor != null) ||
      (showAirconTargetLine && activeTargetState != null));

  const hasPlottedLines =
    plottedDeviceIds.length > 0 ||
    plottedDht11DeviceIds.length > 0 ||
    showOutdoorLine ||
    airconTargetPointCount > 0;

  const renderMetricTabs = (
    tabsListClassName = "h-10",
    options?: { square?: boolean }
  ) => (
    <Tabs
      value={chartMetric}
      onValueChange={(v) => onChartMetricChange(v as ChartMetric)}
      className={options?.square ? "gap-0" : undefined}
    >
      <TabsList
        className={cn(
          "w-full",
          tabsListClassName,
          options?.square && "rounded-none bg-muted p-0 items-stretch"
        )}
      >
        {availableMetrics.map((metric) => {
          const Icon = METRIC_ICONS[metric];
          const active = chartMetric === metric;
          return (
            <TabsTrigger
              key={metric}
              value={metric}
              className={cn(
                "gap-1 text-xs sm:text-sm",
                active && "text-[var(--metric-color)]",
                options?.square &&
                  "h-full !items-start rounded-none pt-2.5 pb-0 bg-transparent shadow-none data-[state=active]:rounded-none data-[state=active]:bg-background data-[state=active]:shadow-none"
              )}
              style={
                active
                  ? ({ "--metric-color": METRIC_COLORS[metric] } as CSSProperties)
                  : undefined
              }
            >
              <Icon className="size-4" />
              {METRIC_LABELS[metric]}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );

  return (
    <div className="climate-card flex flex-col gap-0 overflow-hidden p-0">
      {hideMetricTabs ? null : (
        <div className={cn("px-2 pt-4", pinMetricTabsOnMobile && "hidden sm:block")}>
          {renderMetricTabs()}
        </div>
      )}

      {chartSeriesRows.length > 0 && (
        <div className="px-3 pt-3">
          {selectionTime != null && !awaitingLatest && (
            <p className="mb-2 text-center text-xs whitespace-nowrap text-muted-foreground">
              {selectionLabel}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {chartSeriesRows.map((row) => (
              <div key={row.id} className="flex items-center gap-1.5 px-1">
                <p
                  className={cn("shrink-0 text-sm font-bold", !row.visible && "opacity-40")}
                  style={{ color: row.color }}
                >
                  {row.name}
                </p>
                <div
                  className={cn(
                    "min-w-2 flex-1 border-b border-dashed",
                    !row.visible ? "border-muted-foreground/20" : "border-muted-foreground/40"
                  )}
                />
                {awaitingLatest ? (
                  <span
                    className="h-5 w-[74px] shrink-0 animate-pulse rounded-md bg-muted"
                    aria-hidden="true"
                  />
                ) : (
                  <p
                    className={cn("shrink-0 text-lg font-bold", !row.visible && "opacity-40")}
                    style={{ color: row.color }}
                  >
                    {row.minValue != null || row.maxValue != null ? (
                      <>
                        <span className="text-xs font-normal">最高</span>
                        {formatMetricValue(row.maxValue, chartMetric)}
                        {unit}
                        {" / "}
                        <span className="text-xs font-normal">最低</span>
                        {formatMetricValue(row.minValue, chartMetric)}
                        {unit}
                      </>
                    ) : (
                      formatSeriesRowValue(row, chartMetric, unit)
                    )}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onLineVisibilityChange(row.visibilityKey, !row.visible)
                  }
                  aria-pressed={row.visible}
                  aria-label={`${row.name}の表示切替`}
                  className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {row.visible ? (
                    <Eye className="size-5" strokeWidth={1.75} />
                  ) : (
                    <EyeOff className="size-5" strokeWidth={1.75} />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        ref={chartRef}
        className="relative h-[240px] w-full select-none px-0 pt-1"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleMouseDown}
        onTouchMove={handleMouseMove}
        onTouchEnd={handleMouseUp}
        style={{
          touchAction: "none",
          cursor: awaitingLatest ? "default" : dragStartX !== null ? "grabbing" : "grab",
        }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/50">
            <div className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          </div>
        )}

        {historyLoading && !loading && !awaitingLatest && historyData.length > 0 && (
          <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-card/90 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm">
            <div className="size-3 animate-spin rounded-full border border-muted-foreground/30 border-t-muted-foreground" />
            読み込み中
          </div>
        )}

        {awaitingLatest ? (
          <ChartLoadingSkeleton />
        ) : !historyData.length ? (
          loading || historyLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground" />
              <p>読み込み中...</p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
              <p>データがありません</p>
              <p className="text-[10px] opacity-70">バックエンドが起動しているか確認してください</p>
            </div>
          )
        ) : !chartPlotData.length || !hasPlottedLines ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            表示する項目を選択してください
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" className="pointer-events-none">
            <ComposedChart
              key={`${chartMetric}-${viewRange}-${plottedDeviceIds.join("-")}-${plottedDht11DeviceIds.join("-")}-${showOutdoorLine}-${showTargetLine}-${isMinMaxMode}`}
              data={chartPlotData}
              margin={CHART_MARGIN}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="datetimeObj"
                type="number"
                domain={currentDomain}
                ticks={ticks}
                tickFormatter={(t) => formatChartAxisDate(t, viewRange, isMinMaxMode)}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                scale="time"
                allowDataOverflow
              />
              <YAxis
                domain={visibleYDomain}
                allowDataOverflow
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                width={Y_AXIS_WIDTH}
                tickFormatter={(val) =>
                  chartMetric === "pressure" || chartMetric === "co2"
                    ? String(Math.round(val))
                    : chartMetric === "illuminance"
                      ? val >= 100 ? String(Math.round(val)) : val.toFixed(1)
                      : val.toFixed(1)
                }
              />
              {/*
                点灯とみなす照度。線がここを跨いだところで下の帯が切り替わるので、
                しきい値が実態とずれていればグラフを見るだけで気づける（#368）
              */}
              {chartMetric === "illuminance" && lightThreshold != null && lightThreshold > 0 && (
                <ReferenceLine
                  y={lightThreshold}
                  stroke="var(--remote-color)"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                />
              )}
              {showOutdoorLine && (
                <Line
                  type="linear"
                  dataKey={outdoorKey as string}
                  stroke={outdoorLineColor}
                  strokeWidth={1.5}
                  dot={false}
                  name={formatOutdoorApiLabel(outdoorLocationName)}
                  isAnimationActive={false}
                  connectNulls
                />
              )}
              {referenceLines}
              {isMinMaxMode
                ? orderedPlottedDeviceIds.flatMap((deviceId) => [
                    <Line
                      key={`${deviceId}-max`}
                      type="linear"
                      dataKey={deviceMetricMaxKey(deviceId, chartMetric)}
                      stroke={getDeviceChartColor(chartColors, deviceId)}
                      strokeWidth={1.5}
                      dot={false}
                      name={`${deviceNames[deviceId] ?? `デバイス ${deviceId}`}（最高）`}
                      isAnimationActive={false}
                      connectNulls
                    />,
                    <Line
                      key={`${deviceId}-min`}
                      type="linear"
                      dataKey={deviceMetricMinKey(deviceId, chartMetric)}
                      stroke={getDeviceChartColor(chartColors, deviceId)}
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      dot={false}
                      name={`${deviceNames[deviceId] ?? `デバイス ${deviceId}`}（最低）`}
                      isAnimationActive={false}
                      connectNulls
                    />,
                  ])
                : orderedPlottedDeviceIds.map((deviceId) => (
                    <Line
                      key={deviceId}
                      type="linear"
                      dataKey={deviceMetricKey(deviceId, chartMetric)}
                      stroke={getDeviceChartColor(chartColors, deviceId)}
                      strokeWidth={1.5}
                      dot={false}
                      name={deviceNames[deviceId] ?? `デバイス ${deviceId}`}
                      isAnimationActive={false}
                      connectNulls
                    />
                  ))}
              {!isMinMaxMode &&
                chartMetric === "temperature" &&
                orderedPlottedDht11DeviceIds.map((deviceId) => (
                  <Line
                    key={`dht11-${deviceId}`}
                    type="linear"
                    dataKey={deviceDht11TemperatureKey(deviceId)}
                    stroke={getDeviceChartColor(chartColors, deviceId)}
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    dot={false}
                    name={`${deviceNames[deviceId] ?? `デバイス ${deviceId}`} (DHT11)`}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              {airconTargetSegments.map((segment, index) =>
                segment.points.length > 0 ? (
                  <Line
                    key={`aircon-target-${segment.auto ? "auto" : "fixed"}-${index}`}
                    data={segment.points}
                    type="linear"
                    dataKey={AIRCON_TARGET_CHART_KEY}
                    stroke={airconTargetColor}
                    strokeWidth={1.5}
                    strokeDasharray={segment.auto ? "6 4" : undefined}
                    dot={false}
                    name={index === 0 ? "設定温度" : undefined}
                    legendType={index === 0 ? "line" : "none"}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ) : null
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {showSelectionOverlay && (
          <div className="pointer-events-none absolute inset-0 z-20">
            <p
              className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] font-bold text-muted-foreground"
              style={{ left: lineLeft, top: 4 }}
            >
              {selectionLabel}
            </p>
            <div
              className="absolute w-0 -translate-x-1/2 border-l border-dashed border-muted-foreground"
              style={{
                left: lineLeft,
                top: PLOT_INSET.top,
                bottom: PLOT_INSET.bottom,
              }}
            />
            {activeDots.map((entry) => {
              const dotTop =
                entry.plotPosition?.yRatio != null
                  ? `calc(${PLOT_INSET.top}px + ${plotHeightExpr()} * ${entry.plotPosition.yRatio})`
                  : undefined;
              if (!dotTop) return null;
              const dotKey =
                "seriesKey" in entry && typeof entry.seriesKey === "string"
                  ? entry.seriesKey
                  : `device-${entry.deviceId}`;
              return (
                <div
                  key={dotKey}
                  className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                  style={{ left: lineLeft, top: dotTop, backgroundColor: entry.color }}
                />
              );
            })}
          </div>
        )}
      </div>

      {lightSegments && bandDomain && !awaitingLatest && historyData.length > 0 ? (
        <LightBand segments={lightSegments} domain={bandDomain} label={lightSourceLabel} />
      ) : null}

      <div className="px-2 pb-4 pt-2">
        <div className="flex rounded-lg border bg-muted p-0.5">
          {VIEW_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => handleViewRangeChange(range)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-xs font-bold transition-all",
                viewRange === range
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {CHART_VIEW_RANGE_LABELS[range]}
            </button>
          ))}
        </div>
        {showMinMaxToggle && (
          <div className="mt-2 flex rounded-lg border bg-muted p-0.5">
            {(
              [
                { mode: "average", label: "平均" },
                { mode: "minmax", label: "最高・最低" },
              ] as const
            ).map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setMetricDisplayMode(mode)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1 text-xs font-bold transition-all",
                  metricDisplayMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          左右にドラッグして表示期間を変更
        </p>
      </div>

      {pinMetricTabsOnMobile && !hideMetricTabs && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 sm:hidden"
          aria-label="指標の選択"
        >
          <div className="mx-auto max-w-[480px] border-t border-border bg-muted/95 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur-sm dark:shadow-[0_-4px_16px_rgba(0,0,0,0.25)]">
            {renderMetricTabs("h-20", { square: true })}
            <div
              className="pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.5rem))]"
              aria-hidden
            />
          </div>
        </div>
      )}
    </div>
  );
}
