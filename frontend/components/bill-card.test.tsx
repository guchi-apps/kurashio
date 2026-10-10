import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BillCard } from "@/components/bill-card";
import type { UtilityBillSummary } from "@/lib/types";

const august = {
  billing_month: "2026-08",
  electricity: {
    amount_yen: 15760,
    usage_value: 540,
    usage_unit: "kWh",
    plan_name: "なっトクでんき",
    contracts: 1,
  },
  gas: {
    amount_yen: 2060,
    usage_value: 8,
    usage_unit: "m3",
    plan_name: "なっトクプラン",
    contracts: 1,
  },
  total_yen: 17820,
};

const july = {
  billing_month: "2026-07",
  electricity: {
    amount_yen: 12900,
    usage_value: 441,
    usage_unit: "kWh",
    plan_name: "なっトクでんき",
    contracts: 1,
  },
  gas: null,
  total_yen: 12900,
};

const summary: UtilityBillSummary = {
  latest: august,
  previous: july,
  comparison: {
    cheaper: false,
    percent: 22,
    base_amount_yen: 12900,
    base_billing_month: "2026-07",
  },
  months: [july, august],
  total_yen: 30720,
  measured: {
    kwh: 207.4,
    cost_yen: 6430,
    share_percent: 41,
    start: "2026-08-01",
    end: "2026-08-31",
  },
  unit_price: 31,
  updated_at: "2026-08-20T14:18:00",
};

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("BillCard", () => {
  it("最新の請求月・電気とガスの金額・合計を出す", () => {
    const html = render(
      <BillCard summary={summary} loading={false} error={false} onOpenDetail={() => {}} />
    );
    expect(html).toContain("電気・ガス・水道料金");
    expect(html).toContain("2026年8月分");
    expect(html).toContain("15,760");
    expect(html).toContain("540 kWh");
    expect(html).toContain("8 m³");
    expect(html).toContain("¥17,820");
  });

  it("前月との差を出す", () => {
    const html = render(
      <BillCard summary={summary} loading={false} error={false} onOpenDetail={() => {}} />
    );
    expect(html).toContain("22%");
    expect(html).toContain("多い");
  });

  it("請求のうち機器ごとに追えている割合を添える", () => {
    const html = render(
      <BillCard summary={summary} loading={false} error={false} onOpenDetail={() => {}} />
    );
    expect(html).toContain("41%");
    expect(html).toContain("¥6,430");
  });

  it("実測が無ければ割合の行を出さない", () => {
    const html = render(
      <BillCard
        summary={{ ...summary, measured: null }}
        loading={false}
        error={false}
        onOpenDetail={() => {}}
      />
    );
    expect(html).not.toContain("機器ごとに追えている");
  });

  it("ガスの契約が無い月は行を薄く出す", () => {
    const html = render(
      <BillCard
        summary={{ ...summary, latest: july }}
        loading={false}
        error={false}
        onOpenDetail={() => {}}
      />
    );
    expect(html).toContain("opacity-55");
    expect(html).toContain("12,900");
  });

  it("まだ届いていなければ待っている旨を出す", () => {
    const html = render(
      <BillCard
        summary={{ ...summary, latest: null }}
        loading={false}
        error={false}
        onOpenDetail={() => {}}
      />
    );
    expect(html).toContain("まだ請求のお知らせを受け取っていません");
  });

  it("読み込みに失敗したら伝える", () => {
    const html = render(
      <BillCard summary={null} loading={false} error onOpenDetail={() => {}} />
    );
    expect(html).toContain("請求額を読み込めませんでした");
  });
});

describe("BillCard 水道", () => {
  it("水道の記録があれば、電気・ガスと月が違うときは月を添えて出す", () => {
    const withWater: UtilityBillSummary = {
      ...summary,
      latest_water: {
        billing_month: "2026-07",
        electricity: null,
        gas: null,
        water: {
          amount_yen: 5120,
          usage_value: 20,
          usage_unit: "m3",
          plan_name: null,
          contracts: 1,
        },
        total_yen: 5120,
      },
    };
    const html = render(
      <BillCard summary={withWater} loading={false} error={false} onOpenDetail={() => {}} />
    );
    expect(html).toContain("水道");
    expect(html).toContain("¥5,120");
    expect(html).toContain("7月");
  });
});
