"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  buildEnergyDailyTicks,
  energyVisibleColumnRange,
  formatEnergyDate,
  formatKwh,
  type EnergyStackColumn,
} from "@/lib/energy";

/** 棒1本の幅と間隔（px）。画面に入るのはシートの幅で30〜40日ぶん */
const BAR_WIDTH = 9;
const BAR_GAP = 3;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
/** 右端から離れているとみなすまでの余裕（px）。端数のスクロール位置で「最新へ」がちらつかないように */
const END_TOLERANCE = 2;

interface PowerDailyChartProps {
  /** 古い日 → 新しい日の順。`ratio` は全期間の最大値が基準 */
  columns: EnergyStackColumn[];
  /** 左端（いちばん古い棒の左）に出す一言。読み込み中など、まだ言えないときは `null` */
  startNote: string | null;
}

interface ViewState {
  first: number;
  last: number;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * 消費電力の日別の積み上げ棒グラフ。左右にスクロールして過去の日へ移動できる（#810）。
 *
 * 棒の幅は固定で、開いた時点は右端（最新の日）を見せる。左に日が足されても
 * （1年ぶんが届いたとき）右端からの距離を保つので、見ている棒が飛ばない。
 */
export function PowerDailyChart({ columns, startNote }: PowerDailyChartProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const firstBarRef = useRef<HTMLDivElement>(null);
  /** 右端からの距離。棒が増えたときにこの距離を保つ */
  const fromRightRef = useRef(0);
  const dragRef = useRef<{ x: number; left: number } | null>(null);
  // スクロールが1度も起きていない（棒が画面に収まっている）あいだは null で、全期間を見せている扱い
  const [view, setView] = useState<ViewState | null>(null);

  const readView = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxLeft = el.scrollWidth - el.clientWidth;
    fromRightRef.current = Math.max(0, maxLeft - el.scrollLeft);
    const range = energyVisibleColumnRange(
      el.scrollLeft,
      el.clientWidth,
      firstBarRef.current?.offsetLeft ?? 0,
      BAR_STEP,
      columns.length
    );
    setView(
      range
        ? {
            ...range,
            atStart: el.scrollLeft <= END_TOLERANCE,
            atEnd: el.scrollLeft >= maxLeft - END_TOLERANCE,
          }
        : null
    );
  };

  // 棒の数が変わったら、右端からの距離を保つ位置へ置き直す（開いた直後は右端）
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth - el.clientWidth - fromRightRef.current;
  }, [columns.length]);

  // 画面の幅が変わると見えている範囲も変わるが、scroll は来ない
  useEffect(() => {
    window.addEventListener("resize", readView);
    return () => window.removeEventListener("resize", readView);
  });

  const scrollToLatest = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: el.scrollWidth, behavior: reduce ? "auto" : "smooth" });
  };

  // マウスはドラッグでも動かせるようにする（タッチ・トラックパッドは素のスクロールで動く）
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const el = scrollerRef.current;
    if (!el) return;
    dragRef.current = { x: event.clientX, left: el.scrollLeft };
    el.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!dragRef.current || !el) return;
    el.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x);
  };
  const handlePointerEnd = () => {
    dragRef.current = null;
  };

  if (columns.length === 0) return null;

  const ticks = buildEnergyDailyTicks(columns);
  const first = Math.min(view?.first ?? 0, columns.length - 1);
  const last = Math.min(view?.last ?? columns.length - 1, columns.length - 1);
  const visible = columns.slice(first, last + 1);
  const visibleKwh = visible.reduce((sum, column) => sum + column.kwh, 0);
  const atStart = view?.atStart ?? true;
  const atEnd = view?.atEnd ?? true;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2 text-xs tabular-nums">
        <span className="min-w-0">
          <span className="font-bold">
            {formatEnergyDate(columns[first].date)}〜{formatEnergyDate(columns[last].date)}
          </span>{" "}
          <span className="text-muted-foreground">
            記録のある{visible.length}日・{formatKwh(visibleKwh)}
          </span>
        </span>
        <button
          type="button"
          onClick={scrollToLatest}
          aria-hidden={atEnd}
          tabIndex={atEnd ? -1 : 0}
          className={`flex shrink-0 items-center gap-0.5 rounded-full border bg-muted py-0.5 pl-2.5 pr-1.5 text-[11px] font-bold transition-opacity motion-reduce:transition-none ${
            atEnd ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          最新へ
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={readView}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          tabIndex={0}
          role="group"
          aria-label="日別の使用量グラフ。左右にスクロールすると過去の日へ移動します"
          className="overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-webkit-overflow-scrolling:touch] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-scrollbar]:hidden"
        >
          <div className="relative flex w-max min-w-full justify-end gap-[3px]">
            {startNote && (
              <div className="flex h-[110px] shrink-0 items-center whitespace-nowrap pr-2.5 text-[10px] text-muted-foreground">
                {startNote}
              </div>
            )}
            {columns.map((column, index) => {
              const tick = ticks[index];
              return (
                <div
                  key={column.date}
                  ref={index === 0 ? firstBarRef : undefined}
                  className="flex shrink-0 flex-col"
                  style={{ width: BAR_WIDTH }}
                >
                  <div className="flex h-[110px] flex-col justify-end">
                    <div
                      className="flex flex-col justify-end gap-[1.5px]"
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
                  </div>
                  <div className="relative h-[18px]">
                    {tick && (
                      <span
                        className={`absolute top-[5px] whitespace-nowrap text-[10px] tabular-nums ${
                          // 右端の数本は右に寄せる。左寄せのままだと文字がはみ出し、その分だけ右へスクロールできてしまう
                          index >= columns.length - 3 ? "right-0" : "left-0"
                        } ${tick.month ? "font-bold text-foreground" : "text-muted-foreground"}`}
                      >
                        {tick.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="pointer-events-none absolute inset-x-0 top-[110px] border-t" aria-hidden />
          </div>
        </div>
        {/* 続きがある側の端を薄くぼかす */}
        <div
          className={`pointer-events-none absolute left-0 top-0 h-[110px] w-[18px] bg-linear-to-r from-card to-transparent transition-opacity motion-reduce:transition-none ${
            atStart ? "opacity-0" : "opacity-100"
          }`}
          aria-hidden
        />
        <div
          className={`pointer-events-none absolute right-0 top-0 h-[110px] w-[18px] bg-linear-to-l from-card to-transparent transition-opacity motion-reduce:transition-none ${
            atEnd ? "opacity-0" : "opacity-100"
          }`}
          aria-hidden
        />
      </div>
    </div>
  );
}
