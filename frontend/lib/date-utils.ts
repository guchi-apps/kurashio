/**
 * 日付文字列（YYYY-MM-DD）を扱う小さな関数。
 * 端末のタイムゾーンに左右されないよう、文字列のまま・UTC 正午で数える。
 */

/** "2026-08-26" -> "8/26"。タイムゾーンに左右されないよう文字列のまま組み立てる */
export function formatMonthDay(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

/** date から days 日ずらした YYYY-MM-DD。UTC 正午で数えて日付ずれを避ける */
export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
