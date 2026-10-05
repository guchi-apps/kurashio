"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { fetchEnergyHourly, fetchEnergySummary, importKepcoCsv, updateUiSettings } from "@/lib/api";
import { EnergyDateCalendar } from "@/components/energy-date-calendar";
import { EnergyRefetchSheet } from "@/components/energy-refetch-sheet";
import { EnergySourceNameSheet } from "@/components/energy-source-name-sheet";
import { PowerSourceDetail } from "@/components/power-source-detail";
import { SettingsIconButton } from "@/components/ui/settings-icon-button";
import {
  EnergyBarChartSkeleton,
  EnergyListSkeleton,
  EnergySkeletonFrame,
} from "@/components/power-skeleton";
import {
  KEPCO_MIRUDEN_DOWNLOAD_URL,
  KEPCO_OTHER_COLOR,
  KEPCO_OTHER_LABEL,
  KEPCO_OTHER_SOURCE,
  buildEnergyDailyRows,
  buildEnergyHourlyColumns,
  buildEnergySourceColors,
  buildEnergyStackColumns,
  buildEnergyStackSegments,
  energyRowRatio,
  formatEnergyDate,
  formatEnergyDateWithWeekday,
  formatEnergyHour,
  formatKwh,
  formatYen,
  hasEnergyKepcoOther,
  pickRenamableEnergySources,
  shiftEnergyDate,
} from "@/lib/energy";
import type {
  EnergyBreakdown,
  EnergyHourly,
  EnergyKepcoImportResult,
  EnergySourceSummary,
  EnergyTotal,
} from "@/lib/types";

interface PowerDetailPanelProps {
  open: boolean;
  breakdown: EnergyBreakdown | null;
  onClose: () => void;
  /** 単価を保存したあと。集計をやり直すために親へ知らせる */
  onUnitPriceSaved: (unitPrice: number) => void;
  /** KEPCOのCSVを取り込んだあと。日別の集計を取り直すために親へ知らせる（#319） */
  onKepcoImported: () => void;
  /** 取得元の名前を保存したあと。ラベルを付け直すために親へ知らせる（#335） */
  onSourceNamesSaved: () => void;
}

/** 「その他」が何かの説明。日別・時間ごとのどちらの一覧の下にも同じものを出す（#319） */
function KepcoOtherNote() {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      <span
        className="mr-1 inline-block size-2 rounded-[2px] align-middle"
        style={{ backgroundColor: KEPCO_OTHER_COLOR }}
        aria-hidden
      />
      {KEPCO_OTHER_LABEL} = KEPCO実測（家全体）− エアコン・スマートプラグ実測
    </p>
  );
}

export function Tile({ caption, total }: { caption: string; total: EnergyTotal }) {
  return (
    <div className="rounded-2xl bg-muted px-3 py-2.5">
      <div className="text-[11px] leading-tight text-muted-foreground">
        {caption}
        <br />
        <span className="text-[10px]">
          {formatEnergyDate(total.start)}〜{formatEnergyDate(total.end)}
        </span>
      </div>
      <div className="mt-0.5 text-[18px] font-bold leading-tight tracking-tight tabular-nums">
        {formatYen(total.cost_yen)}
      </div>
      <div className="text-[11.5px] text-muted-foreground tabular-nums">
        {formatKwh(total.kwh)}
      </div>
    </div>
  );
}

/**
 * 消費電力カードの詳細。
 *
 * 日別は取得元ごとの積み上げにする。合計だけだと「今月増えた」までしか分からず、
 * 増えたのがエアコンなのかどのプラグなのかが読めないため。
 */
