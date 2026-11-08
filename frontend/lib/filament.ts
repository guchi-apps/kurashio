import { formatMonthDay } from "@/lib/date-utils";

/**
 * フィラメント在庫の型と表示用の整形（#445）。
 *
 * **残量の計算そのものはバックエンド（`backend/filament.py`）が済ませて返す。** ここでやるのは
 * 言葉づかい・並べ替え・入力の読み取りだけで、残量や割合をブラウザ側で計算し直さない
 * （計量と使用量の前後の判定を両側に持つと、片方だけ直したときに食い違う）。
 * 日付も端末の時計を使わず、応答の `today`（サーバーのJST）を基準にする。
 */

export type FilamentMaterial = "PLA" | "PETG" | "ABS" | "TPU" | "その他";
export const FILAMENT_MATERIALS: FilamentMaterial[] = ["PLA", "PETG", "ABS", "TPU", "その他"];

/** ok=十分 / low=残りわずか（10%未満） / empty=空 */
export type FilamentLevel = "ok" | "low" | "empty";

export interface FilamentWeighing {
  id: string;
  /** 計量した日（YYYY-MM-DD） */
  date: string;
  /** 秤に載せた全体重量（スプール込み・g） */
  gross_g: number;
  /** 空スプールを引いたフィラメント量。空スプールの重さが未設定なら null */
  net_g: number | null;
  recorded_at: string;
}

export interface FilamentUsage {
  id: string;
  /** 印刷した日（YYYY-MM-DD） */
  date: string;
  grams: number;
  note: string;
  recorded_at: string;
  /** 残量から引いているか。基準の計量より前のものは、量った重さに含まれているので false */
  counted: boolean;
  /**
   * 記録の出どころ（#454）。manual=手入力 / auto=造形の完了で自動 / auto_estimate=途中停止の概算。
   * 古いレスポンス（オフラインキャッシュ）には無いので、無ければ手入力として読む
   */
  source?: FilamentUsageSource;
  /** 自動記録のときの造形の識別子（プリンターカードが「差し引いた」と突き合わせる） */
  job_key?: string | null;
}

export type FilamentUsageSource = "manual" | "auto" | "auto_estimate";

export interface FilamentBase {
  /** weighing=最後の計量が基準 / initial=まだ計量が無く、初期フィラメント量が基準 */
  kind: "weighing" | "initial";
  gross_g: number | null;
  net_g: number;
  date: string | null;
}

export interface FilamentSpool {
  id: string;
  name: string;
  material: FilamentMaterial;
  /** `#RRGGBB`。未設定は null */
  color: string | null;
  purchased_on: string | null;
  /** 初期フィラメント量（g） */
  net_g: number;
  /** 空スプールの重さ（g）。未設定だと計量できない */
  tare_g: number | null;
  archived: boolean;
  active: boolean;
  remaining_g: number;
  /** 0〜100 */
  percent: number;
  level: FilamentLevel;
  base: FilamentBase;
  used_since_g: number;
  used_since_count: number;
  /** 新しい順 */
  weighings: FilamentWeighing[];
  /** 新しい順 */
  usages: FilamentUsage[];
}

export interface FilamentPayload {
  /** サーバー（JST）の今日。端末の時計は使わない */
  today: string;
  configured: boolean;
  active_id: string | null;
  /** 「残りわずか」にする割合（%） */
  low_percent: number;
  /** 使い切りは末尾 */
  spools: FilamentSpool[];
}

/** 新しいスプールを足すときに送る形 */
export interface FilamentSpoolInput {
  name: string;
  material: FilamentMaterial;
  color: string | null;
  purchased_on: string | null;
  net_g: number;
  tare_g: number | null;
  /** 使いかけを登録するときの、いまの全体重量 */
  current_gross_g?: number | null;
}

/** 既存のスプールを直すときに送る形（送った項目だけが変わる） */
export type FilamentSpoolPatch = Partial<
  Pick<
    FilamentSpoolInput,
    "name" | "material" | "color" | "purchased_on" | "net_g" | "tare_g"
  > & { archived: boolean }
>;

export const DEFAULT_NET_G = 1000;
export const MAX_NET_G = 10000;
export const MAX_TARE_G = 2000;
export const MAX_GROSS_G = 12000;
export const MAX_USAGE_G = 5000;

/** 色を選ぶときの候補。よく使う色だけを並べ、それ以外は色選択で決める */
export const FILAMENT_COLOR_PRESETS: { name: string; color: string }[] = [
  { name: "ホワイト", color: "#F4F4F2" },
  { name: "ブラック", color: "#2B2B2B" },
  { name: "グレー", color: "#8C8F94" },
  { name: "レッド", color: "#D64545" },
  { name: "オレンジ", color: "#E8892B" },
  { name: "イエロー", color: "#E6C229" },
  { name: "グリーン", color: "#3C9D5D" },
  { name: "ブルー", color: "#3B6FD4" },
];

export function getActiveSpool(payload: FilamentPayload | null): FilamentSpool | null {
  if (!payload || payload.active_id == null) return null;
  return payload.spools.find((spool) => spool.id === payload.active_id) ?? null;
}

export function splitSpools(payload: FilamentPayload): {
  inUse: FilamentSpool[];
  archived: FilamentSpool[];
} {
  return {
    inUse: payload.spools.filter((spool) => !spool.archived),
    archived: payload.spools.filter((spool) => spool.archived),
  };
}

/** "391"。グラム数は整数で見せる（秤の目盛りより細かい値は要らない） */
export function formatGrams(value: number): string {
  return String(Math.round(value));
}

