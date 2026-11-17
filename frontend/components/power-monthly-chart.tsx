import { formatEnergyMonthLabel, formatKwh, type EnergyMonthlyColumn } from "@/lib/energy";

interface PowerMonthlyChartProps {
  /** 古い月 → 新しい月の順 */
  columns: EnergyMonthlyColumn[];
}

/** 詳細パネルの月別積み上げ棒グラフ。比較対象は当月と過去11か月（#872）。 */
export function PowerMonthlyChart({ columns }: PowerMonthlyChartProps) {
  if (columns.length === 0) return null;
  const first = columns[0];
  const last = columns[columns.length - 1];
  const middle = columns[Math.floor((columns.length - 1) / 2)];
  const totalKwh = columns.reduce((sum, column) => sum + column.kwh, 0);

  return (
    <div className="flex flex-col gap-2 rounded-2xl border px-3 pb-2 pt-2.5">
      <div className="flex min-h-6 items-center justify-between gap-2 text-xs tabular-nums">
        <span className="min-w-0">
          <span className="font-bold">月別（過去12か月）</span>{" "}
          <span className="text-muted-foreground">
            {formatEnergyMonthLabel(first.month)}〜{formatEnergyMonthLabel(last.month)}
          </span>
        </span>
        <span className="shrink-0 font-bold">{formatKwh(totalKwh)}</span>
      </div>
      <div className="flex h-[140px] items-end gap-[5px]">
        {columns.map((column) => (
          <div
            key={column.month}
            className="flex min-w-0 flex-1 flex-col justify-end gap-[1.5px]"
            style={{ height: `${Math.max(4, column.ratio * 100)}%` }}
            title={`${formatEnergyMonthLabel(column.month)} ${formatKwh(column.kwh)}`}
          >
            {column.segments.map((segment) => (
              <span
                key={segment.source}
                className="block min-h-px rounded-[1.5px]"
                style={{ height: `${segment.share * 100}%`, backgroundColor: segment.color }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-between border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
        <span>{formatEnergyMonthLabel(first.month)}</span>
        {columns.length > 2 && <span>{formatEnergyMonthLabel(middle.month)}</span>}
        <span>{formatEnergyMonthLabel(last.month)}</span>
      </div>
    </div>
  );
}
