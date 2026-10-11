import type { EnergyLinkCandidate } from "@/lib/types";

/** `2026-10-11` を `10/11` へ。日付は文字列のまま切り出す（端末の時計で解釈しない） */
function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/** 関連付けの確認に出す1行。旧名の期間と量、新名の開始日を並べて、利用者に同一機器か確かめさせる */
export function describeLinkCandidate(candidate: EnergyLinkCandidate): string {
  const gap =
    candidate.gap_days <= 1 ? "翌日から" : `${candidate.gap_days}日あけて`;
  return (
    `「${candidate.label}」は${shortDate(candidate.old_first_date)}〜${shortDate(candidate.old_last_date)}` +
    `（${candidate.old_kwh_total.toFixed(1)} kWh）で止まり、` +
    `「${candidate.canonical_label}」が${gap}${shortDate(candidate.new_first_date)}から始まっています`
  );
}
