"use client";

import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useTheme } from "next-themes";
import { AppLoadingScreen } from "@/components/app-loading-screen";
import { LoginScreen } from "@/components/login-screen";
import { RoomLayoutSheet } from "@/components/room-layout-sheet";
import { SettingsIconButton } from "@/components/ui/settings-icon-button";
import {
  fetchAirconLatest,
  fetchAirconUnits,
  fetchCleaningSchedule,
  fetchDevices,
  fetchEnergyBreakdown,
  fetchLatestBatch,
  fetchUiSettings,
} from "@/lib/api";
import { formatCleaningCountdown, type CleaningSchedule, type CleaningTask } from "@/lib/cleaning";
import { formatUpdatedAt } from "@/lib/format-updated-at";
import { parseDataTimestamp } from "@/lib/offline-cache";
import {
  buildDefaultRoomLayers,
  normalizeRoomLayout,
  resolveRoomZones,
  ROOM_CLEANING_STATUS_COLORS,
  ROOM_LAYERS,
  ROOM_TEMPERATURE_RAMP_MAX,
  ROOM_TEMPERATURE_RAMP_MIN,
  roomTemperatureColor,
  type ResolvedRoomZone,
  type RoomLayerKey,
  type RoomLayerState,
  type RoomLayout,
} from "@/lib/room-layout";
import { saveRoomLayoutToServer } from "@/lib/ui-settings-client";
import { resolveAuthGate, useAuthState } from "@/lib/use-auth";
import {
  formatAirconMode,
  getAirconModeColor,
  getSensorDeviceIds,
  isAirconPowerOff,
  type AirconData,
  type AirconUnitInfo,
  type DeviceInfo,
  type EnergySourceRow,
  type LatestData,
} from "@/lib/types";

/**
 * 部屋の3Dビュー（`/room`・#399）。
 *
 * 既存のダッシュボードは「指標ごとのカード」で並ぶが、この画面は**場所ごと**に見る。
 * どの部屋が暑いか・どこの照明が点いているか・どこの掃除が遅れているかは、
 * 数字を読むより間取りの上で見たほうが速い。
 *
 * 値そのものは既存のAPIをそのまま読む。この画面のために増やしたのは
 * 「3D上の場所と、センサー・エアコン・掃除タスクの対応表」
 * （`app_settings` の `room_layout`）だけで、DDLは1行も足していない。
 *
 * three.js は `/room` を開いたときだけ読む。ダッシュボードの初期表示を重くしないため、
 * 3Dの本体（`room-scene.tsx`）は `ssr: false` の遅延読み込みにしてある
 * （`output: "export"` の静的書き出しなので、どのみちサーバー側では描けない）。
 */

const RoomScene = dynamic(
  () => import("@/components/room-scene").then((mod) => mod.RoomScene),
  {
    ssr: false,
    loading: () => <RoomStageMessage>3Dを読み込んでいます…</RoomStageMessage>,
  }
);

interface RoomData {
  devices: DeviceInfo[];
  latestByDevice: Record<number, LatestData | null>;
  lightThresholds: Record<string, number>;
  airconUnits: AirconUnitInfo[];
  airconByAcId: Record<number, AirconData | null>;
  cleaning: CleaningSchedule | null;
  energySources: EnergySourceRow[];
  layout: RoomLayout;
  /** 届いた記録のうち一番新しい時刻（ms）。1つも取れていなければ null */
  updatedAtMs: number | null;
}

const EMPTY_ROOM_DATA: RoomData = {
  devices: [],
  latestByDevice: {},
  lightThresholds: {},
  airconUnits: [],
  airconByAcId: {},
  cleaning: null,
  energySources: [],
  layout: normalizeRoomLayout(null),
  updatedAtMs: null,
};

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

/**
 * この画面が要る値を1回で集める。
 *
 * どれか1つが落ちても残りは出す（`fetchDashboardData()` と同じ考え方）。
 * 例えば Nature Remo が不調でエアコンだけ取れなくても、室温と掃除は見られたほうがよい。
 */
