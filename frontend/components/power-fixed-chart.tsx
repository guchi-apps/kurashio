import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatEnergyDate, formatKwh, type EnergyStackColumn } from "@/lib/energy";

/** 推移ページ（#822）。詳細シートのグラフから開く */
export const ENERGY_HISTORY_PAGE_HREF = "/energy";

interface PowerFixedChartProps {
  /** 古い日 → 新しい日の順。詳細シートでは親の30日ぶん */
  columns: EnergyStackColumn[];
}

/**
 * 詳細シートの日別グラフ。直近30日を幅いっぱいに固定で描く（#822）。
 *
 * シートの中で横スクロールさせると狭いうえに縦のスクロールと取り合うため、
 * 過去へ遡るのは推移ページ（`/energy`）に任せ、グラフ全体をそこへのリンクにする。
 */
export function PowerFixedChart({ columns }: PowerFixedChartProps) {
  if (columns.length === 0) return null;
  const first = columns[0];
  const last = columns[columns.length - 1];
  const middle = columns[Math.floor((columns.length - 1) / 2)];
  const totalKwh = columns.reduce((sum, column) => sum + column.kwh, 0);

  return (
    <Link
      href={ENERGY_HISTORY_PAGE_HREF}
      aria-label="日別の使用量グラフ。押すと消費電力の推移ページで過去の日まで見られます"
      className="flex flex-col gap-2 rounded-2xl border px-3 pb-2 pt-2.5 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex min-h-6 items-center justify-between gap-2 text-xs tabular-nums">
        <span className="min-w-0">
          <span className="font-bold">直近{columns.length}日</span>{" "}
          <span className="text-muted-foreground">
            {formatEnergyDate(first.date)}〜{formatEnergyDate(last.date)}・{formatKwh(totalKwh)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--energy-surface)] py-0.5 pl-2.5 pr-1.5 text-[11px] font-bold text-[var(--energy-color)]">
          推移を見る
          <ChevronRight className="size-3.5" />
        </span>
      </div>

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
        <span>{formatEnergyDate(first.date)}</span>
        {columns.length > 2 && <span>{formatEnergyDate(middle.date)}</span>}
        <span>{formatEnergyDate(last.date)}</span>
      </div>
    </Link>
  );
}