/** 使用量の表示。スライサーが出す小数（26.4g）は残す。整数のときは小数点を出さない */
export function formatUsageGrams(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatFilamentDate(date: string): string {
  return formatMonthDay(date);
}

/** "在庫 3本（使い切り1本）" */
export function formatStockSummary(payload: FilamentPayload): string {
  const { inUse, archived } = splitSpools(payload);
  const base = `在庫 ${inUse.length}本`;
  return archived.length > 0 ? `${base}（使い切り${archived.length}本）` : base;
}

/** バー・数字の色（Tailwind のクラス） */
export const LEVEL_BAR_CLASS: Record<FilamentLevel, string> = {
  ok: "bg-[#24864f] dark:bg-[#5fcf8b]",
  low: "bg-[#a86200] dark:bg-[#f0b556]",
  empty: "bg-[#a86200] dark:bg-[#f0b556]",
};

export const LEVEL_TEXT_CLASS: Record<FilamentLevel, string> = {
  ok: "text-foreground",
  low: "text-[#a86200] dark:text-[#f0b556]",
  empty: "text-[#a86200] dark:text-[#f0b556]",
};

/** 割合の注記。残りわずか・空のときだけ言葉を添える */
export function formatLevelHint(spool: FilamentSpool): string | null {
  if (spool.level === "empty") return "使い切り";
  if (spool.level === "low") return "残りわずか";
  return null;
}

/** カードの2行目。計量・使用量のどちらが効いているかを短く言う */
export function describeBasis(spool: FilamentSpool): string {
  const base = spool.base;
  if (base.kind === "weighing" && base.date) {
    const count = spool.used_since_count;
    const tail =
      count > 0
        ? `、以降${count}回で${formatUsageGrams(spool.used_since_g)}g`
        : "";
    return `${formatFilamentDate(base.date)}に計量${tail}`;
  }
  const count = spool.used_since_count;
  return count > 0
    ? `未計量、${count}回で${formatUsageGrams(spool.used_since_g)}g使用`
    : "未使用";
}

export interface CalcRow {
  label: string;
  value: string;
  /** 最後の合計行 */
  total?: boolean;
}

/** 残量の内訳。計量が基準のときと、初期量が基準のときで行が変わる */
export function buildCalcRows(spool: FilamentSpool): CalcRow[] {
  const rows: CalcRow[] = [];
  const base = spool.base;
  if (base.kind === "weighing" && base.date && base.gross_g != null) {
    rows.push({
      label: `最後の計量（${formatFilamentDate(base.date)}）全体`,
      value: `${formatUsageGrams(base.gross_g)} g`,
    });
    rows.push({ label: "− 空スプール", value: `${formatUsageGrams(spool.tare_g ?? 0)} g` });
    rows.push({ label: "計量時の残量", value: `${formatUsageGrams(base.net_g)} g` });
  } else {
    rows.push({ label: "初期フィラメント量", value: `${formatUsageGrams(base.net_g)} g` });
  }
  if (spool.used_since_count > 0) {
    rows.push({
      label: `− ${base.kind === "weighing" ? "その後" : "これまで"}の使用（${spool.used_since_count}回）`,
      value: `${formatUsageGrams(spool.used_since_g)} g`,
    });
  }
  rows.push({ label: "いまの残量", value: `${formatGrams(spool.remaining_g)} g`, total: true });
  return rows;
}

export interface HistoryRow {
  key: string;
  kind: "usage" | "weighing";
  id: string;
  date: string;
  recordedAt: string;
  label: string;
  value: string;
  /** 使用量のうち、計量に含まれていて残量から引いていないもの */
  settled: boolean;
  /** 自動で記録したもの。手入力・計量は null */
  badge: "auto" | "estimate" | null;
}

/** 使用量と計量を1本の履歴へ。日付の新しい順で、同じ日は登録の新しい順 */
export function buildHistory(spool: FilamentSpool, limit = 8): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...spool.usages.map<HistoryRow>((usage) => ({
      key: `u:${usage.id}`,
      kind: "usage",
      id: usage.id,
      date: usage.date,
      recordedAt: usage.recorded_at,
      label: usage.note || "使用",
      value: `−${formatUsageGrams(usage.grams)} g`,
      settled: !usage.counted,
      badge:
        usage.source === "auto" ? "auto" : usage.source === "auto_estimate" ? "estimate" : null,
    })),
    ...spool.weighings.map<HistoryRow>((weighing) => ({
      key: `w:${weighing.id}`,
      kind: "weighing",
      id: weighing.id,
      date: weighing.date,
      recordedAt: weighing.recorded_at,
      label: `計量（全体 ${formatUsageGrams(weighing.gross_g)} g）`,
      value: weighing.net_g != null ? `${formatGrams(weighing.net_g)} g` : "",
      settled: false,
      badge: null,
    })),
  ];
  rows.sort((a, b) =>
    a.date === b.date
      ? b.recordedAt.localeCompare(a.recordedAt)
      : b.date.localeCompare(a.date)
  );
  return rows.slice(0, limit);
}

/**
 * 入力欄の文字列を `min`〜`max` のグラム数として読む。
 * 全角数字・末尾の「g」・カンマを許す。空欄・数値以外・範囲外は null。
 */
export function parseGramsInput(text: string, min: number, max: number): number | null {
  const normalized = text.normalize("NFKC").replace(/[,\s]/g, "").replace(/g$/i, "");
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return Math.round(value * 10) / 10;
}
