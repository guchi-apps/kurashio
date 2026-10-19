import { describe, expect, it } from "vitest";
import {
  AIRCON_ENERGY_COLOR,
  buildEnergyCalendarWeeks,
  buildEnergyComparison,
  buildEnergyDailyRows,
  buildEnergyHourlyColumns,
  buildEnergySingleColumns,
  buildEnergySourceColors,
  buildEnergyDailyTicks,
  buildEnergyStackColumns,
  buildEnergyStackColumnsFrom,
  buildEnergyStackSegments,
  energyVisibleColumnRange,
  mergeEnergyDailyHistory,
  energyMonthOf,
  energyRowRatio,
  energySourceRatio,
  formatEnergyDate,
  formatEnergyDateWithWeekday,
  formatEnergyHour,
  formatEnergyMonthLabel,
  formatKwh,
  formatWatts,
  formatYen,
  hasEnergyData,
  hasEnergyKepcoOther,
  isEnergyStale,
  shiftEnergyDate,
  shiftEnergyMonth,
} from "@/lib/energy";
import type { EnergyBreakdown, EnergyHourly, EnergySourceRow } from "@/lib/types";

function buildSourceRow(overrides: Partial<EnergySourceRow> = {}): EnergySourceRow {
  return {
    source: "aircon",
    label: "エアコン",
    default_label: "エアコン",
    today_kwh: 1.86,
    today_cost_yen: 57.7,
    power_w: null,
    power_updated_at: null,
    this_month_kwh: 48.2,
    latest_date: "2026-08-22",
    ...overrides,
  };
}

function buildBreakdown(overrides: Partial<EnergyBreakdown> = {}): EnergyBreakdown {
  return {
    unit_price: 31,
    sources: [
      buildSourceRow(),
      buildSourceRow({
        source: "tapo:冷蔵庫",
        label: "冷蔵庫",
        today_kwh: 0.86,
        today_cost_yen: 26.7,
        power_w: 38.2,
        this_month_kwh: 22.4,
      }),
      buildSourceRow({
        source: "tapo:テレビ",
        label: "テレビ",
        today_kwh: 0.31,
        today_cost_yen: 9.6,
        power_w: 72,
        this_month_kwh: 10.2,
      }),
    ],
    today: { date: "2026-08-22", kwh: 3.03, cost_yen: 94, days: 1 },
    this_month: {
      kwh: 80.8,
      cost_yen: 2505,
      days: 22,
      start: "2026-08-01",
      end: "2026-08-22",
    },
    last_month: {
      kwh: 110.2,
      cost_yen: 3416,
      days: 31,
      start: "2026-07-01",
      end: "2026-07-31",
    },
    last_month_to_date: {
      kwh: 71.4,
      cost_yen: 2213,
      days: 22,
      start: "2026-07-01",
      end: "2026-07-22",
    },
    daily: [
      {
        date: "2026-08-20",
        kwh: 5.0,
        cost_yen: 155,
        by_source: { aircon: 3.0, "tapo:冷蔵庫": 1.5, "tapo:テレビ": 0.5 },
      },
      {
        date: "2026-08-21",
        kwh: 4.0,
        cost_yen: 124,
        by_source: { aircon: 2.0, "tapo:冷蔵庫": 1.5, "tapo:テレビ": 0.5 },
      },
      {
        date: "2026-08-22",
        kwh: 3.03,
        cost_yen: 94,
        by_source: { aircon: 1.86, "tapo:冷蔵庫": 0.86, "tapo:テレビ": 0.31 },
      },
    ],
    latest_date: "2026-08-22",
    updated_at: "2026-08-22T04:00:00",
    ...overrides,
  };
}

