"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Zap } from "lucide-react";
import { AppLoadingScreen } from "@/components/app-loading-screen";
import { LoginScreen } from "@/components/login-screen";
import { PowerDailyChart } from "@/components/power-daily-chart";
import { EnergyBarChartSkeleton, EnergySkeletonFrame } from "@/components/power-skeleton";
import { fetchEnergyBreakdown } from "@/lib/api";
import { AuthError } from "@/lib/auth";
import {
  ENERGY_DAILY_CHART_HISTORY_DAYS,
  ENERGY_RECENT_DAYS,
  buildEnergyFilterItems,
  buildEnergySourceColors,
  buildEnergyStackColumnsFrom,
  buildEnergyStackSegments,
  energyRowRatio,
  filterEnergyDailyBySources,
  formatEnergyDateWithWeekday,
  formatKwh,
  formatYen,
  orderEnergySourcesForColors,
  shiftEnergyDate,
  sumEnergyBySource,
  type EnergyFilterItem,
} from "@/lib/energy";
import { resolveAuthGate, useAuthState } from "@/lib/use-auth";
import type { EnergyBreakdown } from "@/lib/types";

type ViewRange = { start: string; end: string } | null;

/** 推移ページの棒の高さ（px）。詳細シート（110px）より高くして読みやすくする */
const CHART_HEIGHT = 190;

/**
 * 消費電力の推移ページ（`/energy`・#822）。
 *
 * 詳細シートは直近30日を固定で描き、過去へ遡るのはこのページに任せる。日別の積み上げを
 * 左右にスクロールして1年前まで見られ、機器ごとに表示・非表示を切り替えられる。
 * **チェックの状態は保存しない**（ダッシュボードの表示設定 `hidden_devices` とは別物）。
 */
