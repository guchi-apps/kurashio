import { shiftDate } from "@/lib/date-utils";

/**
 * 3Dプリンター（Bambu Lab A1 mini）カードの型と表示用の整形（#436）。
 *
 * 形は `backend/bambu.py` の `build_response()` と `build_snapshot()` が返すもの。
 * **現在値は `printer`（＝`online` のときだけ入る）から読み、`lastKnown` は
 * 「最後に確認した状態」としてしか使わない。** 収集が止まっている・プリンターに繋がっていない
 * ときの値を、いまの温度や進捗として見せないため。
 *
 * 時刻はサーバーがJSTのISO文字列（`2026-09-21T13:28:00+09:00`）で返す。**端末の時計や
 * `new Date()` で解釈し直さず、文字列の日付・時刻をそのまま切り出す**（端末のタイムゾーンで
 * 1日ずれない）。「いま」は端末の時計ではなく、応答の `fetchedAt` を使う（レンダーを純粋に保つ）。
 */

export type BambuConnection = "online" | "printer_offline" | "collector_stale" | "no_data";

export type BambuState =
  | "idle"
  | "preparing"
  | "printing"
  | "paused"
  | "finished"
  | "failed"
  | "unknown";

export interface BambuTray {
  slot: number | null;
  empty: boolean;
  material: string | null;
  brand: string | null;
  /** `#RRGGBB`。読めないときは null */
  color: string | null;
  /** 1〜100 のときだけ。0・-1（不明）は null */
  remainPercent: number | null;
}

export interface BambuAmsUnit {
  id: number | null;
  humidity: number | null;
  slots: BambuTray[];
}

export interface BambuHmsEntry {
  code: string;
  severity: "fatal" | "serious" | "common" | "info" | null;
}

/** この造形で使うフィラメント（スライサーの予定値）。複数色なら `filaments` が2件以上 */
export interface BambuJobFilament {
  /** 造形1回ごとの識別子。在庫の使用量の記録（`job_key`）と突き合わせる */
  jobKey: string;
  name: string;
  totalGrams: number;
  filaments: {
    slot: number | null;
    material: string | null;
    color: string | null;
    usedGrams: number;
  }[];
}

export interface BambuSnapshot {
  state: BambuState;
  rawState: string | null;
  /**
   * 「取り出した」操作（#464）で確認済みか。完了・停止のときだけ意味を持ち、新しい印刷が
   * 始まるとバックエンドが自動でfalseへ戻す。確認済みのあいだは待機中相当として表示する
   */
  acknowledged: boolean;
  job: {
    name: string | null;
    progressPercent: number | null;
    layer: number | null;
    totalLayers: number | null;
    remainingMinutes: number | null;
    estimatedFinishAt: string | null;
    /** 3mf から読んだこの造形の使用量（予定値・#454）。読めていないときは null／省略 */
    filament?: BambuJobFilament | null;
  };
  nozzle: { temperature: number | null; target: number | null };
  bed: { temperature: number | null; target: number | null };
  speed: { level: number | null; mode: string | null };
  ams: {
    connected: boolean;
    units: BambuAmsUnit[];
    activeSource: "ams" | "external" | "none";
    activeSlot: number | null;
    externalSpool: BambuTray | null;
  };
  errors: {
    printError: { code: string; raw: number } | null;
    hms: BambuHmsEntry[];
  };
}

export interface BambuPrinterResponse {
  fetchedAt: string;
  configured: boolean;
  connection: BambuConnection;
  online: boolean;
  stale: boolean;
  /** 収集が止まったと見なす秒数（最後の受信からこれを超えると `collector_stale`） */
  staleThresholdSeconds: number;
  lastUpdateAt: string | null;
  lastMessageAt: string | null;
  printer: BambuSnapshot | null;
  lastKnown: BambuSnapshot | null;
}

// --- 時刻 ----------------------------------------------------------------------

/** `2026-09-21T13:28:00+09:00` → `2026-09-21` */
function datePart(iso: string): string {
  return iso.slice(0, 10);
}

/** `2026-09-21T13:28:00+09:00` → `13:28` */
export function formatClock(iso: string | null): string | null {
  if (!iso || iso.length < 16) return null;
  return iso.slice(11, 16);
}