describe("表示の整形", () => {
  it("金額は円マークと3桁区切りにする", () => {
    expect(formatYen(2505)).toBe("¥2,505");
    expect(formatYen(null)).toBe("—");
  });

  it("使用量は小数第1位まで出す", () => {
    expect(formatKwh(80.84)).toBe("80.8 kWh");
    expect(formatKwh(null)).toBe("—");
  });

  it("いまのWは整数で出し、返さない取得元は「—」にする", () => {
    expect(formatWatts(38.2)).toBe("38 W");
    expect(formatWatts(0)).toBe("0 W");
    // エアコン（AirCloud Home）は瞬時値を返さない
    expect(formatWatts(null)).toBe("—");
  });

  it("日付はゼロ埋めせず月/日にする", () => {
    expect(formatEnergyDate("2026-08-02")).toBe("8/2");
  });

  it("曜日つきの日付はUTC基準で組み立て、端末のタイムゾーンに寄せない", () => {
    expect(formatEnergyDateWithWeekday("2026-08-22")).toBe("8/22（土）");
  });
});

describe("先月との比較", () => {
  it("先月の同じ時期より安ければ cheaper になる", () => {
    const comparison = buildEnergyComparison(
      buildBreakdown({
        this_month: {
          kwh: 60,
          cost_yen: 1860,
          days: 22,
          start: "2026-08-01",
          end: "2026-08-22",
        },
      })
    );
    expect(comparison?.cheaper).toBe(true);
  });

  it("高いときは cheaper が false になる", () => {
    expect(buildEnergyComparison(buildBreakdown())?.cheaper).toBe(false);
  });

  it("先月ぶんが無ければ比較を出さない", () => {
    const comparison = buildEnergyComparison(
      buildBreakdown({
        last_month_to_date: {
          kwh: 0,
          cost_yen: 0,
          days: 0,
          start: "2026-07-01",
          end: "2026-07-22",
        },
      })
    );
    expect(comparison).toBeNull();
  });

  it("breakdown が無ければ null", () => {
    expect(buildEnergyComparison(null)).toBeNull();
  });
});

describe("取得元ごとの色", () => {
  it("エアコンは固定色で、プラグには別の色が割り当たる", () => {
    const colors = buildEnergySourceColors(buildBreakdown().sources);
    expect(colors["aircon"]).toBe(AIRCON_ENERGY_COLOR);
    expect(colors["tapo:冷蔵庫"]).not.toBe(AIRCON_ENERGY_COLOR);
    expect(colors["tapo:冷蔵庫"]).not.toBe(colors["tapo:テレビ"]);
  });

  it("エアコンが無くてもプラグの色が重ならない", () => {
    const colors = buildEnergySourceColors([
      buildSourceRow({ source: "tapo:A", label: "A" }),
      buildSourceRow({ source: "tapo:B", label: "B" }),
    ]);
    expect(colors["tapo:A"]).not.toBe(colors["tapo:B"]);
  });
});

