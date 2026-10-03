"use client";

import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw, X, Zap } from "lucide-react";
import { fetchTapoCandidates, refreshTapoCandidates } from "@/lib/api";
import {
  TAPO_CANDIDATES_POLL_MS,
  TAPO_CANDIDATE_STATUS_LABEL,
  candidateStatus,
  formatCandidateTime,
  type TapoCandidateStatus,
  type TapoCandidates,
} from "@/lib/tapo-candidates";
import { useUnsavedEdits } from "@/lib/unsaved-edits";
import type { EnergySourceRow } from "@/lib/types";

/** 別名に付けられる長さ。`backend/ui_settings.py` の `MAX_ENERGY_SOURCE_NAME_LENGTH` と同じ */
export const MAX_ENERGY_SOURCE_NAME_LENGTH = 20;

interface EnergySourceNameSheetProps {
  /** 名前を付け替えられる取得元（スマートプラグ）。並びは消費電力カードと同じ */
  sources: readonly EnergySourceRow[];
  /** 取得元 -> 色。行の先頭に出す四角に使う */
  colors: Record<string, string>;
  onClose: () => void;
  /** 保存。渡すのは「別名を付けた取得元だけ」の辞書 */
  onSave: (names: Record<string, string>) => Promise<void>;
}

/**
 * 入力欄の初期値。**既定の名前のままなら空にする**（#335）。
 *
 * 空欄にはプレースホルダとして既定の名前が出るので、「上書きしていない」ことが
 * そのまま見える。`remote-button-settings-sheet.tsx` と同じ考え方。
 */
export function buildEnergyNameDrafts(
  sources: readonly EnergySourceRow[]
): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const row of sources) {
    drafts[row.source] = row.label === row.default_label ? "" : row.label;
  }
  return drafts;
}

/** 保存する形へ。空欄（＝上書きなし）の取得元はキーごと落とす */
export function buildEnergyNameUpdate(
  drafts: Record<string, string>
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [source, value] of Object.entries(drafts)) {
    const name = value.trim();
    if (name) names[source] = name;
  }
  return names;
}


const STATUS_CLASS: Record<TapoCandidateStatus, string> = {
  received: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  waiting: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unmeasurable: "bg-muted text-muted-foreground",
};

interface TapoCandidatesViewProps {
  candidates: TapoCandidates | null;
  sources: readonly EnergySourceRow[];
  /** 更新ボタンを押してから、結果を受け取るまで */
  waiting: boolean;
  error: string;
  onRefresh: () => void;
}

/**
 * 「Tapoの候補」欄（#692）。探索はサブPCが行うので、押してから届くまで最大5分ほどかかる。
 * 受け取るまでボタンは「更新中…」にして、前回の一覧はそのまま見せておく。
 */
