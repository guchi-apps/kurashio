import { describe, expect, it } from "vitest";
import {
  getAvailableChartMetrics,
  hasOutdoorMetricData,
  calcDiscomfortIndex,
  buildAirconTargetChartSegments,
  buildAirconTargetChartSeries,
  clampDomainOffset,
  computeChartDomain,
  computeDomainOffsetForSelectionTime,
  computeVisibleYDomain,
  downsampleHistoryForChart,
  downsampleMultiDeviceHistoryForChart,
  filterHistoryForDomain,
  getComfortAdvice,
  getDeviceMetricValueAtTime,
  getDeviceTargetMetricStateAtTime,
  getMaxPositiveDomainOffset,
  getOutdoorMetricValueAtTime,
  getSelectionTime,
  getViewRangeMs,
  hasDeviceTargetChartData,
  hasDeviceTargetMetricData,
  hasDeviceTargetStateData,
  isAggregatedRange,
} from "@/lib/chart-utils";
import type { HistoryPoint } from "@/lib/types";
import {
  getHistoryChunkMs,
  getHistoryInitialSpanMs,
  getHistoryQuickInitialSpanMs,
  mergeAirconIntoHistory,
  mergeHistoryPoints,
  toApiDateTime,
} from "@/lib/history-loader";
import { getDeviceTargetMetricValue } from "@/lib/types";

function makePoint(
  datetimeObj: number,
  temperature: number,
  humidity = 50,
  pressure = 1013
): HistoryPoint {
  return {
    datetimeObj,
    temperature,
    humidity,
    pressure,
  };
}

describe("getViewRangeMs", () => {
  it("returns expected window sizes", () => {
    expect(getViewRangeMs("day")).toBe(86400000);
    expect(getViewRangeMs("week")).toBe(7 * 86400000);
  });
});

describe("computeChartDomain", () => {
  it("builds a sliding window from the latest point", () => {
    const history = [
      makePoint(1000, 20),
      makePoint(2000, 21),
      makePoint(3000, 22),
    ];
    const domain = computeChartDomain(history, "day", 0);
    expect(domain[0]).not.toBe("dataMin");
    expect(domain[1]).toBeGreaterThan(domain[0] as number);
  });

  it("aligns the latest point with the selection cursor at max positive offset", () => {
    const history = [makePoint(1000, 20), makePoint(3000, 22)];
    const viewRange = "day" as const;
    const offset = getMaxPositiveDomainOffset(viewRange);
    const domain = computeChartDomain(history, viewRange, offset) as [number, number];
    const selectionTime = getSelectionTime(history, domain);

    expect(selectionTime).toBe(3000);
  });
});

describe("computeDomainOffsetForSelectionTime", () => {
  it("places the selection cursor at the requested timestamp", () => {
    const history = [makePoint(1000, 20), makePoint(3000, 22)];
    const viewRange = "day" as const;
    const offset = computeDomainOffsetForSelectionTime(history, viewRange, 3000);
    const domain = computeChartDomain(history, viewRange, offset) as [number, number];

    expect(getSelectionTime(history, domain)).toBe(3000);
  });

  it("keeps the same selection time after switching view range", () => {
    const history = [makePoint(1000, 20), makePoint(5000, 22)];
    const selectionTime = 2500;
    const dayOffset = computeDomainOffsetForSelectionTime(history, "day", selectionTime);
    const dayDomain = computeChartDomain(history, "day", dayOffset) as [number, number];
    expect(getSelectionTime(history, dayDomain)).toBe(selectionTime);

    const weekOffset = computeDomainOffsetForSelectionTime(history, "week", selectionTime);
    const weekDomain = computeChartDomain(history, "week", weekOffset) as [number, number];
    expect(getSelectionTime(history, weekDomain)).toBe(selectionTime);
  });
});

describe("clampDomainOffset", () => {
  it("allows positive offset up to the selection alignment limit", () => {
    const history = [makePoint(1000, 20), makePoint(3000, 22)];
    const viewRange = "day" as const;
    const maxOffset = getMaxPositiveDomainOffset(viewRange);

    expect(
      clampDomainOffset(history, viewRange, 0, maxOffset + 1000)
    ).toBeCloseTo(maxOffset);
    expect(clampDomainOffset(history, viewRange, maxOffset, 1000)).toBeCloseTo(
      maxOffset
    );
  });
});

