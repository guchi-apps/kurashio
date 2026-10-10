"use client";

import { ReceiptText } from "lucide-react";
import {
  BILL_ELECTRICITY_COLOR,
  BILL_GAS_COLOR,
  BILL_WATER_COLOR,
  billKindRatio,
  formatBillAmount,
  formatBillUsage,
  formatBillingMonth,
  formatBillingMonthShort,
  hasBillData,
} from "@/lib/bills";
import { formatYen } from "@/lib/energy";
import type {
  UtilityBillKindTotal,
  UtilityBillMonth,
  UtilityBillSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface BillCardProps {
  summary: UtilityBillSummary | null;
  loading: boolean;
  error: boolean;
  onOpenDetail: () => void;
}

function CardShell({
  children,
  onClick,
  billingMonth,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  billingMonth?: string | null;
}) {
  const head = (
    <div className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <p className="device-card-title flex min-w-0 items-center gap-2">
          <ReceiptText
            className="size-5 shrink-0"
            strokeWidth={1.9}
            style={{ color: "var(--bill-color)" }}
          />
          電気・ガス・水道料金
        </p>
        {billingMonth && (
          <span
            className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold tabular-nums"
            style={{
              backgroundColor: "var(--bill-surface)",
              color: "var(--bill-color)",
            }}
          >
            {formatBillingMonth(billingMonth)}
          </span>
        )}
      </div>
      {/*
        同じ「暮らし」に、消費電力カードの「今月 ◯◯円」（機器ごとの実測に単価を掛けた目安・
        暦月）と、このカードの請求額（検針期間・実額）が並ぶ。どちらが電気代なのか
        読み手に決めさせないよう、出どころを1行で言い切る。
      */}
      {billingMonth && (
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          検針で確定した請求額
        </p>
      )}
    </div>
  );

  if (!onClick) {
    return (
      <div className="device-card gap-3">
        {head}
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="device-card gap-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {head}
      {children}
    </button>
  );
}

/**
 * 種別1件ぶんの行。棒の長さは「その月で高かったほう」を 1 とする。
 * 合計に対する割合にすると、桁の違うガスの棒が消えてしまう。
 */
function KindRow({
  label,
  color,
  total,
  month,
  note,
}: {
  label: string;
  color: string;
  total: UtilityBillKindTotal | null | undefined;
  month: UtilityBillMonth;
  /** 電気・ガスの月と違うときに添える（水道は検針の月がずれる） */
  note?: string;
}) {
  const missing = total == null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[13px] tabular-nums",
        missing && "opacity-55"
      )}
    >
      <span
        className="size-2 shrink-0 rounded-[3px]"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="w-10 shrink-0 truncate font-bold">{label}</span>
      <span className="w-[68px] shrink-0 text-right">
        {formatYen(total?.amount_yen)}
      </span>
      <span className="w-[62px] shrink-0 text-right text-[12px] text-muted-foreground">
        {formatBillUsage(total)}
      </span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${billKindRatio(month, total) * 100}%`,
            backgroundColor: color,
          }}
        />
      </span>
      {note && (
        <span className="shrink-0 text-[11px] text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

/**
 * 「暮らし」セクションの電気・ガス料金カード。
 *
 * 隣の消費電力カードが「機器ごとに計測できている分」を日ごとに積み上げたものなのに対し、
 * こちらは**電力会社が確定させた実際の請求**。燃料費調整額も再エネ賦課金も入った額で、
 * 単価を掛けた目安ではない。2枚を並べたときに読み取れるよう、最後の行に
 * 「請求のうちどこまでを機器ごとに追えているか」を出す。
 *
 * 請求は月に1回しか動かないので、表側は最新の1か月だけ。推移はタップで開く詳細に置く。
 */
export function BillCard({ summary, loading, error, onOpenDetail }: BillCardProps) {
  if (loading && !summary) {
    return (
      <CardShell>
        <div className="flex flex-col gap-2.5">
          <div className="h-[52px] animate-pulse rounded-2xl bg-muted" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      </CardShell>
    );
  }

  if (error && !summary) {
    return (
      <CardShell>
        <p className="text-sm text-destructive">請求額を読み込めませんでした</p>
      </CardShell>
    );
  }

  if (!hasBillData(summary)) {
    return (
      <CardShell>
        <p className="text-sm text-muted-foreground">
          まだ請求のお知らせを受け取っていません。はぴeみる電から検針結果のメールが届くと、ここに確定した電気・ガス料金が出ます。水道料金は詳細から記入できます。
        </p>
      </CardShell>
    );
  }

  const data = summary as UtilityBillSummary;
  const latestWater = data.latest_water ?? null;
  // 電気・ガスがまだ届いていなくても水道だけ記入できるので、その場合は水道の月を使う
  const latest = (data.latest ?? latestWater) as UtilityBillMonth;
  const { comparison, measured } = data;
  const waterMonthDiffers =
    latestWater != null && latestWater.billing_month !== latest.billing_month;

  return (
    <CardShell onClick={onOpenDetail} billingMonth={latest.billing_month}>
      <div
        className="flex items-baseline gap-2.5 rounded-2xl px-3.5 py-2.5"
        style={{ backgroundColor: "var(--energy-surface)" }}
      >
        <span className="text-[12px] text-muted-foreground">電気</span>
        <span className="text-[27px] font-bold leading-none tracking-tight tabular-nums">
          {formatBillAmount(latest.electricity?.amount_yen)}
        </span>
        <span className="text-[13px] font-bold text-muted-foreground">円</span>
        <span className="ml-auto text-sm font-bold text-muted-foreground tabular-nums">
          {formatBillUsage(latest.electricity)}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <KindRow
          label="電気"
          color={BILL_ELECTRICITY_COLOR}
          total={latest.electricity}
          month={latest}
        />
        <KindRow
          label="ガス"
          color={BILL_GAS_COLOR}
          total={latest.gas}
          month={latest}
        />
        <KindRow
          label="水道"
          color={BILL_WATER_COLOR}
          total={latestWater?.water}
          month={latestWater ?? latest}
          note={
            waterMonthDiffers && latestWater
              ? formatBillingMonthShort(latestWater.billing_month)
              : undefined
          }
        />
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-2.5 text-[12px] text-muted-foreground tabular-nums">
        <span>
          合計{" "}
          <b className="text-[13px] font-bold text-foreground">
            {formatYen(latest.total_yen)}
          </b>
        </span>
        {comparison && (
          <span>
            前月より{" "}
            <b
              className={cn(
                "font-bold",
                comparison.cheaper
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-orange-600 dark:text-orange-400"
              )}
            >
              {comparison.percent}% {comparison.cheaper ? "少ない" : "多い"}
            </b>
          </span>
        )}
      </div>

      {measured?.share_percent != null && (
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          請求のうち、機器ごとに追えているのは{" "}
          <b className="font-bold text-foreground">{measured.share_percent}%</b>（
          {formatYen(measured.cost_yen)}）
        </p>
      )}
    </CardShell>
  );
}
