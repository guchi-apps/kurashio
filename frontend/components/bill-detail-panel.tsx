"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { deleteWaterBill, saveBillUsagePeriod, saveWaterBill } from "@/lib/api";
import {
  BILL_ELECTRICITY_COLOR,
  BILL_GAS_COLOR,
  BILL_WATER_COLOR,
  billKindColor,
  buildBillMonthRows,
  buildBillPeriodRows,
  buildBillStackColumns,
  formatBillUsage,
  formatBillingMonth,
  formatBillingMonthShort,
  formatUsagePeriod,
  parseUsagePeriodDraft,
  parseWaterBillDraft,
  singleUsagePeriod,
  type BillKind,
  type BillPeriodRow,
} from "@/lib/bills";
import { formatYen } from "@/lib/energy";
import type { UtilityBillMonth, UtilityBillSummary } from "@/lib/types";
import { useUnsavedEdits } from "@/lib/unsaved-edits";

interface BillDetailPanelProps {
  open: boolean;
  summary: UtilityBillSummary | null;
  onClose: () => void;
  /** 水道料金を保存・削除したあと。呼び出し側が集計を取り直す */
  onSaved?: () => void;
}

function Tile({
  caption,
  amountYen,
  sub,
  period,
}: {
  caption: string;
  amountYen: number | null;
  sub?: string;
  /** 使用期間（#884）。分からなければ出さない */
  period?: string | null;
}) {
  return (
    <div className="rounded-2xl bg-muted px-3 py-2.5">
      <div className="text-[11px] leading-tight text-muted-foreground">{caption}</div>
      <div className="mt-0.5 text-[18px] font-bold leading-tight tracking-tight tabular-nums">
        {formatYen(amountYen)}
      </div>
      {sub && (
        <div className="text-[11.5px] text-muted-foreground tabular-nums">{sub}</div>
      )}
      {period && (
        <div className="text-[11px] text-muted-foreground tabular-nums">{period}</div>
      )}
    </div>
  );
}

/**
 * 水道料金の手入力。2か月に1回届く使用明細の「検針月」「請求額」「使用量」を写す。
 *
 * 数字は文字列の下書きで持ち、「記録する」を押したときだけ読む（入力途中を壊さない）。
 * 同じ検針月はサーバー側で上書きするので、直すときは入れ直せばよい。
 */
