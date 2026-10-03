import type { EnergySourceRow } from "@/lib/types";

/** `GET /api/energy/tapo-candidates` の1台ぶん（#692）。サブPCがLANで見つけた機器 */
export interface TapoCandidateDevice {
  host: string;
  name: string;
  model: string | null;
  /** 消費電力を測れる機種か。P100 など測れない機器は読み取り対象にならない */
  measurable: boolean;
}

export interface TapoCandidates {
  requested_at: string | null;
  updated_at: string | null;
  devices: TapoCandidateDevice[];
  /** 更新を依頼して、サブPCから候補が届くのを待っている */
  pending: boolean;
  /** 依頼にサブPCからの応答がないまま期限切れになった */
  timed_out: boolean;
}

export type TapoCandidateStatus = "received" | "waiting" | "unmeasurable";

/** 更新中に結果を取りに行く間隔。サブPCの定期実行は5分ごとなので、こまめには見ない */
export const TAPO_CANDIDATES_POLL_MS = 10_000;

/**
 * 候補の状態。**使用量が届いているかは消費電力の取得元（`tapo:<名前>`）との突き合わせで決める。**
 * 計測できない機器は、届くことがないので別扱いにする。
 */
export function candidateStatus(
  device: TapoCandidateDevice,
  sources: readonly EnergySourceRow[]
): TapoCandidateStatus {
  if (sources.some((row) => row.source === `tapo:${device.name}`)) return "received";
  return device.measurable ? "waiting" : "unmeasurable";
}

export const TAPO_CANDIDATE_STATUS_LABEL: Record<TapoCandidateStatus, string> = {
  received: "電力データ受信済み",
  waiting: "未受信",
  unmeasurable: "計測なし",
};

/** `2026-10-02T10:42:00+09:00` -> `10:42`。サーバーが返したJST表記を切り出すだけで、端末の時計では解釈しない */
export function formatCandidateTime(value: string | null): string | null {
  if (!value) return null;
  const match = /T(\d{2}:\d{2})/.exec(value);
  return match ? match[1] : null;
}