export function PowerDetailPanel({
  open,
  breakdown,
  onClose,
  onUnitPriceSaved,
  onKepcoImported,
  onSourceNamesSaved,
}: PowerDetailPanelProps) {
  // 親が `open` のときだけマウントするため、初期値をここで決めれば開くたびに入れ直される
  const [priceInput, setPriceInput] = useState(() =>
    breakdown ? String(breakdown.unit_price) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const todayIso = breakdown?.this_month.end ?? null;
  const [tab, setTab] = useState<"daily" | "hourly">("daily");
  const [hourlyDate, setHourlyDate] = useState<string | null>(() => todayIso);
  const [hourly, setHourly] = useState<EnergyHourly | null>(null);
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [hourlyError, setHourlyError] = useState<string | null>(null);
  // 日付を押すと開くカレンダー（#330）。離れた日へ矢印で何度も送らずに済ませるため
  const [calendarOpen, setCalendarOpen] = useState(false);
  // 取得元（スマートプラグ）の名前を変えるシート（#335）
  const [nameSheetOpen, setNameSheetOpen] = useState(false);
  const [refetchSheetOpen, setRefetchSheetOpen] = useState(false);

  useEffect(() => {
    if (tab !== "hourly" || !hourlyDate) return;
    let cancelled = false;
    setHourlyLoading(true);
    setHourlyError(null);
    fetchEnergyHourly(hourlyDate)
      .then((data) => {
        if (!cancelled) setHourly(data);
      })
      .catch(() => {
        if (!cancelled) setHourlyError("時間ごとのデータを取得できませんでした");
      })
      .finally(() => {
        if (!cancelled) setHourlyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, hourlyDate]);

  // KEPCO「みるでん」の時間ごとCSVの取り込み（#302）。
  // 取り込んだ値は時間ごと・日別の両方の「その他」の元になるため、
  // 導線はタブに寄せず、どちらのタブを開いていても押せる位置に置く（#319）。
  const kepcoFileInputRef = useRef<HTMLInputElement>(null);
  const [kepcoUploading, setKepcoUploading] = useState(false);
  const [kepcoError, setKepcoError] = useState<string | null>(null);
  const [kepcoResult, setKepcoResult] = useState<EnergyKepcoImportResult | null>(null);

  const handleKepcoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルを続けて選び直せるようにする
    if (!file) return;
    setKepcoUploading(true);
    setKepcoError(null);
    setKepcoResult(null);
    try {
      const result = await importKepcoCsv(file);
      setKepcoResult(result);
      // 日別（親が持つ breakdown）と時間ごとの両方を取り直す。
      // どちらのタブから取り込んでも、閉じずにもう一方へ切り替えれば反映済みになる。
      onKepcoImported();
      if (hourlyDate) {
        const refreshed = await fetchEnergyHourly(hourlyDate);
        setHourly(refreshed);
      }
    } catch (err) {
      setKepcoError(err instanceof Error ? err.message : "CSVを取り込めませんでした");
    } finally {
      setKepcoUploading(false);
    }
  };

  // デバイスをクリックしたときに開く、そのデバイス単体の推移
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourceSummary, setSourceSummary] = useState<EnergySourceSummary | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  /**
   * 一度取れたデバイスの推移を、シートを開いているあいだ覚えておく（#329）。
   * 別のデバイスを見てから戻ったときに読み込み表示を挟まないためだけのもので、
   * 裏では毎回取り直す（表示は取れた時点で差し替わる）。
   */
  const sourceSummaryCache = useRef(new Map<string, EnergySourceSummary>());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedSource) return;
    let cancelled = false;
    // 一覧の途中までスクロールした状態から押されるので、先頭へ戻してから出す
    scrollRef.current?.scrollTo({ top: 0 });
    setSourceSummary(sourceSummaryCache.current.get(selectedSource) ?? null);
    setSourceLoading(true);
    setSourceError(false);
    fetchEnergySummary(selectedSource, 30)
      .then((data) => {
        sourceSummaryCache.current.set(selectedSource, data);
        if (!cancelled) setSourceSummary(data);
      })
      .catch(() => {
        if (!cancelled) setSourceError(true);
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSource]);

  if (!open) return null;

  const sources = breakdown?.sources ?? [];
  const colors = buildEnergySourceColors(sources);
  const columns = buildEnergyStackColumns(breakdown);
  const rows = buildEnergyDailyRows(breakdown?.daily ?? []);
  const hourlyColumns = buildEnergyHourlyColumns(hourly, sources, colors);
  const hourlyRows = hourlyColumns.filter((column) => column.kwh != null);
  const dailyHasKepcoOther = hasEnergyKepcoOther(breakdown?.daily ?? []);
  const selectedRow = sources.find((row) => row.source === selectedSource) ?? null;

  // 名前を変えられるのはスマートプラグだけ（#335）。エアコンの名前は「いまの環境の設定」が持つ
  const renamableSources = pickRenamableEnergySources(sources);
  const plugCount = renamableSources.length;
  const hasAircon = sources.some((row) => row.source === "aircon");
  const subtitle = [
    hasAircon ? "エアコン" : null,
    plugCount > 0 ? `Tapo スマートプラグ ${plugCount} 台` : null,
  ]
    .filter(Boolean)
    .join(" ・ ");

  const handleSave = async () => {
    const price = Number(priceInput);
    if (!Number.isFinite(price) || price <= 0) {
      setError("単価は0より大きい数値で入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const settings = await updateUiSettings({ energy_unit_price: price });
      onUnitPriceSaved(settings.energy_unit_price);
    } catch {
      setError("単価を保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex min-h-0 max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[88vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-1">
            {selectedSource && (
              <button
                type="button"
                onClick={() => setSelectedSource(null)}
                className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent"
                aria-label="消費電力の詳細に戻る"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <div className="min-w-0">
              {selectedSource ? (
                <h2 className="flex items-center gap-1.5 truncate text-lg font-bold">
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: colors[selectedSource] ?? "#95a5a6" }}
                    aria-hidden
                  />
                  <span className="truncate">
                    {selectedRow?.label ?? selectedSource}
                  </span>
                </h2>
              ) : (
                <h2 className="truncate text-lg font-bold">消費電力</h2>
              )}
              <p className="text-xs text-muted-foreground">
                {selectedSource ? "使用量の推移" : subtitle || "取得元なし"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {/*
              取得元の名前の設定（#335）。消費電力カードはカード全体が詳細を開くボタンで、
              見出しの中にボタンを置けないため、入口はこのヘッダー1か所に持つ。
              機器を1つ選んだあと（推移の画面）は、その場の設定ではないので出さない。
            */}
            {/* 指定日以降の再取得（#711）。設定ではないので歯車とは別のアイコンにする */}
            {!selectedSource && todayIso && (
              <button
                type="button"
                onClick={() => setRefetchSheetOpen(true)}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="データの再取得"
                title="データの再取得"
              >
                <RefreshCw className="size-[18px]" strokeWidth={1.75} />
              </button>
            )}
            {!selectedSource && plugCount > 0 && (
              <SettingsIconButton
                label="取得元の名前"
                onClick={() => setNameSheetOpen(true)}
              />
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent"
              aria-label="閉じる"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [-webkit-overflow-scrolling:touch]"
        >
          {selectedSource ? (
            <PowerSourceDetail
              label={selectedRow?.label ?? selectedSource}
              color={colors[selectedSource] ?? "#95a5a6"}
              summary={sourceSummary}
              loading={sourceLoading}
              error={sourceError}
              placeholderRows={breakdown?.daily.length}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {breakdown && (
                <div className="grid grid-cols-3 gap-2">
                  <Tile
                    caption="今月"
                    total={breakdown.this_month}
                  />
                  <Tile caption="先月同日まで" total={breakdown.last_month_to_date} />
                  <Tile caption="先月" total={breakdown.last_month} />
                </div>
              )}

            <div className="flex w-fit gap-1 rounded-full bg-muted p-[3px]">
              <button
                type="button"
                onClick={() => setTab("daily")}
                className={`rounded-full px-3.5 py-1 text-xs font-bold ${
                  tab === "daily"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                日別
              </button>
              <button
                type="button"
                onClick={() => setTab("hourly")}
                className={`rounded-full px-3.5 py-1 text-xs font-bold ${
                  tab === "hourly"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                時間ごと
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <input
                ref={kepcoFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => void handleKepcoFileChange(e)}
              />
              <button
                type="button"
                onClick={() => kepcoFileInputRef.current?.click()}
                disabled={kepcoUploading}
                className="flex items-center gap-1.5 rounded-xl border border-dashed border-[var(--energy-color)] bg-[var(--energy-surface)] px-3 py-2 text-left text-[11.5px] font-bold text-[var(--energy-color)] disabled:opacity-60"
              >
                <Upload className="size-3.5 shrink-0" />
                {kepcoUploading ? "取り込み中..." : "KEPCOの明細（CSV）を取り込む"}
              </button>
              <a
                href={KEPCO_MIRUDEN_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="flex w-fit items-center gap-1 text-[11px] font-bold text-muted-foreground underline underline-offset-2"
              >
                <ExternalLink className="size-3 shrink-0" />
                KEPCO「みるでん」でCSVをダウンロード
              </a>
              {kepcoResult && (
                <p className="text-[11px] text-muted-foreground">
                  {kepcoResult.imported_days}日分・{kepcoResult.imported_rows}件を取り込みました
                  {kepcoResult.period_start && kepcoResult.period_end
                    ? `（${formatEnergyDate(kepcoResult.period_start)}〜${formatEnergyDate(kepcoResult.period_end)}）`
                    : ""}
                </p>
              )}
              {kepcoError && <p className="text-[11px] text-destructive">{kepcoError}</p>}
            </div>

            {tab === "hourly" && hourlyDate && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[13px] font-bold">
                  <button
                    type="button"
                    onClick={() => setHourlyDate(shiftEnergyDate(hourlyDate, -1))}
                    className="flex size-7 items-center justify-center rounded-full bg-muted"
                    aria-label="前の日"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCalendarOpen(true)}
                      aria-label={`日付を選ぶ（いまは${formatEnergyDateWithWeekday(hourlyDate)}）`}
                      className="flex items-center gap-1.5 rounded-full border bg-muted py-1 pl-2.5 pr-3 tabular-nums hover:bg-accent"
                    >
                      <CalendarDays className="size-3.5 shrink-0" />
                      {formatEnergyDateWithWeekday(hourlyDate)}
                    </button>
                    {todayIso === hourlyDate && (
                      <span className="rounded-full bg-[var(--energy-surface)] px-1.5 py-px text-[10px] font-bold text-[var(--energy-color)]">
                        今日
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setHourlyDate(shiftEnergyDate(hourlyDate, 1))}
                    disabled={!todayIso || hourlyDate >= todayIso}
                    className="flex size-7 items-center justify-center rounded-full bg-muted disabled:opacity-35"
                    aria-label="次の日"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>

                {hourlyLoading ? (
                  // 日を切り替えるたびに文字1行まで縮むと同じちらつきになるため、
                  // 実データと同じ骨格を出して高さを保つ（#329）
                  <EnergySkeletonFrame className="gap-2">
                    <EnergyBarChartSkeleton bars={24} />
                    <EnergyListSkeleton rows={10} labelWidth="w-11" trailing={false} />
                  </EnergySkeletonFrame>
                ) : hourlyError ? (
                  <p className="py-6 text-center text-sm text-destructive">{hourlyError}</p>
                ) : !hourly?.has_data ? (
                  <div className="flex flex-col items-center gap-1 rounded-2xl bg-muted px-4 py-7 text-center">
                    <span className="text-[13px] font-bold">
                      この日の時間ごとの記録はありません
                    </span>
                    <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                      時間ごとの記録は、この機能をリリースした日から先の分だけ残ります。
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex h-[110px] items-end gap-[2px]">
                      {hourlyColumns.map((column) => (
                        <div
                          key={column.hour}
                          className="flex min-w-0 flex-1 flex-col justify-end gap-px"
                          style={{ height: `${Math.max(column.kwh == null ? 0 : 4, column.ratio * 100)}%` }}
                          title={
                            column.kwh == null
                              ? `${formatEnergyHour(column.hour)}台 記録なし`
                              : `${formatEnergyHour(column.hour)}台 ${formatKwh(column.kwh)}`
                          }
                        >
                          {column.segments.map((segment) => (
                            <span
                              key={segment.source}
                              className="block min-h-px rounded-[1.5px]"
                              style={{
                                height: `${segment.share * 100}%`,
                                backgroundColor: segment.color,
                              }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
                      <span>0時</span>
                      <span>12時</span>
                      <span>24時</span>
                    </div>

                    <div className="flex flex-col gap-1.5 pt-1">
                      {hourlyRows.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                          まだ記録がありません
                        </p>
                      ) : (
                        hourlyRows.map((row) => (
                          <div
                            key={row.hour}
                            className="flex items-center gap-2.5 text-[13px] tabular-nums"
                          >
                            <span className="w-11 shrink-0 text-muted-foreground">
                              {formatEnergyHour(row.hour)}
                            </span>
                            <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                              <span
                                className="flex h-full"
                                style={{ width: `${Math.max(4, row.ratio * 100)}%` }}
                              >
                                {row.segments.map((segment) => (
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
                          </div>
                        ))
                      )}
                    </div>

                    {hourly?.sources.includes(KEPCO_OTHER_SOURCE) && <KepcoOtherNote />}
                  </>
                )}
              </div>
            )}

            {tab === "daily" && columns.length > 1 && (
              <div className="flex flex-col gap-2">
                <div className="flex h-[110px] items-end gap-[3px]">
                  {columns.map((column) => (
                    <div
                      key={column.date}
                      className="flex min-w-0 flex-1 flex-col justify-end gap-[1.5px]"
                      style={{ height: `${Math.max(4, column.ratio * 100)}%` }}
                      title={`${formatEnergyDate(column.date)} ${formatKwh(column.kwh)}`}
                    >
                      {column.segments.map((segment) => (
                        <span
                          key={segment.source}
                          className="block min-h-px rounded-[1.5px]"
                          style={{
                            height: `${segment.share * 100}%`,
                            backgroundColor: segment.color,
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="flex justify-between border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
                  <span>{formatEnergyDate(columns[0].date)}</span>
                  <span>日別（記録のある日だけ）</span>
                  <span>{formatEnergyDate(columns[columns.length - 1].date)}</span>
                </div>
              </div>
            )}

            {sources.length > 0 && (
              <div className="flex flex-wrap gap-x-1 gap-y-1 text-xs text-muted-foreground">
                {sources.map((row) => (
                  <button
                    key={row.source}
                    type="button"
                    onClick={() => setSelectedSource(row.source)}
                    className="-mx-1 flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`${row.label}の使用量推移を見る`}
                  >
                    <span
                      className="size-2 rounded-[3px]"
                      style={{ backgroundColor: colors[row.source] ?? "#95a5a6" }}
                      aria-hidden
                    />
                    {row.label}
                    <span className="tabular-nums">
                      {row.this_month_kwh.toFixed(1)} kWh
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold">電気料金の単価</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  aria-label="電気料金の単価（円/kWh）"
                  className="w-24 rounded-xl border bg-card px-2.5 py-1.5 text-right text-sm font-bold tabular-nums"
                />
                <span className="text-xs text-muted-foreground">円/kWh</span>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="ml-auto rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                エアコンの金額は白くまくんアプリが返す実額をそのまま使うため、この単価の影響を受けません。単価を掛けた目安になるのは、使用量（kWh）しか返さないスマートプラグなどです。
              </p>
            </div>

            {tab === "daily" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[11.5px] text-muted-foreground">
                  <span>日別（直近{rows.length}日）</span>
                  <span>kWh / 円</span>
                </div>
                {rows.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    まだ使用量を受け取っていません
                  </p>
                ) : (
                  rows.map((row) => (
                    <div
                      key={row.date}
                      className="flex items-center gap-2.5 text-[13px] tabular-nums"
                    >
                      <span className="w-[68px] shrink-0 text-muted-foreground">
                        {formatEnergyDateWithWeekday(row.date)}
                      </span>
                      <span className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="flex h-full"
                          style={{ width: `${Math.max(4, energyRowRatio(rows, row) * 100)}%` }}
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
                {dailyHasKepcoOther && <KepcoOtherNote />}
              </div>
            )}
            </div>
          )}
        </div>
      </div>

      {/* 開いているあいだだけ描く。表示する月は value から作られるため（#330） */}
      {calendarOpen && hourlyDate && (
        <EnergyDateCalendar
          key={hourlyDate}
          value={hourlyDate}
          today={todayIso}
          onSelect={(date) => {
            setHourlyDate(date);
            setCalendarOpen(false);
          }}
          onClose={() => setCalendarOpen(false)}
        />
      )}

      {refetchSheetOpen && todayIso && (
        <EnergyRefetchSheet
          today={todayIso}
          onClose={() => setRefetchSheetOpen(false)}
          onCompleted={onKepcoImported}
        />
      )}

      {/* 開いているあいだだけ描く。下書きは sources から作られるため（#335） */}
      {nameSheetOpen && (
        <EnergySourceNameSheet
          sources={renamableSources}
          colors={colors}
          onClose={() => setNameSheetOpen(false)}
          onSave={async (names) => {
            await updateUiSettings({ energy_source_names: names });
            onSourceNamesSaved();
          }}
        />
      )}
    </div>
  );
}