describe("filterHistoryForDomain", () => {
  it("returns points inside the visible domain", () => {
    const history = [
      makePoint(1000, 20),
      makePoint(2000, 21),
      makePoint(3000, 22),
    ];
    const filtered = filterHistoryForDomain(history, [1500, 2500], 0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].datetimeObj).toBe(2000);
  });
});

describe("downsampleHistoryForChart", () => {
  it("reduces large datasets while keeping extrema", () => {
    const history = Array.from({ length: 1000 }, (_, index) =>
      makePoint(index, index % 2 === 0 ? 10 : 30)
    );
    const downsampled = downsampleHistoryForChart(history, "temperature", 40);
    expect(downsampled.length).toBeLessThanOrEqual(80);
    expect(downsampled.length).toBeGreaterThan(0);
  });
});

describe("downsampleMultiDeviceHistoryForChart", () => {
  it("keeps outdoor values when downsampling device series", () => {
    const history: HistoryPoint[] = Array.from({ length: 500 }, (_, index) => ({
      datetimeObj: index * 60_000,
      d1_temperature: 20 + (index % 10),
      outdoor_temperature: 10 + (index % 8),
    })) as HistoryPoint[];

    const downsampled = downsampleMultiDeviceHistoryForChart(
      history,
      "temperature",
      40,
      [1]
    );

    expect(downsampled.length).toBeLessThan(history.length);
    expect(downsampled.some((point) => point.outdoor_temperature != null)).toBe(true);
  });
});

describe("comfort helpers", () => {
  it("calculates discomfort index", () => {
    const di = calcDiscomfortIndex(25, 50);
    expect(di).toBeGreaterThan(60);
    expect(di).toBeLessThan(80);
  });

  it("returns advice for comfortable conditions", () => {
    const advice = getComfortAdvice(22, 50);
    expect(advice.mainAdvice).toContain("快適");
  });
});

describe("history-loader", () => {
  it("formats API datetime strings", () => {
    const formatted = toApiDateTime(new Date("2026-05-30T12:34:56"));
    expect(formatted).toBe("2026-05-30T12:34:56");
  });

  it("merges history without duplicates", () => {
    const existing = [makePoint(1000, 20)];
    const incoming = [makePoint(1000, 20), makePoint(2000, 21)];
    const merged = mergeHistoryPoints(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged.map((point) => point.datetimeObj)).toEqual([1000, 2000]);
  });

  it("returns larger initial spans for year view", () => {
    expect(getHistoryInitialSpanMs("year")).toBeGreaterThan(
      getHistoryInitialSpanMs("day")
    );
    expect(getHistoryChunkMs("year")).toBeGreaterThan(getHistoryChunkMs("day"));
  });

  it("loads a shorter quick span before the full initial span", () => {
    for (const viewRange of ["day", "week", "month", "year"] as const) {
      const quick = getHistoryQuickInitialSpanMs(viewRange);
      const full = getHistoryInitialSpanMs(viewRange);
      expect(quick).toBeLessThanOrEqual(full);
      expect(quick).toBeGreaterThan(0);
    }
    expect(getHistoryQuickInitialSpanMs("day")).toBeLessThan(
      getHistoryInitialSpanMs("day")
    );
  });
});

describe("interpolateDeviceMetricAtTime", () => {
  it("interpolates between bracketing points", () => {
    const history: HistoryPoint[] = [
      {
        datetimeObj: 1000,
        d1_temperature: 20,
        d2_temperature: 18,
      } as HistoryPoint,
      {
        datetimeObj: 3000,
        d1_temperature: 24,
        d2_temperature: 22,
      } as HistoryPoint,
    ];

    expect(getDeviceMetricValueAtTime(history, 1, "temperature", 2000)).toBe(22);
    expect(getDeviceMetricValueAtTime(history, 2, "temperature", 2000)).toBe(20);
  });

  it("returns the most recent value when the target is after the last point", () => {
    const history: HistoryPoint[] = [
      {
        datetimeObj: 1000,
        d1_temperature: 20,
        d2_temperature: 18,
      } as HistoryPoint,
      {
        datetimeObj: 2000,
        d1_temperature: 22,
      } as HistoryPoint,
      {
        datetimeObj: 3000,
        d1_temperature: 24,
        d2_temperature: 19,
      } as HistoryPoint,
    ];

    expect(getDeviceMetricValueAtTime(history, 1, "temperature", 3500)).toBe(24);
    expect(getDeviceMetricValueAtTime(history, 2, "temperature", 2500)).toBeCloseTo(18.75);
  });
  it("returns undefined before the first data point", () => {
    const history: HistoryPoint[] = [
      {
        datetimeObj: 2358000,
        d2_temperature: 22,
      } as HistoryPoint,
    ];

    expect(getDeviceMetricValueAtTime(history, 2, "temperature", 2211000)).toBeUndefined();
    expect(getDeviceMetricValueAtTime(history, 2, "temperature", 2358000)).toBe(22);
  });
});