describe("積み上げ", () => {
  it("1日ぶんを取得元ごとの割合に分ける", () => {
    const breakdown = buildBreakdown();
    const colors = buildEnergySourceColors(breakdown.sources);
    const segments = buildEnergyStackSegments(
      breakdown.daily[0],
      breakdown.sources,
      colors
    );
    expect(segments.map((segment) => segment.source)).toEqual([
      "aircon",
      "tapo:冷蔵庫",
      "tapo:テレビ",
    ]);
    expect(segments[0].share).toBeCloseTo(0.6);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1);
  });

  it("その日に値が無い取得元は入れない", () => {
    const breakdown = buildBreakdown();
    const colors = buildEnergySourceColors(breakdown.sources);
    const segments = buildEnergyStackSegments(
      { date: "2026-08-22", kwh: 1.86, cost_yen: 58, by_source: { aircon: 1.86 } },
      breakdown.sources,
      colors
    );
    expect(segments).toHaveLength(1);
  });

  it("棒の高さは期間内の最大値で正規化する", () => {
    const columns = buildEnergyStackColumns(buildBreakdown());
    expect(columns.map((column) => Number(column.ratio.toFixed(2)))).toEqual([
      1, 0.8, 0.61,
    ]);
  });

  it("KEPCOの「その他」は breakdown.sources に無くても機器の後ろに積む（#319）", () => {
    const breakdown = buildBreakdown();
    const colors = buildEnergySourceColors(breakdown.sources);
    const segments = buildEnergyStackSegments(
      {
        date: "2026-08-22",
        kwh: 4.0,
        cost_yen: 124,
        by_source: { aircon: 1.86, kepco_other: 1.28, "tapo:冷蔵庫": 0.86 },
      },
      breakdown.sources,
      colors
    );

    expect(segments.map((segment) => segment.source)).toEqual([
      "aircon",
      "tapo:冷蔵庫",
      "kepco_other",
    ]);
    const other = segments[2];
    expect(other.label).toBe("その他");
    expect(other.color).toBe("#95a5a6");
    expect(other.share).toBeCloseTo(1.28 / 4.0);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1);
  });

  it("「その他」が1日でもあれば注記を出す（#319）", () => {
    expect(hasEnergyKepcoOther(buildBreakdown().daily)).toBe(false);
    expect(
      hasEnergyKepcoOther([
        { date: "2026-08-21", kwh: 1.0, cost_yen: 31, by_source: { aircon: 1.0 } },
        {
          date: "2026-08-22",
          kwh: 2.0,
          cost_yen: 62,
          by_source: { aircon: 1.0, kepco_other: 1.0 },
        },
      ])
    ).toBe(true);
  });

  it("記録の無い日は棒を作らない（0kWhとして描かない）", () => {
    const columns = buildEnergyStackColumns(
      buildBreakdown({
        daily: [
          { date: "2026-08-21", kwh: 0, cost_yen: 0, by_source: {} },
          {
            date: "2026-08-22",
            kwh: 3.03,
            cost_yen: 94,
            by_source: { aircon: 3.03 },
          },
        ],
      })
    );
    expect(columns.map((column) => column.date)).toEqual(["2026-08-22"]);
  });
});

describe("単一デバイスの棒", () => {
  it("記録が無ければ空配列になる", () => {
    expect(buildEnergySingleColumns([])).toEqual([]);
    expect(
      buildEnergySingleColumns([
        { date: "2026-08-21", kwh: null },
        { date: "2026-08-22", kwh: 0 },
      ])
    ).toEqual([]);
  });

  it("0kWhの日は除外される", () => {
    const columns = buildEnergySingleColumns([
      { date: "2026-08-20", kwh: 0 },
      { date: "2026-08-21", kwh: 1.5 },
    ]);
    expect(columns.map((column) => column.date)).toEqual(["2026-08-21"]);
  });

  it("棒の高さは期間内の最大値で正規化する", () => {
    const columns = buildEnergySingleColumns([
      { date: "2026-08-20", kwh: 1.0 },
      { date: "2026-08-21", kwh: 2.0 },
      { date: "2026-08-22", kwh: 0.5 },
    ]);
    expect(columns.map((column) => column.ratio)).toEqual([0.5, 1, 0.25]);
  });
});

describe("日別一覧とカードの棒", () => {
  it("日別一覧は新しい日が先頭に来る", () => {
    const rows = buildEnergyDailyRows(buildBreakdown().daily);
    expect(rows[0].date).toBe("2026-08-22");
  });

  it("一覧の棒は最大値で正規化する", () => {
    const rows = buildEnergyDailyRows(buildBreakdown().daily);
    expect(Number(energyRowRatio(rows, rows[0]).toFixed(2))).toBe(0.61);
  });

  it("カードの行はその日いちばん使った取得元を1とする", () => {
    const { sources } = buildBreakdown();
    expect(energySourceRatio(sources, sources[0])).toBe(1);
    expect(Number(energySourceRatio(sources, sources[1]).toFixed(2))).toBe(0.46);
  });
});