function WaterBillForm({
  months,
  onSaved,
}: {
  months: readonly UtilityBillMonth[];
  onSaved?: () => void;
}) {
  const [billingMonth, setBillingMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [usage, setUsage] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const waterMonths = months.filter((month) => month.water != null).reverse();

  const handleSave = async () => {
    const parsed = parseWaterBillDraft({ billingMonth, amount, usage });
    if (!parsed.ok) {
      setMessage({ text: parsed.message, error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await saveWaterBill(parsed.value);
      setAmount("");
      setUsage("");
      setMessage({ text: "記録しました", error: false });
      onSaved?.();
    } catch {
      setMessage({ text: "記録できませんでした。入力を確かめてもう一度お試しください", error: true });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (month: string) => {
    if (!window.confirm(`${formatBillingMonth(month)}の水道料金を消しますか？`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteWaterBill(month);
      onSaved?.();
    } catch {
      setMessage({ text: "消せませんでした", error: true });
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "h-10 min-w-0 rounded-xl border bg-background px-3 text-[14px] tabular-nums";

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border p-3.5">
      <div>
        <h3 className="text-[13.5px] font-bold">水道料金を記入</h3>
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          2か月に1回届く使用明細の、検針月と請求額を入れてください。同じ検針月は上書きされます。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
          検針月
          <input
            type="month"
            value={billingMonth}
            onChange={(event) => setBillingMonth(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
          請求額（円）
          <input
            type="text"
            inputMode="numeric"
            placeholder="5,120"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-[11.5px] text-muted-foreground">
          使用量（m³・わかれば）
          <input
            type="text"
            inputMode="decimal"
            placeholder="20"
            value={usage}
            onChange={(event) => setUsage(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={busy}
        className="h-10 rounded-xl bg-primary text-[14px] font-bold text-primary-foreground disabled:opacity-50"
      >
        記録する
      </button>
      {message && (
        <p
          role="status"
          className={
            message.error ? "text-[12px] text-destructive" : "text-[12px] text-muted-foreground"
          }
        >
          {message.text}
        </p>
      )}
      {waterMonths.length > 0 && (
        <ul className="flex flex-col gap-1 border-t pt-2 text-[13px] tabular-nums">
          {waterMonths.map((month) => (
            <li key={month.billing_month} className="flex items-center gap-2">
              <span className="w-[74px] shrink-0 text-muted-foreground">
                {formatBillingMonth(month.billing_month)}
              </span>
              <span>{formatYen(month.water?.amount_yen)}</span>
              <span className="text-[12px] text-muted-foreground">
                {formatBillUsage(month.water)}
              </span>
              <button
                type="button"
                onClick={() => void handleDelete(month.billing_month)}
                disabled={busy}
                className="ml-auto rounded-lg px-2 py-1 text-[12px] text-destructive hover:bg-accent disabled:opacity-50"
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_NAMES: Record<BillKind, string> = {
  electricity: "電気",
  gas: "ガス",
  water: "水道",
};

/** 畳んでいるときに出す行数 */
const PERIOD_ROWS_COLLAPSED = 4;

/**
 * 請求1件の使用期間の入力。開いているあいだだけ描くので、下書きの初期値は保存済みの値になる。
 */
function UsagePeriodEditor({
  row,
  onDone,
}: {
  row: BillPeriodRow;
  onDone: (saved: boolean) => void;
}) {
  const [start, setStart] = useState(row.start ?? "");
  const [end, setEnd] = useState(row.end ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedEdits();

  const save = async (value: { usage_start: string | null; usage_end: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      await saveBillUsagePeriod({
        billing_month: row.billingMonth,
        kind: row.kind,
        contract_key: row.contractKey,
        ...value,
      });
      onDone(true);
    } catch {
      setError("保存できませんでした。もう一度お試しください");
      setBusy(false);
    }
  };

  const handleSave = () => {
    const parsed = parseUsagePeriodDraft({ start, end });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void save(parsed.value);
  };

  const inputClass =
    "h-10 w-full min-w-0 rounded-xl border bg-background px-2 text-[14px] tabular-nums";
  const buttonClass = "h-9 rounded-xl px-3 text-[13px] font-bold disabled:opacity-50";

  return (
    <div className="flex flex-col gap-2 pb-1">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-[11.5px] text-muted-foreground">
          使用開始日
          <input
            type="date"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[11.5px] text-muted-foreground">
          使用終了日
          <input
            type="date"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className={`${buttonClass} bg-primary text-primary-foreground`}
        >
          保存
        </button>
        <button
          type="button"
          onClick={() => onDone(false)}
          disabled={busy}
          className={`${buttonClass} border`}
        >
          やめる
        </button>
        {row.start && (
          <button
            type="button"
            onClick={() => void save({ usage_start: null, usage_end: null })}
            disabled={busy}
            className={`${buttonClass} ml-auto text-destructive`}
          >
            期間を消す
          </button>
        )}
      </div>
      {error && (
        <p role="status" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** 請求ごとの使用期間（#884）。電気は自動で入ることがあり、どの行も手で直せる */
function UsagePeriodList({
  months,
  onSaved,
}: {
  months: readonly UtilityBillMonth[];
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = buildBillPeriodRows(months);
  if (rows.length === 0) return null;
  const visible = showAll ? rows : rows.slice(0, PERIOD_ROWS_COLLAPSED);

  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-3.5">
      <h3 className="text-[13.5px] font-bold">使用期間</h3>
      <ul className="flex flex-col gap-1.5 text-[13px] tabular-nums">
        {visible.map((row) => {
          const key = `${row.billingMonth}:${row.kind}:${row.contractKey}`;
          const period = formatUsagePeriod(row.start, row.end);
          const label = `${formatBillingMonth(row.billingMonth)} ${KIND_NAMES[row.kind]}`;
          return (
            <li key={key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: billKindColor(row.kind) }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] text-muted-foreground">
                    {label}
                    {row.planName && `（${row.planName}・${formatYen(row.amountYen)}）`}
                  </div>
                  <div className={period ? undefined : "text-muted-foreground"}>
                    {period ?? "未入力"}
                  </div>
                </div>
                {editing !== key && (
                  <button
                    type="button"
                    onClick={() => setEditing(key)}
                    aria-label={`${label}の使用期間を${period ? "直す" : "入れる"}`}
                    className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-primary hover:bg-accent"
                  >
                    {period ? "直す" : "入れる"}
                  </button>
                )}
              </div>
              {editing === key && (
                <UsagePeriodEditor
                  row={row}
                  onDone={(saved) => {
                    setEditing(null);
                    if (saved) onSaved?.();
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > PERIOD_ROWS_COLLAPSED && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="self-start rounded-lg px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent"
        >
          {showAll ? "少なく表示" : `すべて表示（${rows.length}件）`}
        </button>
      )}
    </div>
  );
}

/**
 * 電気・ガス・水道料金カードの詳細。
 *
 * 月ごとの請求は年に12回しか動かないので、日別のような密なグラフにはしない。
 * 記録のある月だけを積み上げ棒で並べ、下に金額と使用量の一覧を置く。
 */
export function BillDetailPanel({ open, summary, onClose, onSaved }: BillDetailPanelProps) {
  if (!open) return null;

  const months = summary?.months ?? [];
  const columns = buildBillStackColumns(months);
  const rows = buildBillMonthRows(months);
  const latest = summary?.latest ?? null;
  const latestWater = summary?.latest_water ?? null;
  const measured = summary?.measured ?? null;

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex min-h-0 max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[88vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">電気・ガス・水道料金</h2>
            <p className="text-xs text-muted-foreground">
              {latest
                ? `最新は ${formatBillingMonth(latest.billing_month)}`
                : "請求のお知らせ待ち"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-accent"
            aria-label="閉じる"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [-webkit-overflow-scrolling:touch]">
          <div className="flex flex-col gap-4">
            {(latest || latestWater) && (
              <div className="grid grid-cols-2 gap-2">
                <Tile
                  caption="電気"
                  amountYen={latest?.electricity?.amount_yen ?? null}
                  sub={formatBillUsage(latest?.electricity)}
                  period={singleUsagePeriod(latest?.electricity)}
                />
                <Tile
                  caption="ガス"
                  amountYen={latest?.gas?.amount_yen ?? null}
                  sub={formatBillUsage(latest?.gas)}
                  period={singleUsagePeriod(latest?.gas)}
                />
                <Tile
                  caption={
                    latestWater ? `水道（${formatBillingMonth(latestWater.billing_month)}）` : "水道"
                  }
                  amountYen={latestWater?.water?.amount_yen ?? null}
                  sub={formatBillUsage(latestWater?.water)}
                  period={singleUsagePeriod(latestWater?.water)}
                />
                <Tile
                  caption={`直近${months.length}か月`}
                  amountYen={summary?.total_yen ?? null}
                  sub="電気＋ガス＋水道"
                />
              </div>
            )}

            {columns.length > 1 && (
              <div className="flex flex-col gap-2">
                <div className="flex h-[120px] items-end gap-[5px]">
                  {columns.map((column) => (
                    <div
                      key={column.billingMonth}
                      className="flex min-w-0 flex-1 flex-col justify-end gap-[1.5px]"
                      style={{ height: `${Math.max(4, column.ratio * 100)}%` }}
                      title={`${formatBillingMonth(column.billingMonth)} ${formatYen(
                        column.totalYen
                      )}`}
                    >
                      {/* 上から積むので、下に置きたい電気を後ろに回す */}
                      {[...column.segments].reverse().map((segment) => (
                        <span
                          key={segment.kind}
                          className="block min-h-px rounded-[2px]"
                          style={{
                            height: `${segment.share * 100}%`,
                            backgroundColor: segment.color,
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="flex gap-[5px] border-t pt-1.5 text-[10.5px] text-muted-foreground tabular-nums">
                  {columns.map((column) => (
                    <span
                      key={column.billingMonth}
                      className="min-w-0 flex-1 truncate text-center"
                    >
                      {formatBillingMonthShort(column.billingMonth)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2 rounded-[3px]"
                  style={{ backgroundColor: BILL_ELECTRICITY_COLOR }}
                  aria-hidden
                />
                電気
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2 rounded-[3px]"
                  style={{ backgroundColor: BILL_GAS_COLOR }}
                  aria-hidden
                />
                ガス
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2 rounded-[3px]"
                  style={{ backgroundColor: BILL_WATER_COLOR }}
                  aria-hidden
                />
                水道
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[11.5px] text-muted-foreground">
                <span>請求月（記録のある月だけ）</span>
                <span>電気 / ガス / 水道 / 合計</span>
              </div>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  まだ請求のお知らせを受け取っていません
                </p>
              ) : (
                rows.map((row) => (
                  <div
                    key={row.billing_month}
                    className="flex items-center gap-2 text-[13px] tabular-nums"
                  >
                    <span className="w-[74px] shrink-0 text-muted-foreground">
                      {formatBillingMonth(row.billing_month)}
                    </span>
                    <span className="w-[60px] shrink-0 text-right">
                      {formatYen(row.electricity?.amount_yen)}
                    </span>
                    <span className="w-[56px] shrink-0 text-right text-muted-foreground">
                      {formatYen(row.gas?.amount_yen)}
                    </span>
                    <span className="w-[56px] shrink-0 text-right text-muted-foreground">
                      {formatYen(row.water?.amount_yen)}
                    </span>
                    <span className="ml-auto font-bold">
                      {formatYen(row.total_yen)}
                    </span>
                  </div>
                ))
              )}
            </div>

            <UsagePeriodList months={months} onSaved={onSaved} />

            <WaterBillForm months={months} onSaved={onSaved} />

            <div className="flex flex-col gap-1.5 border-t pt-3 text-[11.5px] leading-relaxed text-muted-foreground">
              <p>
                関西電力「はぴeみる電」から届く検針結果のメールを読み取っています。検針日から原則5営業日以内に届き、そのタイミングで更新されます。今月ぶんは検針が終わるまで確定しないため、最新は原則「先月分」です。
              </p>
              {measured?.share_percent != null && (
                <p>
                  {measured.by_usage_period
                    ? `使用期間（${formatUsagePeriod(measured.start, measured.end)}）`
                    : "同じ月"}
                  にエアコンとスマートプラグで計測できたのは{" "}
                  {formatYen(measured.cost_yen)}（{measured.kwh} kWh）で、電気の請求額の{" "}
                  {measured.share_percent}% にあたります。
                  {!measured.by_usage_period &&
                    "請求の対象期間は検針日から検針日までで暦月とはずれるため、この割合は目安です。"}
                </p>
              )}
              <p>
                使用期間はメールに載っていません。電気は、取り込んだ時間ごとの使用量の合計が請求の使用量と一致したときに自動で入ります。入らない分は上の「使用期間」で入力してください。
              </p>
              <p>
                水道料金は取得元が無いため、検針のたびに明細を見て手で記入します（2か月に1回）。
              </p>
              <p>
                日ごと・時間ごとの使用量はメールに含まれていません（はぴeみる電の画面にのみあります）。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