export function TapoCandidatesView({
  candidates,
  sources,
  waiting,
  error,
  onRefresh,
}: TapoCandidatesViewProps) {
  const updatedAt = formatCandidateTime(candidates?.updated_at ?? null);
  const devices = candidates?.devices ?? [];
  let status = "まだ探していません。「候補を更新」を押すと、サブPCがTapoを探します。";
  if (waiting) {
    status = `サブPCに探すよう依頼しました。最大5分ほどかかります${
      updatedAt ? `（前回: ${updatedAt}）` : ""
    }`;
  } else if (updatedAt) {
    status = `最終更新 ${updatedAt} · ${devices.length}台`;
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[13.5px] font-bold">Tapoの候補</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={waiting}
          className="flex h-[34px] items-center gap-1.5 rounded-full border bg-card px-3 text-[13px] font-bold transition-colors hover:bg-accent disabled:text-muted-foreground"
        >
          <RefreshCw
            className={`size-[15px] ${waiting ? "animate-spin motion-reduce:animate-none" : ""}`}
            strokeWidth={2.2}
          />
          {waiting ? "更新中…" : "候補を更新"}
        </button>
      </div>
      <p className="text-[11.5px] text-muted-foreground" aria-live="polite">
        {status}
      </p>
      {devices.length > 0 && (
        <ul className="flex flex-col">
          {devices.map((device) => {
            const state = candidateStatus(device, sources);
            return (
              <li
                key={device.host}
                className="flex items-center gap-2.5 border-t py-2 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-bold">{device.name}</p>
                  <p className="text-[11.5px] tabular-nums text-muted-foreground">
                    {device.host}
                    {device.model ? ` · ${device.model}` : ""}
                  </p>
                </div>
                <span
                  className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CLASS[state]}`}
                >
                  {TAPO_CANDIDATE_STATUS_LABEL[state]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!waiting && updatedAt && devices.length === 0 && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Tapoが見つかりませんでした。プラグがサブPCと同じLANにあるか、`collectors/.env` の
          TAPO_USERNAME / TAPO_PASSWORD が合っているかを確認してください。
        </p>
      )}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

/**
 * 消費電力の取得元（スマートプラグ）に付ける名前を決めるシート（#335）。
 *
 * 取得元の名前はTapoアプリで付けたものが `daily_energy.source`（`tapo:冷蔵庫`）に
 * そのまま入っている。**ここで変えるのは表示名だけで、`source` は変えない。**
 * `source` を書き換えると `(date, source)` が別物になり、過去の使用量と切れる。
 *
 * **開いている間だけ呼び出し側がマウントする。** 入力途中の値は閉じれば消えるべきなので、
 * 状態を持ち越さずに毎回 `sources` から作り直す。
 */
export function EnergySourceNameSheet({
  sources,
  colors,
  onClose,
  onSave,
}: EnergySourceNameSheetProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    buildEnergyNameDrafts(sources)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<TapoCandidates | null>(null);
  const [candidatesError, setCandidatesError] = useState("");
  // 「保存する」を押すまでサーバーには書かない。開いている間は自動更新の
  // リロードを止め、書きかけの入力を捨てないようにする（#277）
  useUnsavedEdits();

  const pending = candidates?.pending ?? false;

  // 開いたときに最後の候補を読む
  useEffect(() => {
    let cancelled = false;
    fetchTapoCandidates()
      .then((next) => {
        if (!cancelled) setCandidates(next);
      })
      .catch(() => {
        if (!cancelled) setCandidatesError("候補を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 更新を待っている間だけ、間隔を空けて取り直す。届けば `pending` が落ちて止まる
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchTapoCandidates()
        .then((next) => {
          if (!cancelled) setCandidates(next);
        })
        .catch(() => {
          if (!cancelled) setCandidatesError("候補を読み込めませんでした");
        });
    }, TAPO_CANDIDATES_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending, candidates]);

  const handleRefresh = async () => {
    setCandidatesError("");
    try {
      setCandidates(await refreshTapoCandidates());
    } catch (err) {
      setCandidatesError(err instanceof Error ? err.message : "更新を依頼できませんでした");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(buildEnergyNameUpdate(drafts));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[85vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Zap
              className="size-5 shrink-0"
              strokeWidth={1.9}
              style={{ color: "var(--energy-color)" }}
            />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">取得元の名前</h2>
              <p className="truncate text-sm text-muted-foreground">
                スマートプラグ {sources.length} 台
              </p>
            </div>
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
          <TapoCandidatesView
            candidates={candidates}
            sources={sources}
            waiting={pending}
            error={candidatesError}
            onRefresh={() => void handleRefresh()}
          />

          {sources.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              名前を変えられるスマートプラグがありません。使用量を受け取ると、ここに並びます。
            </p>
          ) : (
            <>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                アプリの中での呼び名を決めます。空にすると、Tapoアプリで付けた名前に戻ります。
              </p>

              {sources.map((row) => {
                const draft = drafts[row.source] ?? "";
                const inputId = `energy-source-name-${row.source}`;
                return (
                  <div key={row.source} className="flex flex-col gap-1.5">
                    <label
                      htmlFor={inputId}
                      className="flex items-center gap-2 text-[13px] font-bold"
                    >
                      <span
                        className="size-2 shrink-0 rounded-[3px]"
                        style={{ backgroundColor: colors[row.source] ?? "#95a5a6" }}
                        aria-hidden
                      />
                      <span className="truncate">{row.default_label}</span>
                      <code className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-normal text-muted-foreground">
                        {row.source}
                      </code>
                    </label>
                    <input
                      id={inputId}
                      type="text"
                      value={draft}
                      maxLength={MAX_ENERGY_SOURCE_NAME_LENGTH}
                      placeholder={row.default_label}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [row.source]: e.target.value }))
                      }
                      className="rounded-xl border bg-card px-3 py-2 text-sm"
                    />
                    <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
                      <span className="truncate">Tapoの名前: {row.default_label}</span>
                      {draft.trim() && (
                        <button
                          type="button"
                          onClick={() =>
                            setDrafts((prev) => ({ ...prev, [row.source]: "" }))
                          }
                          className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 transition-colors hover:bg-accent"
                        >
                          <RotateCcw className="size-3" strokeWidth={2.2} />
                          既定に戻す
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              <p className="border-t pt-3 text-[11.5px] leading-relaxed text-muted-foreground">
                名前を変えても、これまでの使用量の記録はそのまま引き継がれます。
              </p>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="shrink-0 border-t px-5 py-4">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || sources.length === 0}
            className="h-11 w-full rounded-xl bg-foreground text-sm font-bold text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存する"}
          </button>
        </div>
      </div>
    </div>
  );
}
