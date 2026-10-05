"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { fetchEnergyRefetch, requestEnergyRefetch } from "@/lib/api";
import { shiftEnergyDate } from "@/lib/energy";
import {
  ENERGY_REFETCH_POLL_MS,
  ENERGY_REFETCH_QUICK_DAYS,
  ENERGY_REFETCH_SOURCE_LABEL,
  ENERGY_REFETCH_SOURCE_NOTE,
  ENERGY_REFETCH_STATUS_LABEL,
  earliestRefetchDate,
  formatRefetchDate,
  formatRefetchTime,
  isValidRefetchDate,
  refetchSpanDays,
  type EnergyRefetch,
  type EnergyRefetchKind,
  type EnergyRefetchStatus,
} from "@/lib/energy-refetch";
import { useUnsavedEdits } from "@/lib/unsaved-edits";

const KINDS: readonly EnergyRefetchKind[] = ["tapo", "aircon"];

const PILL_CLASS: Record<EnergyRefetchStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  waiting: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  timed_out: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

interface EnergyRefetchSheetProps {
  /** 今日（JST）の日付 `YYYY-MM-DD`。端末の時計ではなく集計の応答の値を使う */
  today: string;
  onClose: () => void;
  /** 取得元が1つでも完了したとき。集計を取り直してもらうために親へ知らせる */
  onCompleted: () => void;
}

/** ヘッダーに出す一文。状態から決めるだけの純関数 */
export function refetchSubtitle(state: EnergyRefetch | null): string {
  if (!state || !state.since) return "取得できなかった日を取り直します";
  const since = formatRefetchDate(state.since);
  if (state.pending) return `${since}以降を依頼しました`;
  const allDone = KINDS.every((kind) => state.sources[kind].status === "done");
  return allDone ? `${since}以降の取得が済みました` : `${since}以降の取得が完了しませんでした`;
}

/**
 * 消費電力の「指定日以降の再取得」シート（#711）。
 *
 * プラグ・エアコンのクラウドはサブPCの収集が読むので、ここでは依頼を出して進み具合を見る
 * だけ（Tapoの候補更新と同じ形）。開いているあいだだけ呼び出し側がマウントする。
 */
export function EnergyRefetchSheet({ today, onClose, onCompleted }: EnergyRefetchSheetProps) {
  const [since, setSince] = useState(() => shiftEnergyDate(today, -4));
  const [state, setState] = useState<EnergyRefetch | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 日付を選んだだけの入力を、画面復帰時の自動リロードで捨てない（#277）
  useUnsavedEdits();

  const pending = state?.pending ?? false;
  const doneCount = state ? KINDS.filter((k) => state.sources[k].status === "done").length : 0;

  // 開いたときに最後の依頼の状況を読む
  useEffect(() => {
    let cancelled = false;
    fetchEnergyRefetch()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setError("状況を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 待っている間だけ、間隔を空けて取り直す。全部届けば `pending` が落ちて止まる
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchEnergyRefetch()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => {
          if (!cancelled) setError("状況を読み込めませんでした");
        });
    }, ENERGY_REFETCH_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending, state]);

  // 完了した取得元が増えたら、集計を取り直してもらう
  useEffect(() => {
    if (doneCount > 0) onCompleted();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 件数が変わったときだけ知らせる
  }, [doneCount]);

  const valid = isValidRefetchDate(since, today);
  const span = valid ? refetchSpanDays(since, today) : 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");
    try {
      setState(await requestEnergyRefetch(since));
    } catch (err) {
      setError(err instanceof Error ? err.message : "再取得を依頼できませんでした");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = pending || submitting;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[85vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">データの再取得</h2>
            <p className="truncate text-sm text-muted-foreground" aria-live="polite">
              {refetchSubtitle(state)}
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

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-5 py-4">
          {!pending && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="energy-refetch-since" className="text-[13px] font-bold">
                  この日以降を取り直す
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="energy-refetch-since"
                    type="date"
                    value={since}
                    min={earliestRefetchDate(today)}
                    max={today}
                    onChange={(e) => setSince(e.target.value)}
                    className="min-w-0 flex-1 rounded-xl border bg-card px-3 py-2 text-sm tabular-nums"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {valid ? `${span}日ぶん` : "日付を確認してください"}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ENERGY_REFETCH_QUICK_DAYS.map(({ days, label }) => {
                  const date = shiftEnergyDate(today, -days);
                  const on = since === date;
                  return (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setSince(date)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-xs font-bold transition-colors ${
                        on ? "border-primary bg-accent text-foreground" : "hover:bg-accent"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <ul className="flex flex-col rounded-xl border px-3">
            {KINDS.map((kind) => {
              const source = state?.sources[kind];
              const status: EnergyRefetchStatus = source?.status ?? "idle";
              const doneAt = formatRefetchTime(source?.done_at ?? null);
              return (
                <li key={kind} className="flex items-center gap-2.5 border-t py-2.5 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-bold">
                      {ENERGY_REFETCH_SOURCE_LABEL[kind]}
                    </p>
                    <p className="text-[11.5px] text-muted-foreground">
                      {status === "done" && doneAt
                        ? `${doneAt} に取得しました`
                        : `${ENERGY_REFETCH_SOURCE_NOTE[kind]}（最大${source?.max_days ?? ""}日前まで）`}
                    </p>
                  </div>
                  <span
                    className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${PILL_CLASS[status]}`}
                  >
                    {ENERGY_REFETCH_STATUS_LABEL[status]}
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            {pending
              ? "依頼から最大90分待ちます。この画面を閉じても、サブPCは取得を続けます。"
              : "サブPCが次の定期実行で取り直します。同じ日は上書きされるので、二重には数えません。取得できなかった日は、取れた分だけ反映されます。"}
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="shrink-0 border-t px-5 py-4">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || !valid}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-bold text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {busy && (
              <RefreshCw
                className="size-4 animate-spin motion-reduce:animate-none"
                strokeWidth={2.2}
              />
            )}
            {pending
              ? "取得待ち…"
              : submitting
                ? "依頼中…"
                : valid
                  ? `${formatRefetchDate(since)}以降を再取得する`
                  : "再取得する"}
          </button>
        </div>
      </div>
    </div>
  );
}