async function loadRoomData(): Promise<RoomData> {
  const [devicesResult, unitsResult, cleaningResult, settingsResult, energyResult] =
    await Promise.allSettled([
      fetchDevices(),
      fetchAirconUnits(),
      fetchCleaningSchedule(),
      fetchUiSettings(),
      fetchEnergyBreakdown(),
    ]);

  const devices = settled(devicesResult, [] as DeviceInfo[]);
  const airconUnits = settled(unitsResult, [] as AirconUnitInfo[]);
  const cleaning = cleaningResult.status === "fulfilled" ? cleaningResult.value : null;
  const settings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
  const energySources = energyResult.status === "fulfilled" ? energyResult.value.sources : [];

  const deviceIds = getSensorDeviceIds(devices);
  const [latestResult, airconResults] = await Promise.all([
    fetchLatestBatch(deviceIds),
    Promise.allSettled(airconUnits.map((unit) => fetchAirconLatest(unit.ac_id))),
  ]);

  const airconByAcId: Record<number, AirconData | null> = {};
  airconUnits.forEach((unit, index) => {
    airconByAcId[unit.ac_id] = settled(airconResults[index], null);
  });

  // 「最終更新」は届いた記録のうち一番新しいもの。取れなかった経路は数に入れない
  const stamps = [
    ...Object.values(latestResult.latestByDevice).map((entry) => parseDataTimestamp(entry?.datetime)),
    ...Object.values(airconByAcId).map((entry) => parseDataTimestamp(entry?.datetime)),
  ].filter((value): value is number => value != null);

  return {
    devices,
    latestByDevice: latestResult.latestByDevice,
    lightThresholds: settings?.light_thresholds ?? {},
    airconUnits,
    airconByAcId,
    cleaning,
    energySources,
    layout: normalizeRoomLayout(settings?.room_layout),
    updatedAtMs: stamps.length > 0 ? Math.max(...stamps) : null,
  };
}

/** 開いた時点の画面幅で初期のレイヤを決める。狭い画面はピンが混み合うため2種類だけ出す */
function initialLayers(): RoomLayerState {
  const compact =
    typeof window === "undefined" ? false : !window.matchMedia("(min-width: 1024px)").matches;
  return buildDefaultRoomLayers(compact);
}