describe("時間ごと（#300）", () => {
  function buildHourly(overrides: Partial<EnergyHourly> = {}): EnergyHourly {
    const emptyHours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      kwh: null,
      cost_yen: null,
      by_source: {},
    }));
    return {
      date: "2026-08-31",
      unit_price: 31,
      sources: ["aircon", "tapo:冷蔵庫"],
      has_data: true,
      hours: emptyHours,
      ...overrides,
    };
  }

  it("日付を日単位でずらす（UTC正午基準）", () => {
    expect(shiftEnergyDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftEnergyDate("2026-08-31", -1)).toBe("2026-08-30");
  });

  it("時間帯は「7時」のように出す", () => {
    expect(formatEnergyHour(7)).toBe("7時");
  });

  it("記録の無い時間帯はセグメントを作らない", () => {
    const columns = buildEnergyHourlyColumns(
      buildHourly(),
      buildBreakdown().sources,
      buildEnergySourceColors(buildBreakdown().sources)
    );
    expect(columns).toHaveLength(24);
    expect(columns.every((column) => column.segments.length === 0)).toBe(true);
  });

  it("取得元ごとの内訳にラベルと色、割合を付ける", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      kwh: null as number | null,
      cost_yen: null as number | null,
      by_source: {} as Record<string, number>,
    }));
    hours[8] = {
      hour: 8,
      kwh: 0.6,
      cost_yen: 19,
      by_source: { aircon: 0.5, "tapo:冷蔵庫": 0.1 },
    };
    const breakdown = buildBreakdown();
    const columns = buildEnergyHourlyColumns(
      buildHourly({ hours }),
      breakdown.sources,
      buildEnergySourceColors(breakdown.sources)
    );

    const hour8 = columns[8];
    expect(hour8.kwh).toBe(0.6);
    expect(hour8.segments.map((segment) => segment.source)).toEqual([
      "aircon",
      "tapo:冷蔵庫",
    ]);
    expect(hour8.segments[0].label).toBe("エアコン");
    expect(hour8.segments[0].share).toBeCloseTo(0.5 / 0.6);
    expect(hour8.ratio).toBe(1);
  });

  it("hourly が無ければ空配列", () => {
    expect(buildEnergyHourlyColumns(null, [], {})).toEqual([]);
  });

  it("KEPCOの「その他」は breakdown.sources に無くても専用のラベル・色になる（#302）", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      kwh: null as number | null,
      cost_yen: null as number | null,
      by_source: {} as Record<string, number>,
    }));
    hours[20] = {
      hour: 20,
      kwh: 0.9,
      cost_yen: 28,
      by_source: { aircon: 0.5, kepco_other: 0.4 },
    };
    const breakdown = buildBreakdown();
    const columns = buildEnergyHourlyColumns(
      buildHourly({ sources: ["aircon", "kepco_other"], hours }),
      breakdown.sources,
      buildEnergySourceColors(breakdown.sources)
    );

    const other = columns[20].segments.find((segment) => segment.source === "kepco_other");
    expect(other?.label).toBe("その他");
    expect(other?.color).toBe("#95a5a6");
  });
});

describe("収集が止まっているかの判定", () => {
  it("昨日ぶんが届いていれば止まっていない（当日ぶんは日中まだ来ない）", () => {
    expect(
      isEnergyStale(buildBreakdown({ latest_date: "2026-08-21" }), "2026-08-22")
    ).toBe(false);
  });

  it("一昨日で止まっていれば止まっていると見なす", () => {
    expect(
      isEnergyStale(buildBreakdown({ latest_date: "2026-08-20" }), "2026-08-22")
    ).toBe(true);
  });

  it("月をまたいでも日付の大小で判定できる", () => {
    expect(
      isEnergyStale(buildBreakdown({ latest_date: "2026-07-30" }), "2026-08-01")
    ).toBe(true);
  });

  it("1件も無ければ止まっている扱いにしない", () => {
    expect(isEnergyStale(buildBreakdown({ latest_date: null }), "2026-08-22")).toBe(
      false
    );
    expect(hasEnergyData(buildBreakdown({ daily: [] }))).toBe(false);
    expect(hasEnergyData(null)).toBe(false);
  });
});

