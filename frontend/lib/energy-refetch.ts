import { shiftEnergyDate } from "@/lib/energy";

/** 取得元（サブPCの収集）。`backend/energy_refetch.py` の `KINDS` と同じ */
export type EnergyRefetchKind = "tapo" | "aircon";

export type EnergyRefetchStatus = "idle" | "waiting" | "done" | "timed_out";

export interface EnergyRefetchSource {
  status: EnergyRefetchStatus;
  done_at: string | null;
  /** 何日前まで遡れるか */
  max_days: number;
}

/** `GET /api/energy/refetch`（#711） */
export interface EnergyRefetch {
  requested_at: string | null;
  since: string | null;
  /** 依頼して、まだ取得が済んでいない収集がある */
  pending: boolean;
  sources: Record<EnergyRefetchKind, EnergyRefetchSource>;
}

/** 待っている間に状況を取りに行く間隔。収集の定期実行は5分・1時間ごとなのでこまめには見ない */
export const ENERGY_REFETCH_POLL_MS = 15_000;

/** 画面から選べる遡り日数の上限。`backend/energy_refetch.py` の `MAX_DAYS` と同じ */
export const ENERGY_REFETCH_MAX_DAYS = 92;

export const ENERGY_REFETCH_SOURCE_LABEL: Record<EnergyRefetchKind, string> = {
  tapo: "スマートプラグ（Tapo）",
  aircon: "エアコン（白くまくん）",
};

export const ENERGY_REFETCH_SOURCE_NOTE: Record<EnergyRefetchKind, string> = {
  tapo: "プラグ本体の日別履歴から。5分ごとの収集で取得します",
  aircon: "1日ずつ取得します。1時間ごとの収集で取得します",
};

export const ENERGY_REFETCH_STATUS_LABEL: Record<EnergyRefetchStatus, string> = {
  idle: "依頼前",
  waiting: "待機中",
  done: "完了",
  timed_out: "応答なし",
};

export const ENERGY_REFETCH_QUICK_DAYS = [
  { days: 1, label: "昨日から" },
  { days: 3, label: "3日前から" },
  { days: 5, label: "5日前から" },
  { days: 30, label: "1か月前から" },
] as const;

/** 選べる最も古い日。当日から数えて `ENERGY_REFETCH_MAX_DAYS - 1` 日前 */
export function earliestRefetchDate(today: string): string {
  return shiftEnergyDate(today, -(ENERGY_REFETCH_MAX_DAYS - 1));
}

/** `since` から当日までの日数（当日を含む）。日付文字列のまま数える */
export function refetchSpanDays(since: string, today: string): number {
  const a = Date.parse(`${since}T12:00:00Z`);
  const b = Date.parse(`${today}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** 日付として送れるか（未来・遡りすぎ・形の不正を弾く） */
export function isValidRefetchDate(since: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return false;
  const span = refetchSpanDays(since, today);
  return span >= 1 && span <= ENERGY_REFETCH_MAX_DAYS;
}

/** `2026-10-01` -> `10月1日` */
export function formatRefetchDate(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}月${Number(day)}日`;
}

/** `2026-10-02T10:42:00+09:00` -> `10:42`。サーバーが返したJST表記を切り出すだけ */
export function formatRefetchTime(value: string | null): string | null {
  if (!value) return null;
  const match = /T(\d{2}:\d{2})/.exec(value);
  return match ? match[1] : null;
}
