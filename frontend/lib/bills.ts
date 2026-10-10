import type {
  UtilityBillKindTotal,
  UtilityBillMonth,
  UtilityBillSummary,
} from "@/lib/types";

/**
 * 電気の色。消費電力カードのアンバー（`--energy-color`）と同じにする。
 * 同じ「電気」を指しているので、隣り合ったカードで色が変わるほうが読み違える。
 */
export const BILL_ELECTRICITY_COLOR = "#f39c12";

/** ガスの色。電気のアンバーと並べても取り違えない青。 */
export const BILL_GAS_COLOR = "#5b9bd5";

/** 水道の色。ガスの青と並べても取り違えない緑がかった水色。 */
export const BILL_WATER_COLOR = "#2bb5a0";

export type BillKind = "electricity" | "gas" | "water";

/** `2026-08` → `2026年8月分` */
export function formatBillingMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  if (!year || !value) return month;
  return `${year}年${value}月分`;
}

/** `2026-08` → `8月`。グラフの目盛りなど、幅が取れないところ用 */
export function formatBillingMonthShort(month: string): string {
  const [, value] = month.split("-").map(Number);
  if (!value) return month;
  return `${value}月`;
}

/** `m3` は画面では `m³` にする。単位が無ければ「—」 */
export function formatBillUsage(total: UtilityBillKindTotal | null | undefined): string {
  if (!total || total.usage_value == null) return "—";
  const unit = total.usage_unit === "m3" ? "m³" : total.usage_unit ?? "";
  return `${total.usage_value.toLocaleString("ja-JP")}${unit ? ` ${unit}` : ""}`;
}

/** 金額。`formatYen` と違い、カードの主役に置くので単位は呼び出し側が添える */
export function formatBillAmount(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return Math.round(amount).toLocaleString("ja-JP");
}

export function hasBillData(summary: UtilityBillSummary | null): boolean {
  return summary != null && (summary.latest != null || summary.latest_water != null);
}

/** 月ごとの色。種別から引く */
export function billKindColor(kind: BillKind): string {
  if (kind === "electricity") return BILL_ELECTRICITY_COLOR;
  if (kind === "gas") return BILL_GAS_COLOR;
  return BILL_WATER_COLOR;
}

export interface BillStackSegment {
  kind: BillKind;
  color: string;
  /** その月の合計に占める割合（0〜1） */
  share: number;
  amountYen: number;
}

export interface BillStackColumn {
  billingMonth: string;
  totalYen: number;
  /** 期間内でいちばん高かった月を 1 とした高さ */
  ratio: number;
  /** 下から積む順（電気・ガス・水道） */
  segments: BillStackSegment[];
}

/**
 * 月別の積み上げ棒。
 *
 * 高さは**期間内の最大値**で正規化する。0円を底にすると、金額の差が小さい月が
 * 並んだときに全部同じ高さに見えてしまう。
 */
export function buildBillStackColumns(
  months: readonly UtilityBillMonth[]
): BillStackColumn[] {
  const max = months.reduce((acc, month) => Math.max(acc, month.total_yen), 0);
  if (max <= 0) return [];

  return months.map((month) => {
    const segments: BillStackSegment[] = [];
    const push = (kind: BillKind, total: UtilityBillKindTotal | null | undefined) => {
      if (!total || total.amount_yen <= 0) return;
      segments.push({
        kind,
        color: billKindColor(kind),
        share: month.total_yen > 0 ? total.amount_yen / month.total_yen : 0,
        amountYen: total.amount_yen,
      });
    };
    push("electricity", month.electricity);
    push("gas", month.gas);
    push("water", month.water);

    return {
      billingMonth: month.billing_month,
      totalYen: month.total_yen,
      ratio: month.total_yen / max,
      segments,
    };
  });
}

/** 詳細パネルの一覧。新しい月が上に来るように並べ替える */
export function buildBillMonthRows(
  months: readonly UtilityBillMonth[]
): UtilityBillMonth[] {
  return [...months].sort((a, b) => b.billing_month.localeCompare(a.billing_month));
}

/**
 * カードの行に出す棒の長さ。その月いちばん高かった種別を 1 とする。
 * 電気とガスは桁が違うため、合計に対する割合にするとガスの棒が消える。
 */
export function billKindRatio(
  month: UtilityBillMonth | null,
  total: UtilityBillKindTotal | null | undefined
): number {
  if (!month || !total) return 0;
  const max = Math.max(
    month.electricity?.amount_yen ?? 0,
    month.gas?.amount_yen ?? 0,
    month.water?.amount_yen ?? 0
  );
  if (max <= 0) return 0;
  return Math.min(1, total.amount_yen / max);
}

/** 手入力フォームの下書き。数字は文字列のまま持つ（入力途中を壊さない・CLAUDE.md の数値入力欄の方針） */
export interface WaterBillDraft {
  billingMonth: string;
  amount: string;
  usage: string;
}

export interface WaterBillInput {
  billing_month: string;
  amount_yen: number;
  usage_m3: number | null;
}

/** 下書きを送る形へ。読めない・範囲外なら理由（日本語）を返す */
export function parseWaterBillDraft(
  draft: WaterBillDraft
): { ok: true; value: WaterBillInput } | { ok: false; message: string } {
  if (!/^\d{4}-\d{2}$/.test(draft.billingMonth)) {
    return { ok: false, message: "検針の月を選んでください" };
  }
  const amountText = draft.amount.replace(/[,，円\s]/g, "");
  if (!/^\d+$/.test(amountText)) {
    return { ok: false, message: "金額は数字で入力してください" };
  }
  const amount = Number(amountText);
  if (amount > 1_000_000) {
    return { ok: false, message: "金額が大きすぎます" };
  }
  let usage: number | null = null;
  const usageText = draft.usage.replace(/[\s]|m³|m3/g, "");
  if (usageText !== "") {
    if (!/^\d+(\.\d+)?$/.test(usageText)) {
      return { ok: false, message: "使用量は数字で入力してください" };
    }
    usage = Number(usageText);
    if (usage > 10_000) {
      return { ok: false, message: "使用量が大きすぎます" };
    }
  }
  return {
    ok: true,
    value: { billing_month: draft.billingMonth, amount_yen: amount, usage_m3: usage },
  };
}