describe("getOutdoorMetricValueAtTime", () => {
  it("returns the most recent outdoor value at or before the target time", () => {
    const history: HistoryPoint[] = [
      { datetimeObj: 1000, outdoor_temperature: 10 } as HistoryPoint,
      { datetimeObj: 2000, outdoor_temperature: 12 } as HistoryPoint,
    ];

    expect(getOutdoorMetricValueAtTime(history, "temperature", 1500)).toBe(11);
    expect(getOutdoorMetricValueAtTime(history, "temperature", 2000)).toBe(12);
  });
});

describe("isAggregatedRange", () => {
  it("aggregates only year view", () => {
    expect(isAggregatedRange("year")).toBe(true);
    expect(isAggregatedRange("month")).toBe(false);
  });
});

describe("mergeAirconIntoHistory", () => {
  const chartDeviceId = 3;

  it("does not forward-fill target temperature while aircon is on", () => {
    const merged = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 29,
          target_temperature: 28,
          power: "ON",
        },
        {
          datetimeObj: 2000,
          temperature: 29.5,
          power: "ON",
        },
        {
          datetimeObj: 3000,
          temperature: 30,
          power: "ON",
        },
      ],
      chartDeviceId
    );

    expect(merged).toHaveLength(3);
    expect(getDeviceTargetMetricValue(merged[0], chartDeviceId)).toBe(28);
    expect(getDeviceTargetMetricValue(merged[1], chartDeviceId)).toBeUndefined();
    expect(getDeviceTargetMetricValue(merged[2], chartDeviceId)).toBeUndefined();
  });

  it("clears target temperature while aircon is off", () => {
    const merged = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 29,
          target_temperature: 28,
          power: "ON",
        },
        {
          datetimeObj: 2000,
          temperature: 29.5,
          power: "OFF",
        },
      ],
      chartDeviceId
    );

    expect(getDeviceTargetMetricValue(merged[0], chartDeviceId)).toBe(28);
    expect(getDeviceTargetMetricValue(merged[1], chartDeviceId)).toBeUndefined();
  });

  it("treats target temperature 0 as automatic (not plottable)", () => {
    const merged = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 29,
          target_temperature: 0,
          power: "ON",
        },
      ],
      chartDeviceId
    );

    expect(getDeviceTargetMetricValue(merged[0], chartDeviceId)).toBeUndefined();
  });
});

