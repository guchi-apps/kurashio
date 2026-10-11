"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchEnergyLinks, linkEnergySources, unlinkEnergySource } from "@/lib/api";
import { describeLinkCandidate } from "@/lib/energy-links";
import type { EnergyLinkCandidate, EnergyLinks } from "@/lib/types";

interface EnergyLinkSheetProps {
  onClose: () => void;
  /** 関連付けを変えたとき。集計を取り直してもらうために親へ知らせる */
  onChanged: () => void;
}

/**
 * 取得元の関連付けシート（#768）。Tapoで改名すると機器IDで自動的に結ばれるが、機器IDを送る前に
 * 分かれた旧データは根拠が無いので、ここで期間と量を見て同じ機器か確かめてから結ぶ。
 * 押してすぐには結ばず、確認の文を出してからもう一度押させる。開いているあいだだけ呼び出し側がマウントする。
 */
export function EnergyLinkSheet({ onClose, onChanged }: EnergyLinkSheetProps) {
  const [links, setLinks] = useState<EnergyLinks | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEnergyLinks()
      .then((next) => {
        if (!cancelled) setLinks(next);
      })
      .catch(() => {
        if (!cancelled) setError("取得元の状況を読み込めませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<EnergyLinks>) => {
    setBusy(true);
    setError("");
    try {
      setLinks(await action());
      setConfirming(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const candidateKey = (c: EnergyLinkCandidate) => `${c.source}>${c.canonical}`;
  const linked = links?.sources.filter((s) => s.linked) ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[85vh] sm:rounded-[20px]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">取得元の関連付け</h2>
            <p className="text-sm text-muted-foreground">改名で分かれた履歴を同じ機器として結びます</p>
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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {!links && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}

          {links && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold">結べそうな取得元</h3>
              {links.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  結べそうな組はありません。新しい名前の取得元は、機器IDが一致すると自動で結ばれます
                </p>
              ) : (
                links.candidates.map((candidate) => {
                  const key = candidateKey(candidate);
                  const open = confirming === key;
                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-2 rounded-xl bg-amber-50 p-3 text-[13px] leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                    >
                      <p>{describeLinkCandidate(candidate)}。同じ機器か確認してください。</p>
                      {open && (
                        <p className="font-bold">
                          結ぶと「{candidate.label}」の履歴が「{candidate.canonical_label}」に合流します。
                          履歴は消えず、あとで解除できます。
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            open
                              ? run(() => linkEnergySources(candidate.source, candidate.canonical))
                              : setConfirming(key)
                          }
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                        >
                          {open ? "同じ機器として結ぶ" : `「${candidate.canonical_label}」に関連付ける…`}
                        </button>
                        {open && (
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="rounded-lg border px-3 py-1.5 text-xs font-bold"
                          >
                            やめる
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          )}

          {links && linked.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[13px] font-bold">関連付け済み</h3>
              <ul className="flex flex-col rounded-xl border px-3">
                {linked.map((item) => (
                  <li
                    key={item.source}
                    className="flex items-center justify-between gap-2 border-b py-2 text-[13px] last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-bold">
                        {item.label} → {item.canonical.replace(/^tapo:/, "")}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {item.first_date}〜{item.last_date}・{item.kwh_total.toFixed(1)} kWh
                        {item.device_id_known ? "・機器IDで確認済み" : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => unlinkEnergySource(item.source))}
                      className="shrink-0 rounded-lg border px-2.5 py-1 text-xs font-bold disabled:opacity-50"
                    >
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