describe("日付のカレンダー（#330）", () => {
  it("日曜始まりで並び、月初の前は空きマスになる", () => {
    // 2026-09-01 は火曜。日・月の2マスが空く
    const weeks = buildEnergyCalendarWeeks("2026-09");
    expect(weeks[0].slice(0, 3)).toEqual([null, null, "2026-09-01"]);
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("月末までを出し、翌月の日付は混ぜない", () => {
    const days = buildEnergyCalendarWeeks("2026-09").flat().filter(Boolean);
    expect(days).toHaveLength(30);
    expect(days[days.length - 1]).toBe("2026-09-30");
    // 2月は28日（2026年はうるう年ではない）
    expect(buildEnergyCalendarWeeks("2026-02").flat().filter(Boolean)).toHaveLength(28);
    expect(buildEnergyCalendarWeeks("2024-02").flat().filter(Boolean)).toHaveLength(29);
  });

  it("月をずらしても、月末の日数につられて飛ばない", () => {
    expect(shiftEnergyMonth("2026-08", 1)).toBe("2026-09");
    expect(shiftEnergyMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftEnergyMonth("2026-12", 1)).toBe("2027-01");
    // 31日まである月から、30日までの月・28日までの月へ送っても1か月だけ動く
    expect(shiftEnergyMonth("2026-03", -1)).toBe("2026-02");
  });

  it("日付から月を取り出し、年月の見出しにできる", () => {
    expect(energyMonthOf("2026-09-02")).toBe("2026-09");
    expect(formatEnergyMonthLabel("2026-09")).toBe("2026年9月");
    // 「今日の月かどうか」は文字列の大小で判定できる
    expect(energyMonthOf("2026-09-02") < energyMonthOf("2026-10-01")).toBe(true);
  });
});

describe("日別グラフの横スクロール（#810）", () => {
  const day = (date: string, kwh: number, extra: Record<string, number> = {}) => ({
    date,
    kwh,
    cost_yen: kwh * 31,
    by_source: { aircon: kwh, ...extra },
  });

  it("直近の範囲は親の値を使い、1年ぶんはそれより前の日だけを補う", () => {
    const recent = [day("2026-10-18", 2), day("2026-10-19", 3, { kepco_other: 1 })];
    // 1年ぶんは開いたときの値。取り込み前なので 10/19 に「その他」が無い
    const history = [day("2026-10-17", 1), day("2026-10-18", 9), day("2026-10-19", 3)];
    const merged = mergeEnergyDailyHistory(recent, history);
    expect(merged.map((d) => d.date)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(merged[1].kwh).toBe(2);
    expect(merged[2].by_source.kepco_other).toBe(1);
  });

  it("1年ぶんが無ければ直近だけを日付順で返す", () => {
    const recent = [day("2026-10-19", 3), day("2026-10-18", 2)];
    expect(mergeEnergyDailyHistory(recent, null).map((d) => d.date)).toEqual([
      "2026-10-18",
      "2026-10-19",
    ]);
  });

  it("棒の高さは渡した全期間の最大値が基準になる", () => {
    const columns = buildEnergyStackColumnsFrom(
      [day("2026-06-01", 8), day("2026-10-19", 2)],
      [],
      {}
    );
    expect(columns.map((c) => c.ratio)).toEqual([1, 0.25]);
  });

  it("目盛りは左端・月の変わり目に月、8日・15日・22日を跨いだ棒に日付を付ける", () => {
    const dates = ["2026-09-28", "2026-09-30", "2026-10-01", "2026-10-07", "2026-10-09", "2026-10-15", "2026-10-29", "2026-10-31"];
    expect(buildEnergyDailyTicks(dates.map((date) => ({ date })))).toEqual([
      { label: "9月", month: true },
      null,
      { label: "10月", month: true },
      null,
      { label: "10/9", month: false },
      { label: "10/15", month: false },
      // 22日の棒が無くても、跨いだ次の棒に付ける
      { label: "10/29", month: false },
      null,
    ]);
  });

  it("スクロール位置から、画面に半分以上入っている棒の範囲を返す", () => {
    // 100本・1本12px・左に60pxの一言。右端（scrollLeft = 60 + 1200 - 360）では最後の30本
    expect(energyVisibleColumnRange(900, 360, 60, 12, 100)).toEqual({ first: 70, last: 99 });
    expect(energyVisibleColumnRange(0, 360, 60, 12, 100)).toEqual({ first: 0, last: 24 });
    expect(energyVisibleColumnRange(0, 360, 0, 12, 0)).toBeNull();
  });
});