describe("buildAirconTargetChartSeries", () => {
  it("returns a continuous target series even when mixed with other device rows", () => {
    const history = mergeAirconIntoHistory(
      [],
      Array.from({ length: 30 }, (_, index) => ({
        datetimeObj: 1_000_000 + index * 300_000,
        temperature: 29 + index * 0.01,
        target_temperature: 28,
        power: "ON",
      })),
      3
    );

    const interleaved = history.flatMap((point, index) => {
      const rows: HistoryPoint[] = [point];
      if (index % 2 === 0) {
        rows.unshift({
          datetimeObj: point.datetimeObj - 60_000,
          temperature: 20,
        } as HistoryPoint);
      }
      return rows;
    });

    const series = buildAirconTargetChartSeries(interleaved, 3, 320);
    expect(series).toHaveLength(30);
    expect(series.every((point) => point.airconTarget === 28)).toBe(true);
  });

  it("splits target series when aircon is off", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 29,
          target_temperature: 28,
          power: "ON",
        },
        {
          datetimeObj: 2000,
          temperature: 29.5,
          power: "OFF",
        },
        {
          datetimeObj: 3000,
          temperature: 30,
          target_temperature: 26,
          power: "ON",
        },
      ],
      3
    );

    const segments = buildAirconTargetChartSegments(history, 3, 320);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      auto: false,
      points: [{ datetimeObj: 1000, airconTarget: 28 }],
    });
    expect(segments[1]).toEqual({
      auto: false,
      points: [{ datetimeObj: 3000, airconTarget: 26 }],
    });
  });

  it("plots automatic target as dashed line at room temperature", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 29,
          target_temperature: 0,
          power: "ON",
        },
        {
          datetimeObj: 2000,
          temperature: 29.5,
          target_temperature: 26,
          power: "ON",
        },
      ],
      3
    );

    expect(hasDeviceTargetStateData(history, 3)).toBe(true);
    expect(hasDeviceTargetChartData(history, 3)).toBe(true);
    expect(hasDeviceTargetMetricData(history, 3)).toBe(true);
    expect(buildAirconTargetChartSegments(history, 3, 320)).toEqual([
      {
        auto: true,
        points: [{ datetimeObj: 1000, airconTarget: 29 }],
      },
      {
        auto: false,
        points: [{ datetimeObj: 2000, airconTarget: 26 }],
      },
    ]);
    expect(getDeviceTargetMetricStateAtTime(history, 3, 1500)).toBe(0);
  });

  it("plots automatic target with a shift at room temperature plus the shift", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 27.6,
          target_temperature: 1,
          power: "ON",
        },
        {
          datetimeObj: 2000,
          temperature: 28,
          target_temperature: -1.5,
          power: "ON",
        },
      ],
      3
    );

    expect(buildAirconTargetChartSegments(history, 3, 320)).toEqual([
      {
        auto: true,
        points: [
          { datetimeObj: 1000, airconTarget: 28.6 },
          { datetimeObj: 2000, airconTarget: 26.5 },
        ],
      },
    ]);
    // シフト量そのものは設定温度の系列（絶対温度）には載せない
    expect(hasDeviceTargetMetricData(history, 3)).toBe(false);
    expect(getDeviceTargetMetricStateAtTime(history, 3, 1500)).toBe(1);
  });

  it("keeps a fixed target temperature outside the shift range as an absolute value", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 27.6,
          target_temperature: 16,
          power: "ON",
        },
      ],
      3
    );

    expect(buildAirconTargetChartSegments(history, 3, 320)).toEqual([
      {
        auto: false,
        points: [{ datetimeObj: 1000, airconTarget: 16 }],
      },
    ]);
  });
});

describe("computeVisibleYDomain", () => {
  it("includes the automatic target's room-temperature dashed line even when the device's own line is hidden", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 35,
          target_temperature: 0,
          power: "ON",
        },
      ],
      3
    );

    const [min, max] = computeVisibleYDomain(
      history,
      [0, 2000],
      "temperature",
      false,
      [],
      false,
      [3]
    ) as [number, number];

    expect(max).toBeGreaterThanOrEqual(35);
    expect(min).toBeLessThanOrEqual(35);
  });

  it("excludes the target device's room temperature while the aircon is off", () => {
    const history = mergeAirconIntoHistory(
      [],
      [
        {
          datetimeObj: 1000,
          temperature: 35,
          target_temperature: 0,
          power: "OFF",
        },
      ],
      3
    );

    const [min, max] = computeVisibleYDomain(
      history,
      [0, 2000],
      "temperature",
      false,
      [],
      false,
      [3]
    ) as [number, number] | ["auto", "auto"];

    expect([min, max]).toEqual(["auto", "auto"]);
  });
});

describe("hasOutdoorMetricData（#637）", () => {
  it("屋外の気圧はデータがあっても対象外にする", () => {
    const history = [
      { datetimeObj: 1, outdoor_temperature: 20, outdoor_pressure: 1010 },
    ] as unknown as Parameters<typeof hasOutdoorMetricData>[0];
    expect(hasOutdoorMetricData(history, "temperature")).toBe(true);
    expect(hasOutdoorMetricData(history, "pressure")).toBe(false);
  });
});

describe("getAvailableChartMetrics（#637）", () => {
  it("機器の気圧が無く屋外の気圧だけがある履歴では、気圧タブを出さない", () => {
    const history = [
      { datetimeObj: 1, d2_temperature: 24, outdoor_pressure: 1010 },
    ] as unknown as Parameters<typeof getAvailableChartMetrics>[0];
    const metrics = getAvailableChartMetrics(history, [2]);
    expect(metrics).toContain("temperature");
    expect(metrics).not.toContain("pressure");
  });
});
