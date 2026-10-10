import { describe, expect, it } from "vitest";
import {
  billKindRatio,
  parseWaterBillDraft,
  buildBillMonthRows,
  buildBillStackColumns,
  formatBillAmount,
  formatBillUsage,
  formatBillingMonth,
  formatBillingMonthShort,
  hasBillData,
} from "@/lib/bills";
import type {
  UtilityBillKindTotal,
  UtilityBillMonth,
  UtilityBillSummary,
} from "@/lib/types";

function kind(
  amountYen: number,
  usageValue: number | null = null,
  usageUnit: string | null = null
): UtilityBillKindTotal {
  return {
    amount_yen: amountYen,
    usage_value: usageValue,
    usage_unit: usageUnit,
    plan_name: null,
    contracts: 1,
  };
}

function month(
  billingMonth: string,
  electricity: UtilityBillKindTotal | null,
  gas: UtilityBillKindTotal | null = null
): UtilityBillMonth {
  return {
    billing_month: billingMonth,
    electricity,
    gas,
    total_yen: (electricity?.amount_yen ?? 0) + (gas?.amount_yen ?? 0),
  };
}

describe("請求月の表示", () => {
  it("年月を日本語にする", () => {
    expect(formatBillingMonth("2026-08")).toBe("2026年8月分");
    expect(formatBillingMonthShort("2026-08")).toBe("8月");
  });

  it("読めない値はそのまま返す", () => {
    expect(formatBillingMonth("unknown")).toBe("unknown");
  });
});

describe("使用量の表示", () => {
  it("ガスの m3 は m³ にする", () => {
    expect(formatBillUsage(kind(2060, 8, "m3"))).toBe("8 m³");
  });

  it("電気は単位をそのまま出す", () => {
    expect(formatBillUsage(kind(15760, 540, "kWh"))).toBe("540 kWh");
  });

  it("使用量が無ければダッシュにする", () => {
    expect(formatBillUsage(kind(15760))).toBe("—");
    expect(formatBillUsage(null)).toBe("—");
  });
});

describe("金額の表示", () => {
  it("3桁ごとに区切る", () => {
    expect(formatBillAmount(15760)).toBe("15,760");
  });

  it("値が無ければダッシュにする", () => {
    expect(formatBillAmount(null)).toBe("—");
    expect(formatBillAmount(undefined)).toBe("—");
  });
});

describe("hasBillData", () => {
  it("最新の請求月が無ければ false", () => {
    const empty = { latest: null, months: [] } as unknown as UtilityBillSummary;
    expect(hasBillData(empty)).toBe(false);
    expect(hasBillData(null)).toBe(false);
  });

  it("最新の請求月があれば true", () => {
    const summary = {
      latest: month("2026-08", kind(15760)),
      months: [],
    } as unknown as UtilityBillSummary;
    expect(hasBillData(summary)).toBe(true);
  });
});

describe("月別の積み上げ棒", () => {
  const months = [
    month("2026-06", kind(9100), kind(2483)),
    month("2026-07", kind(12900), kind(2315)),
    month("2026-08", kind(15760), kind(2060)),
  ];

  it("いちばん高い月を 1 として高さを決める", () => {
    const columns = buildBillStackColumns(months);
    expect(columns).toHaveLength(3);
    expect(columns[2].ratio).toBe(1);
    expect(columns[0].ratio).toBeCloseTo(11583 / 17820, 5);
  });

  it("電気を先に積む", () => {
    const [first] = buildBillStackColumns(months);
    expect(first.segments.map((segment) => segment.kind)).toEqual([
      "electricity",
      "gas",
    ]);
  });

  it("金額が無い種別は積まない", () => {
    const [only] = buildBillStackColumns([month("2026-08", kind(15760))]);
    expect(only.segments.map((segment) => segment.kind)).toEqual(["electricity"]);
  });

  it("すべて0円なら棒を作らない", () => {
    expect(buildBillStackColumns([month("2026-08", kind(0))])).toEqual([]);
  });
});

describe("カードの棒の長さ", () => {
  it("その月で高かった種別を 1 とする（合計ではない）", () => {
    const target = month("2026-08", kind(15760), kind(2060));
    expect(billKindRatio(target, target.electricity)).toBe(1);
    // 合計に対する割合（0.116）だと棒が消える。高いほうと比べて 0.13
    expect(billKindRatio(target, target.gas)).toBeCloseTo(2060 / 15760, 5);
  });

  it("値が無ければ0", () => {
    expect(billKindRatio(null, null)).toBe(0);
  });
});

describe("一覧の並び", () => {
  it("新しい月が先頭に来る", () => {
    const rows = buildBillMonthRows([
      month("2026-06", kind(9100)),
      month("2026-08", kind(15760)),
      month("2026-07", kind(12900)),
    ]);
    expect(rows.map((row) => row.billing_month)).toEqual([
      "2026-08",
      "2026-07",
      "2026-06",
    ]);
  });
});

describe("水道料金の手入力", () => {
  it("下書きを送る形へ読む（桁区切り・円・単位つきも受ける）", () => {
    expect(
      parseWaterBillDraft({ billingMonth: "2026-09", amount: "5,120円", usage: "20.5 m³" })
    ).toEqual({
      ok: true,
      value: { billing_month: "2026-09", amount_yen: 5120, usage_m3: 20.5 },
    });
  });

  it("使用量は空でもよい", () => {
    const result = parseWaterBillDraft({ billingMonth: "2026-09", amount: "5120", usage: "" });
    expect(result.ok && result.value.usage_m3).toBeNull();
  });

  it("月・金額・使用量の誤りは理由を返す", () => {
    expect(parseWaterBillDraft({ billingMonth: "", amount: "100", usage: "" }).ok).toBe(false);
    expect(parseWaterBillDraft({ billingMonth: "2026-09", amount: "", usage: "" }).ok).toBe(false);
    expect(parseWaterBillDraft({ billingMonth: "2026-09", amount: "-5", usage: "" }).ok).toBe(false);
    expect(parseWaterBillDraft({ billingMonth: "2026-09", amount: "100", usage: "abc" }).ok).toBe(false);
    expect(parseWaterBillDraft({ billingMonth: "2026-09", amount: "99999999", usage: "" }).ok).toBe(false);
  });

  it("積み上げに水道の段が入り、水道だけの記録でもカードのデータありになる", () => {
    const water = {
      amount_yen: 5000,
      usage_value: 20,
      usage_unit: "m3",
      plan_name: null,
      contracts: 1,
    };
    const m: UtilityBillMonth = {
      billing_month: "2026-09",
      electricity: null,
      gas: null,
      water,
      total_yen: 5000,
    };
    const [column] = buildBillStackColumns([m]);
    expect(column.segments.map((segment) => segment.kind)).toEqual(["water"]);
    expect(
      hasBillData({
        latest: null,
        latest_water: m,
        previous: null,
        comparison: null,
        months: [m],
        total_yen: 5000,
        measured: null,
        unit_price: 31,
        updated_at: null,
      })
    ).toBe(true);
  });
});