export function RoomView() {
  const { resolvedTheme } = useTheme();
  const { isAuthenticated } = useAuthState();
  const [data, setData] = useState<RoomData>(EMPTY_ROOM_DATA);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [layers, setLayers] = useState<RoomLayerState>(initialLayers);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches
  );
  const [reduceMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  // 更新ボタンはこの数を1つ進めるだけ。取得は下の effect にまとめてあり、
  // effect の中で同期的に setState しない形にしている（`react-hooks/set-state-in-effect`）
  const [reloadToken, setReloadToken] = useState(0);

  // ログイン前に投げても401が返るだけなので、確定してから取りに行く
  useEffect(() => {
    if (isAuthenticated !== true) return undefined;

    let cancelled = false;
    loadRoomData()
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, reloadToken]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadToken((current) => current + 1);
  }, []);

  // カメラの引き具合だけ画面幅に追従させる。レイヤの初期値は開いた時点のまま変えない
  // （見ている途中で勝手に線が増える・消えるほうが分かりにくい）
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const handle = (event: MediaQueryListEvent | MediaQueryList) => setCompact(!event.matches);
    query.addEventListener("change", handle);
    return () => query.removeEventListener("change", handle);
  }, []);

  const zones = useMemo(
    () =>
      resolveRoomZones({
        layout: data.layout,
        latestByDevice: data.latestByDevice,
        lightThresholds: data.lightThresholds,
        airconByAcId: data.airconByAcId,
        cleaningTasks: data.cleaning?.tasks ?? [],
        energySources: data.energySources,
      }),
    [data]
  );

  const handleLayoutChange = useCallback(async (next: RoomLayout) => {
    setData((current) => ({ ...current, layout: next }));
    try {
      await saveRoomLayoutToServer(next);
    } catch {
      // 保存に失敗しても画面の操作は続けられるようにする。次に開いたときは
      // サーバーの値で作り直されるので、消えた設定が中途半端に残ることはない
    }
  }, []);

  const toggleLayer = (key: RoomLayerKey) => {
    setLayers((current) => ({ ...current, [key]: !current[key] }));
  };

  const sensorZones = zones.filter(
    (zone) => zone.deviceId != null || zone.aircon != null || zone.appliances.length > 0
  );
  const emptyZones = zones.filter(
    (zone) => zone.deviceId == null && zone.aircon == null && zone.appliances.length === 0
  );
  const cleaningRows = zones
    .flatMap((zone) => zone.cleaning.map((task) => ({ zone, task })))
    .sort((a, b) => a.task.days_until - b.task.days_until);

  // ログイン状態が確定するまではログイン画面を出さない（#250）。`/devices` と同じ扱い
  const authGate = resolveAuthGate(isAuthenticated);
  if (authGate === "loading") return <AppLoadingScreen />;
  if (authGate === "login") return <LoginScreen />;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-[480px] px-4 py-4 md:max-w-none md:px-6 lg:max-w-[1180px]">
        <header className="mb-4 flex items-center gap-2 border-b px-0.5 pb-3.5">
          <Link
            href="/"
            aria-label="ダッシュボードへ戻る"
            title="ダッシュボードへ戻る"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-[18px]" strokeWidth={1.75} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">
              部屋のようす
            </h1>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {data.updatedAtMs != null
                ? `最終更新 ${formatUpdatedAt(data.updatedAtMs)}`
                : loading
                  ? "読み込み中"
                  : "記録がありません"}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="データを更新"
              title="データを更新"
            >
              <RefreshCw
                className={`size-[18px] ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
            </button>
            <SettingsIconButton
              label="部屋の配置の設定"
              tone="header"
              onClick={() => setSettingsOpen(true)}
            />
          </div>
        </header>

        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="relative h-[340px] md:h-[460px] shrink-0 overflow-hidden rounded-[20px] bg-card shadow-sm lg:h-[560px] lg:min-w-0 lg:flex-1">
            {loading ? (
              <RoomStageMessage>部屋を組み立てています…</RoomStageMessage>
            ) : failed ? (
              <RoomStageMessage>
                データを取得できませんでした。更新ボタンを押してください。
              </RoomStageMessage>
            ) : (
              <RoomSceneBoundary>
                <RoomScene
                  zones={zones}
                  layers={layers}
                  focusKey={focusKey}
                  dark={resolvedTheme === "dark"}
                  compact={compact}
                  reduceMotion={reduceMotion}
                  onSelectZone={(key) => setFocusKey((current) => (current === key ? null : key))}
                />
              </RoomSceneBoundary>
            )}

            <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap gap-1.5">
              {ROOM_LAYERS.map((layer) => (
                <button
                  key={layer.key}
                  type="button"
                  aria-pressed={layers[layer.key]}
                  onClick={() => toggleLayer(layer.key)}
                  className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium backdrop-blur-sm transition-colors ${
                    layers[layer.key]
                      ? "border-foreground/25 bg-card/90 text-foreground"
                      : "bg-card/80 text-muted-foreground"
                  }`}
                >
                  <span
                    className="size-2 rounded-[2px]"
                    style={{
                      backgroundColor: `var(${layer.colorVar})`,
                      opacity: layers[layer.key] ? 1 : 0.35,
                    }}
                    aria-hidden
                  />
                  {layer.label}
                </button>
              ))}
            </div>

            {layers.temperature ? (
              <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-card/80 px-2.5 py-1 text-[10.5px] tabular-nums text-muted-foreground backdrop-blur-sm">
                <span>{ROOM_TEMPERATURE_RAMP_MIN}</span>
                <span
                  className="h-1.5 w-[86px] rounded-full"
                  style={{
                    backgroundImage: `linear-gradient(90deg, ${[18, 22, 25, 28, 31]
                      .map((value) => roomTemperatureColor(value))
                      .join(", ")})`,
                  }}
                  aria-hidden
                />
                <span>{ROOM_TEMPERATURE_RAMP_MAX}℃</span>
              </div>
            ) : null}

            <p className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-card/80 px-2.5 py-1 text-[11px] text-muted-foreground">
              {compact ? "指でなぞると回ります" : "ドラッグで回す・ホイールで拡大"}
            </p>
          </div>

          <aside className="flex flex-col gap-2 lg:w-[336px] lg:max-h-[560px] lg:shrink-0 lg:overflow-y-auto">
            {loading ? (
              <RoomListSkeleton />
            ) : (
              <>
                <RoomGroupHeading label="いまの部屋" note={`${sensorZones.length}か所`} />
                {sensorZones.map((zone) => (
                  <RoomZoneRow
                    key={zone.key}
                    zone={zone}
                    focused={focusKey === zone.key}
                    onSelect={() =>
                      setFocusKey((current) => (current === zone.key ? null : zone.key))
                    }
                  />
                ))}
                {emptyZones.map((zone) => (
                  <RoomZoneRow
                    key={zone.key}
                    zone={zone}
                    focused={focusKey === zone.key}
                    onSelect={() =>
                      setFocusKey((current) => (current === zone.key ? null : zone.key))
                    }
                  />
                ))}

                <RoomGroupHeading
                  label="掃除"
                  note={cleaningRows.length > 0 ? `${cleaningRows.length}件` : ""}
                />
                {cleaningRows.length > 0 ? (
                  cleaningRows.map(({ zone, task }) => (
                    <RoomCleaningRow
                      key={`${zone.key}-${task.id}`}
                      zoneName={zone.name}
                      task={task}
                      focused={focusKey === zone.key}
                      onSelect={() =>
                        setFocusKey((current) => (current === zone.key ? null : zone.key))
                      }
                    />
                  ))
                ) : (
                  <p className="rounded-2xl border border-dashed px-3.5 py-2.5 text-[11.5px] text-muted-foreground">
                    掃除の予定をまだ場所に紐付けていません。右上の設定から選べます。
                  </p>
                )}
              </>
            )}
          </aside>
        </div>
      </div>

      <RoomLayoutSheet
        open={settingsOpen}
        layout={data.layout}
        devices={data.devices}
        airconUnits={data.airconUnits}
        cleaningTasks={data.cleaning?.tasks ?? []}
        energySources={data.energySources}
        onClose={() => setSettingsOpen(false)}
        onChange={(next) => void handleLayoutChange(next)}
      />
    </div>
  );
}

