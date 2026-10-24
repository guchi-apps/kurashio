import { CHART_COLOR_PALETTE } from "@/lib/chart-colors";
import type {
  EnergyBreakdown,
  EnergyBreakdownDay,
  EnergyHourly,
  EnergySourceRow,
  EnergyTotal,
} from "@/lib/types";

export function formatYen(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

export function formatKwh(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} kWh`;
}

/** `2026-08-22` → `8/22` */
export function formatEnergyDate(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** `2026-08-22` → `8/22（金）`。日付文字列だけで組み立て、タイムゾーンに寄らせない */
export function formatEnergyDateWithWeekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  const weekday = WEEKDAY_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}/${day}（${weekday}）`;
}

export interface EnergyComparison {
  /** 今月が先月の同じ時期より少なければ true */
  cheaper: boolean;
  /** 差の割合（%、絶対値） */
  percent: number;
  /** 比較対象の金額 */
  baseCostYen: number;
}

/**
 * 今月ぶんを「先月の同じ日まで」と比べる。
 * 月をまたいだ直後や先月ぶんが無いときは比較そのものを出さない（null）。
 */
export function buildEnergyComparison(
  summary: {
    this_month: EnergyTotal;
    last_month_to_date: EnergyTotal;
  } | null
): EnergyComparison | null {
  if (!summary) return null;
  const base = summary.last_month_to_date;
  const current = summary.this_month;
  if (!base || !current) return null;
  if (base.days === 0 || base.cost_yen <= 0) return null;
  if (current.days === 0) return null;

  const diff = current.cost_yen - base.cost_yen;
  return {
    cheaper: diff <= 0,
    percent: Math.round((Math.abs(diff) / base.cost_yen) * 100),
    baseCostYen: base.cost_yen,
  };
}

/** 日別の並びに要るのはこの2つだけ。取得元1つの集計にも家全体の集計にも使う */
interface DailyLike {
  date: string;
  kwh: number | null;
}

/** 詳細パネルの日別一覧。新しい日が上に来るように並べ替える */
export function buildEnergyDailyRows<T extends DailyLike>(daily: readonly T[]): T[] {
  return [...daily].reverse();
}

/** 日別一覧の棒の長さ（期間内の最大値で正規化） */
export function energyRowRatio(rows: readonly DailyLike[], day: DailyLike): number {
  const max = Math.max(...rows.map((row) => row.kwh ?? 0), 0);
  if (max <= 0) return 0;
  return (day.kwh ?? 0) / max;
}

/**
 * 収集が止まっているか。当日ぶんは日中まだ届かないことがあるため、
 * 「昨日ぶんも無い」ときだけ止まっていると見なす。
 */