/** `2026-09-21` → `9/21` */
function formatMonthDay(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/**
 * 日付の相対表示。同じ日は省き、前後1日は「昨日」「明日」、それ以外は `9/19` にする。
 * `today` は応答の `fetchedAt` の日付（JST）。
 */
function formatDayLabel(date: string, today: string): string {
  if (date === today) return "";
  if (date === shiftDate(today, -1)) return "昨日";
  if (date === shiftDate(today, 1)) return "明日";
  return formatMonthDay(date);
}

/** `13:04` / `昨日 21:40` / `9/19 21:40`。読めなければ null */
export function formatObservedAt(iso: string | null, nowIso: string): string | null {
  const clock = formatClock(iso);
  if (!iso || !clock) return null;
  const day = formatDayLabel(datePart(iso), datePart(nowIso));
  return day ? `${day} ${clock}` : clock;
}

/** 分 → `1時間24分` / `24分` / `2時間` */
export function formatRemaining(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** `14:52 ごろ完了` / `明日 02:10 ごろ完了`。予測が無ければ null */
export function formatFinishAt(iso: string | null, nowIso: string): string | null {
  const at = formatObservedAt(iso, nowIso);
  return at ? `${at} ごろ完了` : null;
}

// --- 状態 ----------------------------------------------------------------------

export type BambuTone = "live" | "warn" | "ok" | "bad" | "idle";

export type BambuView =
  /** 現在値を出す（`printer` がある） */
  | { kind: "current"; snapshot: BambuSnapshot }
  /** 現在値は出さない。`lastKnown` があれば「最後に確認した状態」として添える */
  | { kind: "offline"; lastKnown: BambuSnapshot | null }
  | { kind: "stale"; lastKnown: BambuSnapshot | null }
  | { kind: "no_data" };

/** 応答をどの見せ方にするか。**`online` を見ずに `lastKnown` を現在値にしない** */
export function resolveBambuView(response: BambuPrinterResponse): BambuView {
  if (response.online && response.printer) {
    return { kind: "current", snapshot: response.printer };
  }
  if (response.connection === "printer_offline") {
    return { kind: "offline", lastKnown: response.lastKnown };
  }
  if (response.connection === "collector_stale") {
    return { kind: "stale", lastKnown: response.lastKnown };
  }
  return { kind: "no_data" };
}

/** 通知に値するエラー（`backend/bambu.py` の `_error_codes` と同じ基準。情報レベルのHMSは出さない） */
export interface BambuErrorItem {
  code: string;
  /** 画面に出す重大度。印刷エラー（`print_error`）は null */
  severityLabel: string | null;
}

const HMS_SEVERITY_LABELS: Record<string, string> = {
  fatal: "致命的",
  serious: "重大",
};

export function collectBambuErrors(snapshot: BambuSnapshot): BambuErrorItem[] {
  const items: BambuErrorItem[] = [];
  if (snapshot.errors.printError) {
    items.push({ code: snapshot.errors.printError.code, severityLabel: null });
  }
  for (const entry of snapshot.errors.hms) {
    const label = entry.severity ? HMS_SEVERITY_LABELS[entry.severity] : undefined;
    if (label) items.push({ code: entry.code, severityLabel: label });
  }
  return items;
}

export interface BambuStatusPill {
  label: string;
  tone: BambuTone;
  /** 動いている状態（印刷中・準備中）だけ点を呼吸させる */
  live: boolean;
}

const STATUS_PILLS: Record<BambuState, BambuStatusPill> = {
  printing: { label: "印刷中", tone: "live", live: true },
  preparing: { label: "準備中", tone: "live", live: true },
  paused: { label: "一時停止", tone: "warn", live: false },
  finished: { label: "完了", tone: "ok", live: false },
  failed: { label: "停止", tone: "bad", live: false },
  idle: { label: "待機中", tone: "idle", live: false },
  unknown: { label: "状態不明", tone: "idle", live: false },
};

/** 完了・停止のあと、「取り出した」を押していないか（#464。ボタンを出す条件） */
export function canAcknowledgeBambuPrinter(snapshot: BambuSnapshot): boolean {
  return (snapshot.state === "finished" || snapshot.state === "failed") && !snapshot.acknowledged;
}

/** 完了・停止で、かつ「取り出した」を押し済みか（#464。待機中相当として見せる条件） */
export function isAcknowledgedIdle(snapshot: BambuSnapshot): boolean {
  return (snapshot.state === "finished" || snapshot.state === "failed") && snapshot.acknowledged;
}

/** 状態のピル。停止（`failed`）以外でも、エラーが出ていれば「エラー」を優先する */
export function getBambuStatusPill(snapshot: BambuSnapshot): BambuStatusPill {
  // 「取り出した」済みの完了・停止は、次の印刷が始まるまで待機中として見せる（#464）
  if (isAcknowledgedIdle(snapshot)) {
    return STATUS_PILLS.idle;
  }
  const pill = STATUS_PILLS[snapshot.state] ?? STATUS_PILLS.unknown;
  if (snapshot.state !== "failed" && snapshot.state !== "unknown" && collectBambuErrors(snapshot).length > 0) {
    return { label: "エラー", tone: "bad", live: false };
  }
  return pill;
}

/** 「最後に確認した状態」の1行。`cable-clip_v3　印刷中 62%` */
export function describeLastKnown(snapshot: BambuSnapshot): string {
  const name = snapshot.job.name ?? "印刷";
  const percent = snapshot.job.progressPercent;
  switch (snapshot.state) {
    case "printing":
    case "preparing":
      return percent != null ? `${name}　印刷中 ${percent}%` : `${name}　印刷中`;
    case "paused":
      return percent != null ? `${name}　一時停止 ${percent}%` : `${name}　一時停止`;
    case "finished":
      return `${name}　完了`;
    case "failed":
      return `${name}　停止`;
    case "idle":
      return "待機中";
    default:
      return name;
  }
}

/**
 * 印刷の進み具合を出す状態か（待機中・状態不明は出さない）。
 *
 * **「取り出した」を押した完了・停止は出さない**（#464）。次の印刷が始まるまで、
 * 進捗100%（または途中%）が張り付いて見えるのを防ぐ
 */
export function hasJobProgress(snapshot: BambuSnapshot): boolean {
  if (isAcknowledgedIdle(snapshot)) return false;
  return (
    ["preparing", "printing", "paused", "finished", "failed"].includes(snapshot.state) &&
    snapshot.job.progressPercent != null
  );
}

/** 温度の整数表示。読めなければ `--` */
export function formatTemperature(value: number | null): string {
  return value == null ? "--" : String(Math.round(value));
}

/** 目標温度。0（加熱していない）と不明は出さない */
export function formatTargetTemperature(value: number | null): string | null {
  return value != null && value > 0 ? String(Math.round(value)) : null;
}

const SPEED_LABELS: Record<string, string> = {
  silent: "静音",
  standard: "標準",
  sport: "スポーツ",
  ludicrous: "最速",
};

export function formatSpeedMode(mode: string | null): string | null {
  return mode ? (SPEED_LABELS[mode] ?? null) : null;
}
