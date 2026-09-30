"use client";

import { Droplets, Gauge, Sun, Thermometer, Wind } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import type { MetricReading } from "@/lib/device-metrics";
import { METRIC_COLORS, type ChartMetric } from "@/lib/types";

export const METRIC_ICONS: Record<ChartMetric, LucideIcon> = {
  temperature: Thermometer,
  humidity: Droplets,
  pressure: Gauge,
  co2: Wind,
  illuminance: Sun,
};

interface CurrentReadingsProps {
  readings: readonly MetricReading[];
  /** 何時時点の値かを添える。省略すると見出しだけになる */
  measuredAt?: string | null;
  /** 指定するとタイルが押せるようになり、選択中の指標を枠で示す（#592） */
  selectedMetric?: ChartMetric;
  onSelectMetric?: (metric: ChartMetric) => void;
  /** 押せる指標。省略すると全部押せる。含まれないタイルは押せず薄く出す */
  selectableMetrics?: readonly ChartMetric[];
}

function formatMeasuredAt(value: string): string | null {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 詳細パネルの先頭に置く「いまの値」。
 *
 * ダッシュボードのカードは温度・湿度だけになったため、気圧・CO2・照度はここが行き先になる（#226）。
 * グラフの指標を切り替えないと読めなかった値が、パネルを開いた直後にそろって見えるようにする。
 */
export function CurrentReadings({
  readings,
  measuredAt,
  selectedMetric,
  onSelectMetric,
  selectableMetrics,
}: CurrentReadingsProps) {
  if (readings.length === 0) return null;

  const measuredLabel = measuredAt ? formatMeasuredAt(measuredAt) : null;

  return (
    <section className="px-5 pt-4">
      <p className="mb-2 px-0.5 text-[11px] tracking-wider text-muted-foreground">
        いまの値{measuredLabel ? ` ・ ${measuredLabel} 時点` : ""}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {readings.map((reading) => {
          const Icon = METRIC_ICONS[reading.metric];
          const content = (
            <>
              <span className="reading-cell-label">
                <Icon
                  className="size-3.5 shrink-0"
                  strokeWidth={1.75}
                  style={{ color: METRIC_COLORS[reading.metric] }}
                />
                {reading.label}
              </span>
              <span className="reading-cell-value">
                {reading.text}
                <span className="reading-cell-unit"> {reading.unit}</span>
              </span>
            </>
          );
          if (!onSelectMetric) {
            return (
              <div key={reading.metric} className="reading-cell">
                {content}
              </div>
            );
          }
          const selected = reading.metric === selectedMetric;
          const selectable = !selectableMetrics || selectableMetrics.includes(reading.metric);
          return (
            <button
              key={reading.metric}
              type="button"
              className="reading-cell reading-cell-button"
              style={{ "--metric-color": METRIC_COLORS[reading.metric] } as CSSProperties}
              aria-pressed={selected}
              aria-label={`${reading.label}のグラフを表示`}
              disabled={!selectable}
              onClick={() => onSelectMetric(reading.metric)}
            >
              {content}
            </button>
          );
        })}
      </div>
    </section>
  );
}