export function EnergyHistoryPage() {
  const { isAuthenticated, setIsAuthenticated } = useAuthState();
  const [breakdown, setBreakdown] = useState<EnergyBreakdown | null>(null);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [range, setRange] = useState<ViewRange>(null);

  useEffect(() => {
    if (isAuthenticated !== true) return;
    let cancelled = false;
    fetchEnergyBreakdown(ENERGY_DAILY_CHART_HISTORY_DAYS)
      .then((data) => {
        if (!cancelled) setBreakdown(data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthError) setIsAuthenticated(false);
        else setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, setIsAuthenticated]);

  const todayIso = breakdown?.this_month.end ?? null;
  const sources = useMemo(() => breakdown?.sources ?? [], [breakdown]);
  const daily = useMemo(
    () => [...(breakdown?.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [breakdown]
  );
  // 詳細シート（30日ぶん）と同じ色になるよう、直近に記録のある機器から配色する
  const colors = useMemo(
    () =>
      todayIso
        ? buildEnergySourceColors(
            orderEnergySourcesForColors(sources, shiftEnergyDate(todayIso, -(ENERGY_RECENT_DAYS - 1)))
          )
        : {},
    [sources, todayIso]
  );
  const filterItems = useMemo(
    () => buildEnergyFilterItems(sources, daily, colors),
    [sources, daily, colors]
  );
  const filteredDaily = useMemo(() => filterEnergyDailyBySources(daily, hidden), [daily, hidden]);
  // 毎レンダー作り直すと、グラフが見えている範囲を読み直すたびに親の範囲が更新され続ける
  const columns = useMemo(
    () => buildEnergyStackColumnsFrom(filteredDaily, sources, colors),
    [filteredDaily, sources, colors]
  );

  const handleViewChange = (next: ViewRange) => {
    setRange((current) =>
      current?.start === next?.start && current?.end === next?.end ? current : next
    );
  };

  const authGate = resolveAuthGate(isAuthenticated);
  if (authGate === "loading") return <AppLoadingScreen />;
  if (authGate === "login") return <LoginScreen />;

  const inRange = (date: string) => !range || (date >= range.start && date <= range.end);
  const visibleDays = filteredDaily.filter((day) => day.kwh > 0 && inRange(day.date));
  const visibleKwh = visibleDays.reduce((sum, day) => sum + day.kwh, 0);
  const visibleCost = visibleDays.reduce((sum, day) => sum + day.cost_yen, 0);
  // 外した機器の値も一覧に薄く出すので、絞り込む前の日別から数える
  const totalsBySource = sumEnergyBySource(daily, range);
  const filtered = hidden.size > 0;

  const historyStart = todayIso
    ? shiftEnergyDate(todayIso, -(ENERGY_DAILY_CHART_HISTORY_DAYS - 1))
    : null;
  const startNote =
    historyStart && columns[0] && columns[0].date <= historyStart
      ? "これより前は表示していません"
      : "ここより前の記録はありません";

  const toggle = (source: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };
  const showOnly = (source: string) => {
    setHidden(new Set(filterItems.map((item) => item.source).filter((key) => key !== source)));
  };
  const showAll = () => setHidden(new Set());

  const rowsNewestFirst = [...visibleDays].reverse();

  return (
    <div className="mx-auto w-full max-w-[480px] pb-10 md:max-w-[1180px]">
      <div className="space-y-5 px-4 pt-12 md:px-6">
        <header className="flex items-center gap-3">
          <Link
            href="/"
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="ダッシュボードへ戻る"
          >
            <ArrowLeft className="size-5" strokeWidth={1.75} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Zap className="size-5 text-[var(--energy-color)]" />
              <h1 className="text-lg font-bold">消費電力の推移</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              機器を選んで、過去の使用量を比べられます
            </p>
          </div>
        </header>

        {error ? (
          <p className="py-10 text-center text-sm text-destructive">
            使用量を取得できませんでした
          </p>
        ) : !breakdown ? (
          <div className="rounded-[18px] bg-card p-4">
            <EnergySkeletonFrame>
              <EnergyBarChartSkeleton bars={30} />
            </EnergySkeletonFrame>
          </div>
        ) : daily.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            まだ使用量を受け取っていません
          </p>
        ) : (
          <div className="flex flex-col gap-4 md:grid md:grid-cols-[minmax(0,1fr)_300px] md:items-start">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="flex flex-col gap-3 rounded-[18px] bg-card p-4">
                <div className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                  <span className="text-xl font-bold">{formatKwh(visibleKwh)}</span>
                  <span className="text-sm text-muted-foreground">
                    {filtered ? "約" : ""}
                    {formatYen(visibleCost)}
                  </span>
                  {filtered && (
                    <span className="text-[11px] text-muted-foreground">
                      （選んだ機器だけの合計）
                    </span>
                  )}
                </div>

                <FilterChips
                  items={filterItems}
                  hidden={hidden}
                  onToggle={toggle}
                  className="md:hidden"
                />

                {columns.length === 0 ? (
                  <p
                    className="flex items-center justify-center text-sm text-muted-foreground"
                    style={{ height: CHART_HEIGHT + 50 }}
                  >
                    表示する機器を選んでください
                  </p>
                ) : (
                  <PowerDailyChart
                    columns={columns}
                    startNote={startNote}
                    height={CHART_HEIGHT}
                    onViewChange={handleViewChange}
                  />
                )}
                <p className="text-[11px] text-muted-foreground">
                  左右にスクロールすると過去の日へ移動します（最大1年）
                </p>
              </section>

              <section className="flex flex-col gap-1.5 rounded-[18px] bg-card p-4">
                <div className="flex justify-between text-[11.5px] text-muted-foreground">
                  <span className="font-bold text-foreground">日別（表示中の範囲）</span>
                  <span>kWh / 円</span>
                </div>
                {rowsNewestFirst.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    この範囲の記録はありません
                  </p>
                ) : (
                  rowsNewestFirst.map((row) => (
                    <div key={row.date} className="flex items-center gap-2.5 text-[13px] tabular-nums">
                      <span className="w-[68px] shrink-0 text-muted-foreground">
                        {formatEnergyDateWithWeekday(row.date)}
                      </span>
                      <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="flex h-full"
                          style={{
                            width: `${Math.max(4, energyRowRatio(rowsNewestFirst, row) * 100)}%`,
                          }}
                        >
                          {buildEnergyStackSegments(row, sources, colors).map((segment) => (
                            <span
                              key={segment.source}
                              className="block h-full min-w-px"
                              style={{
                                width: `${segment.share * 100}%`,
                                backgroundColor: segment.color,
                              }}
                            />
                          ))}
                        </span>
                      </span>
                      <span className="w-[62px] shrink-0 text-right font-bold">
                        {formatKwh(row.kwh)}
                      </span>
                      <span className="w-12 shrink-0 text-right text-muted-foreground">
                        {formatYen(row.cost_yen)}
                      </span>
                    </div>
                  ))
                )}
              </section>
            </div>

            <section className="flex flex-col rounded-[18px] bg-card p-4">
              <div className="flex items-baseline justify-between pb-1">
                <h2 className="text-[13px] font-bold">表示する機器</h2>
                <button
                  type="button"
                  onClick={showAll}
                  disabled={!filtered}
                  className="text-[11.5px] font-bold text-[var(--energy-color)] disabled:opacity-30"
                >
                  すべて表示
                </button>
              </div>
              {filterItems.map((item) => {
                const on = !hidden.has(item.source);
                const kwh = totalsBySource[item.source] ?? 0;
                return (
                  <div
                    key={item.source}
                    className="flex items-center gap-2.5 border-t py-2 text-[13px] first-of-type:border-t-0"
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle(item.source)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span
                        className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-2 ${
                          on ? "border-transparent text-white" : "border-muted-foreground"
                        }`}
                        style={on ? { backgroundColor: item.color } : undefined}
                        aria-hidden
                      >
                        {on && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className={`min-w-0 flex-1 truncate ${on ? "" : "opacity-40"}`}>
                        {item.label}
                      </span>
                      <span
                        className={`w-[70px] shrink-0 text-right font-bold tabular-nums ${on ? "" : "opacity-40"}`}
                      >
                        {formatKwh(kwh)}
                      </span>
                      <span className="w-9 shrink-0 text-right text-[11.5px] text-muted-foreground tabular-nums">
                        {on && visibleKwh > 0 ? `${Math.round((kwh / visibleKwh) * 100)}%` : "—"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => showOnly(item.source)}
                      className="shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-bold text-muted-foreground hover:bg-accent"
                      aria-label={`${item.label}だけを表示`}
                    >
                      だけ
                    </button>
                  </div>
                );
              })}
              <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
                「だけ」でその機器以外を外します。外した機器は棒からも合計からも抜けます。
                機器ごとの金額は持っていないため、絞り込み中の金額は使用量の割合で按分した目安です。
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChips({
  items,
  hidden,
  onToggle,
  className = "",
}: {
  items: EnergyFilterItem[];
  hidden: ReadonlySet<string>;
  onToggle: (source: string) => void;
  className?: string;
}) {
  return (
    <div
      className={`-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {items.map((item) => {
        const on = !hidden.has(item.source);
        return (
          <button
            key={item.source}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onToggle(item.source)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold ${
              on ? "border-transparent bg-[var(--energy-surface)]" : "text-muted-foreground"
            }`}
          >
            <span
              className={`size-2 rounded-[3px] ${on ? "" : "border-[1.5px] border-muted-foreground"}`}
              style={on ? { backgroundColor: item.color } : undefined}
              aria-hidden
            />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