export function isEnergyStale(
  summary: { latest_date: string | null } | null,
  todayIso: string
): boolean {
  if (!summary || !summary.latest_date) return false;
  const yesterday = new Date(`${todayIso}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return summary.latest_date < yesterday.toISOString().slice(0, 10);
}

export function hasEnergyData(
  summary: { daily: readonly unknown[] } | null
): boolean {
  return Boolean(summary && summary.daily.length > 0);
}

// ------------------------------------------------------------ 取得元ごとの色と積み上げ
//
// 消費電力カードはエアコンとスマートプラグを1枚に並べるため、取得元ごとに色が要る。
// センサーのグラフと同じ配色（CHART_COLOR_PALETTE）から採り、画面をまたいで
// 同じ色が同じものを指すようにする。

/** エアコンの色。センサーのグラフで室温に使っているものと同じ */
export const AIRCON_ENERGY_COLOR = "#1abc9c";

/** プラグに割り当てる色。エアコンの色とは重ねない */
const PLUG_COLOR_PALETTE = CHART_COLOR_PALETTE.filter(
  (color) => color !== AIRCON_ENERGY_COLOR
);

export const AIRCON_ENERGY_SOURCE = "aircon";

/** スマートプラグの取得元に付く前置き。`backend/energy.py` の `TAPO_SOURCE_PREFIX` と同じ */
export const TAPO_SOURCE_PREFIX = "tapo:";

/**
 * 名前を付け替えられる取得元だけを抜き出す（#335）。
 *
 * エアコンの名前は「いまの環境の設定」が持っており、KEPCOの「その他」は機器ですらない。
 * ここで扱うのはスマートプラグだけに絞る。
 */
export function pickRenamableEnergySources(
  sources: readonly EnergySourceRow[]
): EnergySourceRow[] {
  return sources.filter((row) => row.source.startsWith(TAPO_SOURCE_PREFIX));
}

// ------------------------------------------------------------ KEPCO「その他」（#302／#319）
//
// KEPCO CSV実測（家全体）とエアコン・スマートプラグ実測の差分。`backend/energy.py` の
// `build_hourly`（時間ごと）と `build_breakdown`（日別）が算出する疑似 source で、
// `breakdown.sources`（機器の一覧）には含まれない。ラベル・色をここで固定し、
// `buildEnergyStackSegments`・`buildEnergyHourlyColumns` の汎用フォールバックに
// 頼らないようにする（フォールバックのグレーとたまたま同じ色だが、意味づけが違うため別定数にする）。

export const KEPCO_OTHER_SOURCE = "kepco_other";
export const KEPCO_OTHER_LABEL = "その他";
export const KEPCO_OTHER_COLOR = "#95a5a6";

/**
 * KEPCO「みるでん」の、時間ごとCSVのダウンロードページ（#317）。
 *
 * 取り込むCSVはここでしか手に入らないため、取り込みボタンの隣にリンクとして出す。
 * 入口を増やすと片方が古くなるので、貼るのはこの1か所だけにする。
 */
export const KEPCO_MIRUDEN_DOWNLOAD_URL = "https://kepco.jp/miruden/mypage/download";

/**
 * 取得元 → 色。エアコンは固定で、それ以外は `sources` の並び順に配色する。
 *
 * 並び順はサーバーが「エアコン → 今月の使用量が多い順」で決めているため、
 * 機器を足しても既存の機器の色は変わらない……とは限らない（使用量で順が入れ替わる）。
 * 色は凡例と同時に出るので、入れ替わっても読めなくはならない。
 */
export function buildEnergySourceColors(
  sources: readonly EnergySourceRow[]
): Record<string, string> {
  const colors: Record<string, string> = {};
  let plugIndex = 0;
  for (const row of sources) {
    if (row.source === AIRCON_ENERGY_SOURCE) {
      colors[row.source] = AIRCON_ENERGY_COLOR;
      continue;
    }
    colors[row.source] = PLUG_COLOR_PALETTE[plugIndex % PLUG_COLOR_PALETTE.length];
    plugIndex += 1;
  }
  return colors;
}

export interface EnergyStackSegment {
  source: string;
  label: string;
  kwh: number;
  /** その日の合計に対する割合（0〜1） */
  share: number;
  color: string;
}

/**
 * 1日ぶんを取得元ごとのセグメントへ。値の無い取得元は入れない。
 *
 * 並びは `sources`（サーバーが決めた機器の順）が先で、そこに無い取得元は後ろへ回す。
 * 「その他」（KEPCO実測との差分・#302／#319）は機器ではないため `sources` に入らないが、
 * `by_source` には来る。時間ごと（`buildEnergyHourlyColumns`）と同じく、ここで拾って
 * 専用のラベル・色を当てる。
 */
export function buildEnergyStackSegments(
  day: EnergyBreakdownDay,
  sources: readonly EnergySourceRow[],
  colors: Record<string, string>
): EnergyStackSegment[] {
  const labels = new Map(sources.map((row) => [row.source, row.label]));
  const order = [
    ...sources.map((row) => row.source),
    ...Object.keys(day.by_source).filter((source) => !labels.has(source)),
  ];

  const total = order.reduce((sum, source) => sum + (day.by_source[source] ?? 0), 0);
  if (total <= 0) return [];

  return order
    .map((source) => {
      const kwh = day.by_source[source] ?? 0;
      return {
        source,
        label:
          source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_LABEL : labels.get(source) ?? source,
        kwh,
        share: kwh / total,
        color: source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_COLOR : colors[source] ?? "#95a5a6",
      };
    })
    .filter((segment) => segment.kwh > 0);
}

/** 日別に「その他」が1日でも積まれているか。説明の注記を出すかの判定に使う（#319） */
export function hasEnergyKepcoOther(days: readonly EnergyBreakdownDay[]): boolean {
  return days.some((day) => (day.by_source[KEPCO_OTHER_SOURCE] ?? 0) > 0);
}

export interface EnergyStackColumn {
  date: string;
  kwh: number;
  /** 期間内の最大値を 1 とした高さの比 */
  ratio: number;
  segments: EnergyStackSegment[];
}

/**
 * 詳細パネルの積み上げ棒グラフ。
 *
 * **記録の無い日は棒そのものを作らない。** 0 kWh として描くと「その日は使っていない」に
 * 見えるが、実際には収集が止まっていただけのことがある（プラグは停電明けに黙る）。
 */
export function buildEnergyStackColumns(
  breakdown: EnergyBreakdown | null
): EnergyStackColumn[] {
  if (!breakdown) return [];
  return buildEnergyStackColumnsFrom(
    breakdown.daily,
    breakdown.sources,
    buildEnergySourceColors(breakdown.sources)
  );
}

/**
 * `buildEnergyStackColumns` の、日別・取得元・色を別々に渡す版。
 *
 * 詳細シートの横スクロールのグラフ（#810）は1年ぶんの `daily` を描くが、取得元と色は
 * 凡例と揃えるため親の30日ぶんの `sources` から決める。`ratio` の基準は渡した全期間の
 * 最大値なので、スクロールしても棒の高さは変わらない。
 */
export function buildEnergyStackColumnsFrom(
  daily: readonly EnergyBreakdownDay[],
  sources: readonly EnergySourceRow[],
  colors: Record<string, string>
): EnergyStackColumn[] {
  const max = Math.max(...daily.map((day) => day.kwh), 0);
  return daily
    .filter((day) => day.kwh > 0)
    .map((day) => ({
      date: day.date,
      kwh: day.kwh,
      ratio: max > 0 ? day.kwh / max : 0,
      segments: buildEnergyStackSegments(day, sources, colors),
    }));
}

/**
 * 推移ページ（`/energy`・#822）で遡る日数。`/api/energy/breakdown` の上限は400。
 * 詳細シートは親の30日ぶんを固定で描き、遡るのはこのページだけ
 */
export const ENERGY_DAILY_CHART_HISTORY_DAYS = 365;

/** 詳細シートの固定グラフと、推移ページの配色で「直近」とみなす日数（#822） */
export const ENERGY_RECENT_DAYS = 30;

/**
 * 推移ページの配色に使う取得元の並び（#822）。
 *
 * サーバーは「エアコン → 今月の使用量 → 名前」で並べるため、1年ぶんの `sources` には
 * 撤去したプラグが今月0kWhで混ざり、名前順で直近の機器のあいだに割り込むことがある。
 * そのまま `buildEnergySourceColors` に通すと詳細シート（30日ぶん）と色がずれるので、
 * `recentStart` 以降に記録がある機器を先に、残りを後ろへ回す（それぞれの中の順は保つ）。
 */
export function orderEnergySourcesForColors<T extends Pick<EnergySourceRow, "latest_date">>(
  sources: readonly T[],
  recentStart: string
): T[] {
  const isRecent = (row: T) => row.latest_date != null && row.latest_date >= recentStart;
  return [...sources.filter(isRecent), ...sources.filter((row) => !isRecent(row))];
}

export interface EnergyFilterItem {
  source: string;
  label: string;
  color: string;
}

/**
 * 推移ページで表示・非表示を選べる取得元の一覧（#822）。
 *
 * 機器は `sources` の順。「その他」（KEPCO実測との差分）は `sources` に入らないが
 * `by_source` には来るので、`daily` に1日でも積まれていれば最後に1行足す。
 * `sources` に無い他のキーも同じく後ろへ回す（積み上げで黙って消えないように）。
 */
export function buildEnergyFilterItems(
  sources: readonly EnergySourceRow[],
  daily: readonly EnergyBreakdownDay[],
  colors: Record<string, string>
): EnergyFilterItem[] {
  const known = new Set(sources.map((row) => row.source));
  const extra: string[] = [];
  for (const day of daily) {
    for (const [source, kwh] of Object.entries(day.by_source)) {
      if (!known.has(source) && kwh > 0 && !extra.includes(source)) extra.push(source);
    }
  }
  // 「その他」は機器のあとの最後に固定する
  extra.sort((a, b) => Number(a === KEPCO_OTHER_SOURCE) - Number(b === KEPCO_OTHER_SOURCE));
  return [
    ...sources.map((row) => ({
      source: row.source,
      label: row.label,
      color: colors[row.source] ?? "#95a5a6",
    })),
    ...extra.map((source) => ({
      source,
      label: source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_LABEL : source,
      color: source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_COLOR : colors[source] ?? "#95a5a6",
    })),
  ];
}

/**
 * 外した取得元を抜いた日別（#822）。`kwh` は残った取得元の合計で、
 * `cost_yen` はその日の金額を使用量の割合で按分した目安（取得元ごとの金額は持っていない）。
 *
 * 1つも外していなければ元の日別をそのまま返す（金額を按分し直さない）。
 */
export function filterEnergyDailyBySources(
  daily: readonly EnergyBreakdownDay[],
  hidden: ReadonlySet<string>
): EnergyBreakdownDay[] {
  if (hidden.size === 0) return [...daily];
  return daily.map((day) => {
    const bySource = Object.fromEntries(
      Object.entries(day.by_source).filter(([source]) => !hidden.has(source))
    );
    const kwh = Object.values(bySource).reduce((sum, value) => sum + value, 0);
    const allKwh = Object.values(day.by_source).reduce((sum, value) => sum + value, 0);
    return {
      ...day,
      kwh,
      cost_yen: allKwh > 0 ? (day.cost_yen * kwh) / allKwh : 0,
      by_source: bySource,
    };
  });
}

/** `start`〜`end`（両端を含む）の日の、取得元ごとの使用量（#822）。`null` なら全期間 */
export function sumEnergyBySource(
  daily: readonly EnergyBreakdownDay[],
  range: { start: string; end: string } | null
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const day of daily) {
    if (range && (day.date < range.start || day.date > range.end)) continue;
    for (const [source, kwh] of Object.entries(day.by_source)) {
      totals[source] = (totals[source] ?? 0) + kwh;
    }
  }
  return totals;
}

export interface EnergyDailyTick {
  /** `"10月"`（月の変わり目）か `"10/15"` */
  label: string;
  /** 月の変わり目。目盛りを強調する */
  month: boolean;
}

/**
 * 横スクロールの日別グラフの目盛り（#810）。棒と同じ並びで、ラベルの無い棒は `null`。
 *
 * 棒は記録のある日だけなので、日付ではなく「直前の棒からどこを跨いだか」で決める。
 * 月が変わった棒（と左端の棒）に月、同じ月の中で8日・15日・22日を跨いだ棒に日付を付ける。
 * 棒の間隔は12px前後なので、毎日付けると文字が重なる。
 */
export function buildEnergyDailyTicks(
  columns: readonly { date: string }[]
): (EnergyDailyTick | null)[] {
  return columns.map((column, index) => {
    const [, month, day] = column.date.split("-").map(Number);
    const prev = index > 0 ? columns[index - 1].date.split("-").map(Number) : null;
    if (!prev || prev[1] !== month) return { label: `${month}月`, month: true };
    const week = Math.min(3, Math.floor((day - 1) / 7));
    const prevWeek = Math.min(3, Math.floor((prev[2] - 1) / 7));
    if (week > prevWeek) return { label: `${month}/${day}`, month: false };
    return null;
  });
}

/**
 * 横スクロールの位置から、画面に半分以上入っている棒の範囲を返す（#810）。
 *
 * `leading` は先頭の棒より左にある幅（「ここより前の記録はありません」など）、
 * `step` は棒1本ぶんの幅（棒＋間隔）。棒が1本も入っていなければ `null`。
 */
export function energyVisibleColumnRange(
  scrollLeft: number,
  viewportWidth: number,
  leading: number,
  step: number,
  count: number
): { first: number; last: number } | null {
  if (count === 0 || step <= 0) return null;
  const first = Math.max(0, Math.round((scrollLeft - leading) / step));
  const last = Math.min(
    count - 1,
    Math.round((scrollLeft + viewportWidth - leading) / step) - 1
  );
  if (first > last) return null;
  return { first, last };
}

export interface EnergySingleColumn {
  date: string;
  kwh: number;
  /** 期間内の最大値を 1 とした高さの比 */
  ratio: number;
}

/**
 * デバイス単体の日別棒グラフ。`buildEnergyStackColumns` の単色版。
 *
 * 記録の無い日は棒そのものを作らない（理由は `buildEnergyStackColumns` と同じ）。
 */
export function buildEnergySingleColumns(
  daily: readonly { date: string; kwh: number | null }[]
): EnergySingleColumn[] {
  const withData = daily.filter(
    (day): day is { date: string; kwh: number } => (day.kwh ?? 0) > 0
  );
  const max = Math.max(...withData.map((day) => day.kwh), 0);
  return withData.map((day) => ({
    date: day.date,
    kwh: day.kwh,
    ratio: max > 0 ? day.kwh / max : 0,
  }));
}

/** いまの消費電力。返さない取得元（エアコン）は「—」 */
export function formatWatts(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} W`;
}

/** カードの行に出す棒の長さ。その日いちばん使った取得元を 1 とする */
export function energySourceRatio(
  sources: readonly EnergySourceRow[],
  row: EnergySourceRow
): number {
  const max = Math.max(...sources.map((item) => item.today_kwh ?? 0), 0);
  if (max <= 0) return 0;
  return (row.today_kwh ?? 0) / max;
}

// ------------------------------------------------------------ 時間ごと（#300）

/**
 * `date` を `days` 日ずらす。UTC正午を基準に計算し、タイムゾーンによる日またぎのずれを避ける
 * （`frontend/lib/cleaning.ts` の `shiftDate` と同じ考え方。日付文字列を扱う場所ごとに持つ）。
 */
export function shiftEnergyDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export interface EnergyHourlySegment {
  source: string;
  label: string;
  kwh: number;
  /** その時間帯の合計に対する割合（0〜1） */
  share: number;
  color: string;
}

export interface EnergyHourlyColumn {
  hour: number;
  /** `null` はまだ記録が無い時間帯（未来、または記録を始める前の日） */
  kwh: number | null;
  /** その日の最大値を 1 とした高さの比 */
  ratio: number;
  segments: EnergyHourlySegment[];
}

/**
 * 詳細パネル「時間ごと」の積み上げ棒グラフ。
 *
 * ラベルは`EnergyHourly`自体は持たないため、同じ画面で先に取っている`breakdown.sources`
 * （日別の集計）の`label`をそのまま使い回す。取得元が増えても正が2か所に分かれないようにするため。
 */
export function buildEnergyHourlyColumns(
  hourly: EnergyHourly | null,
  sources: readonly EnergySourceRow[],
  colors: Record<string, string>
): EnergyHourlyColumn[] {
  if (!hourly) return [];
  const labels = new Map(sources.map((row) => [row.source, row.label]));
  const max = Math.max(...hourly.hours.map((row) => row.kwh ?? 0), 0);

  return hourly.hours.map((row) => {
    const total = row.kwh ?? 0;
    const segments: EnergyHourlySegment[] =
      row.kwh == null
        ? []
        : Object.entries(row.by_source)
            .filter(([, kwh]) => kwh > 0)
            .map(([source, kwh]) => ({
              source,
              label:
                source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_LABEL : labels.get(source) ?? source,
              kwh,
              share: total > 0 ? kwh / total : 0,
              color: source === KEPCO_OTHER_SOURCE ? KEPCO_OTHER_COLOR : colors[source] ?? "#95a5a6",
            }));

    return {
      hour: row.hour,
      kwh: row.kwh,
      ratio: row.kwh != null && max > 0 ? row.kwh / max : 0,
      segments,
    };
  });
}

/** `7` → `7時` */
export function formatEnergyHour(hour: number): string {
  return `${hour}時`;
}

// ------------------------------------------------ 日付のカレンダー選択（#330）

/** `2026-09-02` → `2026-09` */
export function energyMonthOf(date: string): string {
  return date.slice(0, 7);
}

/** `2026-09` → `2026年9月` */
export function formatEnergyMonthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return month;
  return `${year}年${m}月`;
}

/**
 * `month`（`2026-09`）を `delta` か月ずらす。
 * 日付と同じくUTC正午を基準にして、タイムゾーンによる月またぎのずれを避ける。
 */
export function shiftEnergyMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return month;
  // 日を1に固定してからずらす。月末（8/31→9/31）で翌々月へ飛ぶのを避けるため
  const parsed = new Date(Date.UTC(year, m - 1 + delta, 1, 12));
  return parsed.toISOString().slice(0, 7);
}

/**
 * カレンダーに並べる1か月ぶんのマス。日曜始まりの7列に整え、
 * その月に無いマスは `null`（前後の月の日付は出さない）。
 */
export function buildEnergyCalendarWeeks(month: string): (string | null)[][] {
  const [year, m] = month.split("-").map(Number);
  if (!year || !m) return [];
  const first = new Date(Date.UTC(year, m - 1, 1, 12));
  const daysInMonth = new Date(Date.UTC(year, m, 0, 12)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