/**
 * 3Dが描けない端末のための逃げ道。WebGLが無効・使えない環境では `<Canvas>` が
 * 例外を投げ、境界が無いと**画面ごと真っ白になる**（一覧まで読めなくなる）。
 * ここで受け止めて、右の一覧だけでも使えるようにする。
 */
class RoomSceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <RoomStageMessage>
          この端末では3Dを表示できませんでした。右の一覧はそのまま使えます。
        </RoomStageMessage>
      );
    }
    return this.props.children;
  }
}

function RoomStageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}

function RoomGroupHeading({ label, note }: { label: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2 px-1 pt-2">
      <h2 className="text-[13px] font-bold text-foreground">{label}</h2>
      {note ? <span className="ml-auto text-[11.5px] text-muted-foreground">{note}</span> : null}
    </div>
  );
}

function RoomZoneRow({
  zone,
  focused,
  onSelect,
}: {
  zone: ResolvedRoomZone;
  focused: boolean;
  onSelect: () => void;
}) {
  const airconOn = zone.aircon != null && !isAirconPowerOff(zone.aircon.power);
  const hasSensor = zone.deviceId != null && zone.temperature != null;

  const meta: string[] = [];
  if (zone.humidity != null) meta.push(`湿度 ${Math.round(zone.humidity)}％`);
  if (zone.light) meta.push(`照明 ${zone.light.status === "on" ? "点灯" : "消灯"}`);
  if (zone.aircon) {
    meta.push(
      airconOn
        ? `${formatAirconMode(zone.aircon.mode)} ${zone.aircon.target_temperature ?? "--"}℃`
        : "エアコン停止中"
    );
  }
  if (zone.appliances.length > 0) {
    const activeAppliances = zone.appliances.filter((appliance) => appliance.active);
    meta.push(
      activeAppliances.length > 0
        ? `${activeAppliances.map((appliance) => appliance.label).join("・")} 動作中`
        : zone.appliances.length === 1
          ? `${zone.appliances[0].label} 待機中`
          : `${zone.appliances.length}台待機中`
    );
  }
  if (meta.length === 0) meta.push(zone.deviceId == null ? "センサーなし" : "記録がありません");

  const stripe = hasSensor
    ? roomTemperatureColor(zone.temperature as number)
    : airconOn
      ? getAirconModeColor(zone.aircon?.mode)
      : "transparent";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={focused}
      className={`flex w-full items-center gap-3 rounded-2xl border bg-card px-3.5 py-3 text-left shadow-sm transition-colors ${
        focused ? "border-[var(--temp-color)]" : "border-transparent"
      } ${hasSensor ? "" : "opacity-70"}`}
    >
      <span
        className="h-9 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: stripe }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-bold text-foreground">{zone.name}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">
          {meta.join(" ・ ")}
        </span>
      </span>
      {hasSensor ? (
        <span className="shrink-0 text-[21px] font-semibold tabular-nums tracking-tight text-foreground">
          {(zone.temperature as number).toFixed(1)}
          <span className="ml-0.5 text-[12px] font-medium text-muted-foreground">℃</span>
        </span>
      ) : (
        <span className="shrink-0 text-[11.5px] text-muted-foreground">--</span>
      )}
    </button>
  );
}

function RoomCleaningRow({
  zoneName,
  task,
  focused,
  onSelect,
}: {
  zoneName: string;
  task: CleaningTask;
  focused: boolean;
  onSelect: () => void;
}) {
  const color = ROOM_CLEANING_STATUS_COLORS[task.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={focused}
      className={`flex w-full items-center gap-3 rounded-2xl border bg-card px-3.5 py-3 text-left shadow-sm transition-colors ${
        focused ? "border-[var(--temp-color)]" : "border-transparent"
      }`}
    >
      <span
        className="h-9 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-bold text-foreground">{task.name}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">{zoneName}</span>
      </span>
      <span
        className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
      >
        {formatCleaningCountdown(task)}
      </span>
    </button>
  );
}

/**
 * 一覧の読み込み表示。**実データと同じ行の高さ・同じ枚数**にして、
 * 到着したときに一覧の丈が変わらないようにする（#329）。
 */
function RoomListSkeleton() {
  return (
    <div className="skeleton-delayed">
      <div className="flex animate-pulse flex-col gap-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-[62px] rounded-2xl bg-card" />
        ))}
      </div>
    </div>
  );
}
