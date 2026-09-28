"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  fetchGarbageSchedule,
  fetchPushVapidPublicKey,
  fetchUiSettings,
  sendTestPushNotification,
  subscribePushNotifications,
  unsubscribePushNotifications,
  updateUiSettings,
} from "@/lib/api";
import type { GarbageCategoryNext } from "@/lib/garbage";
import { isNativeApp } from "@/lib/native-app";
import {
  getExistingPushSubscription,
  getNotificationPermission,
  isPushNotificationsSupported,
  subscribeToPushNotifications,
  subscriptionToJson,
  unsubscribeFromPushNotifications,
} from "@/lib/push-notifications";
import type { UiSettings } from "@/lib/types";

interface NotificationSettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

//: 画面から一度も設定していないときに入力欄へ出す既定値。
//: 実際の既定（未設定時の挙動）は backend/garbage.py の DEFAULT_NOTIFY_HOUR = 20 と揃える
const DEFAULT_GARBAGE_NOTIFY_TIME = "20:00";
//: 当日通知の入力欄の既定値。backend/garbage_notify.py の DEFAULT_SAME_DAY_NOTIFY_HOUR = 7 と揃える
const DEFAULT_GARBAGE_NOTIFY_SAME_DAY_TIME = "07:00";

type GarbageNotifyTiming = "before" | "same_day";

//: 品目ごとの通知タイミングが未指定のときの既定（前日通知のみ、#293からの既定動作を維持）
const DEFAULT_GARBAGE_NOTIFY_CATEGORY_TIMINGS: GarbageNotifyTiming[] = ["before"];

/** その品目が指定のタイミング（前日/当日）で通知される設定になっているか。 */
export function categoryHasTiming(
  categoryTiming: Record<string, GarbageNotifyTiming[]>,
  categoryId: string,
  timing: GarbageNotifyTiming
): boolean {
  const timings = categoryTiming[categoryId] ?? DEFAULT_GARBAGE_NOTIFY_CATEGORY_TIMINGS;
  return timings.includes(timing);
}

/**
 * 品目ごとの通知タイミングを1つだけ切り替える。前日・当日は排他ではないため、
 * 片方をONにしてももう片方はそのまま（両方ONも両方OFFも作れる）。
 */
export function toggleCategoryTiming(
  categoryTiming: Record<string, GarbageNotifyTiming[]>,
  categoryId: string,
  timing: GarbageNotifyTiming,
  next: boolean
): Record<string, GarbageNotifyTiming[]> {
  const current = categoryTiming[categoryId] ?? DEFAULT_GARBAGE_NOTIFY_CATEGORY_TIMINGS;
  const timings = next
    ? Array.from(new Set([...current, timing]))
    : current.filter((entry) => entry !== timing);
  return { ...categoryTiming, [categoryId]: timings };
}

//: 再通知間隔の下限・上限。backend/ui_settings.py の
//: MIN_ROOM_ANOMALY_REMINDER_MINUTES / MAX_ROOM_ANOMALY_REMINDER_MINUTES と揃える
const MIN_REMINDER_MINUTES = 5;
const MAX_REMINDER_MINUTES = 1440;

type RoomAnomalyThresholds = UiSettings["room_anomaly_thresholds"];
type ThresholdMetric = keyof RoomAnomalyThresholds;
type ThresholdBound = "min" | "max";

const METRIC_LABELS: Record<ThresholdMetric, string> = {
  temperature: "室温",
  humidity: "湿度",
};

const THRESHOLD_FIELDS: {
  metric: ThresholdMetric;
  bound: ThresholdBound;
  label: string;
  step: number;
}[] = [
  { metric: "temperature", bound: "min", label: "室温の下限（℃）", step: 0.5 },
  { metric: "temperature", bound: "max", label: "室温の上限（℃）", step: 0.5 },
  { metric: "humidity", bound: "min", label: "湿度の下限（%）", step: 1 },
  { metric: "humidity", bound: "max", label: "湿度の上限（%）", step: 1 },
];

const REMINDER_DRAFT_KEY = "reminder_minutes";
const GARBAGE_TIME_DRAFT_KEY = "garbage_notify_time";
const GARBAGE_SAME_DAY_TIME_DRAFT_KEY = "garbage_notify_same_day_time";

export function thresholdDraftKey(metric: ThresholdMetric, bound: ThresholdBound): string {
  return `${metric}.${bound}`;
}

/**
 * 入力欄の文字列を数値にする。空欄・数字でない文字列・入力途中の "-" や "1e" は null を返し、
 * 呼び出し側は「確定しない（元の値へ戻す）」を選ぶ。
 */
export function parseNumberDraft(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type DraftCommit<T> =
  | { status: "unchanged" }
  | { status: "invalid"; message: string }
  | { status: "ok"; value: T };

/**
 * 閾値1つぶんの入力を確定する。
 *
 * 入力のたびに保存すると「20」の途中の「2」で保存されてしまい、バックエンドの
 * `_normalize_room_anomaly_thresholds` が min >= max を既定値へ落とすため入力欄の値が飛ぶ。
 * 確定は入力欄から離れたときだけに寄せ、min >= max はここで弾いて保存に出さない。
 */
export function commitThresholdDraft(
  thresholds: RoomAnomalyThresholds,
  metric: ThresholdMetric,
  bound: ThresholdBound,
  raw: string
): DraftCommit<RoomAnomalyThresholds> {
  const parsed = parseNumberDraft(raw);
  if (parsed === null) return { status: "unchanged" };

  // バックエンドが round(value, 1) で保存するため、入り口でも小数第1位へ丸める
  const value = Math.round(parsed * 10) / 10;
  const current = thresholds[metric];
  if (current[bound] === value) return { status: "unchanged" };

  const next = { ...current, [bound]: value };
  if (next.min >= next.max) {
    return {
      status: "invalid",
      message: `${METRIC_LABELS[metric]}の下限は上限より小さい値にしてください。`,
    };
  }
  return { status: "ok", value: { ...thresholds, [metric]: next } };
}

/** 再通知間隔の入力を確定する。範囲外はバックエンドと同じ範囲へ丸める。 */
export function commitReminderDraft(current: number, raw: string): DraftCommit<number> {
  const parsed = parseNumberDraft(raw);
  if (parsed === null) return { status: "unchanged" };

  const minutes = Math.min(
    MAX_REMINDER_MINUTES,
    Math.max(MIN_REMINDER_MINUTES, Math.round(parsed))
  );
  if (minutes === current) return { status: "unchanged" };
  return { status: "ok", value: minutes };
}

/**
 * 通知時刻（`<input type="time">`）の入力を確定する。時と分を打ち分けている途中でも値が
 * 完成すると change が発火するため、入力のたびに保存せず入力欄から離れたときだけ呼ぶ。
 * 空欄（消した状態）は確定せず、保存済みの値へ戻す。
 */
export function commitTimeDraft(current: string, raw: string): DraftCommit<string> {
  const value = raw.trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return { status: "unchanged" };
  if (value === current) return { status: "unchanged" };
  return { status: "ok", value };
}

function isIosNotInstalledPwa(): boolean {
  if (typeof window === "undefined") return false;
  const isIos = /iPad|iPhone|iPod/.test(window.navigator.userAgent);
  const isStandalone =
    ("standalone" in window.navigator && Boolean((window.navigator as { standalone?: boolean }).standalone)) ||
    window.matchMedia?.("(display-mode: standalone)").matches;
  return isIos && !isStandalone;
}

function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-8 w-[58px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-foreground" : "bg-muted-foreground/50"
      }`}
    >
      <span
        className={`absolute top-[3px] size-[26px] rounded-full bg-white shadow transition-all ${
          checked ? "left-[29px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

export function NotificationSettingsSheet({ open, onClose }: NotificationSettingsSheetProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [subscribed, setSubscribed] = useState(false);
  const [vapidConfigured, setVapidConfigured] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [garbageCategories, setGarbageCategories] = useState<GarbageCategoryNext[]>([]);
  //: 数値入力の下書き。入力中はこちらを表示し、入力欄から離れたときだけ保存する。
  //: キーが無い欄は保存済みの値をそのまま出す（effect で詰め直さないための持ち方）
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    setInfo("");
    setDrafts({});
    try {
      const [uiSettings, existingSubscription] = await Promise.all([
        fetchUiSettings(),
        getExistingPushSubscription(),
      ]);
      setSettings(uiSettings);
      setSubscribed(Boolean(existingSubscription));
      setSupported(isPushNotificationsSupported());
      setPermission(getNotificationPermission());

      try {
        const { configured } = await fetchPushVapidPublicKey();
        setVapidConfigured(configured);
      } catch {
        setVapidConfigured(false);
      }

      try {
        const schedule = await fetchGarbageSchedule();
        setGarbageCategories(schedule.by_category ?? []);
      } catch {
        setGarbageCategories([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const saveSettings = async (patch: Partial<UiSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    setError("");
    try {
      const saved = await updateUiSettings(patch);
      setSettings(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setSettings(settings);
    } finally {
      setSaving(false);
    }
  };

  const setDraft = (key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const takeDraft = (key: string): string | undefined => {
    const raw = drafts[key];
    if (raw !== undefined) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    return raw;
  };

  const commitThreshold = (metric: ThresholdMetric, bound: ThresholdBound) => {
    const raw = takeDraft(thresholdDraftKey(metric, bound));
    if (raw === undefined || !settings) return;
    const result = commitThresholdDraft(settings.room_anomaly_thresholds, metric, bound, raw);
    if (result.status === "invalid") {
      setError(result.message);
      return;
    }
    if (result.status === "unchanged") return;
    setError("");
    void saveSettings({ room_anomaly_thresholds: result.value });
  };

  const commitReminder = () => {
    const raw = takeDraft(REMINDER_DRAFT_KEY);
    if (raw === undefined || !settings) return;
    const result = commitReminderDraft(settings.room_anomaly_reminder_minutes, raw);
    if (result.status !== "ok") return;
    setError("");
    void saveSettings({ room_anomaly_reminder_minutes: result.value });
  };

  const commitGarbageTime = (
    draftKey: string,
    field: "garbage_notify_time" | "garbage_notify_same_day_time",
    fallback: string
  ) => {
    const raw = takeDraft(draftKey);
    if (raw === undefined || !settings) return;
    const result = commitTimeDraft(settings[field] ?? fallback, raw);
    if (result.status !== "ok") return;
    setError("");
    void saveSettings({ [field]: result.value });
  };

  const handleEnablePush = async () => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setError("通知の許可が必要です。ブラウザまたは端末の通知設定を確認してください。");
        return;
      }

      const { publicKey } = await fetchPushVapidPublicKey();
      const subscription = await subscribeToPushNotifications(publicKey);
      await subscribePushNotifications(subscriptionToJson(subscription));
      setSubscribed(true);
      setInfo("プッシュ通知を有効にしました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "有効化に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleDisablePush = async () => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const subscription = await unsubscribeFromPushNotifications();
      if (subscription) {
        await unsubscribePushNotifications(subscription.endpoint);
      }
      setSubscribed(false);
      setInfo("この端末への配信を停止しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "無効化に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleTestPush = async () => {
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const result = await sendTestPushNotification();
      setInfo(`テスト通知を送信しました（${result.sent}/${result.total} 件）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "テスト送信に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="通知設定"
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-[20px] bg-card shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-lg font-bold">通知設定</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full hover:bg-accent"
            aria-label="閉じる"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {loading || !settings ? (
            <p className="py-6 text-center text-sm text-muted-foreground">読み込み中...</p>
          ) : (
            <div className="space-y-5">
              {error && <p className="text-sm text-destructive">{error}</p>}
              {info && <p className="text-sm text-muted-foreground">{info}</p>}

              <section className="space-y-3 border-b pb-5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  プッシュ通知
                </p>

                {isNativeApp() ? (
                  // iOSアプリ（WKWebView）ではWeb Pushを受け取れない。ネイティブの通知は別Issue（#526）
                  <p className="text-[13px] text-muted-foreground">
                    iOSアプリではプッシュ通知を受け取れません。通知はホーム画面に追加したWeb版（PWA）で設定してください。
                  </p>
                ) : !supported ? (
                  <p className="text-[13px] text-muted-foreground">
                    このブラウザまたは環境ではプッシュ通知に対応していません。
                    {isIosNotInstalledPwa()
                      ? " iPhoneでは、ホーム画面に追加したマイルームを開いてから有効にしてください。"
                      : ""}
                  </p>
                ) : !vapidConfigured ? (
                  <p className="text-[13px] text-muted-foreground">
                    サーバー側でプッシュ通知が未設定のため、いまは有効にできません。
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[15px] font-bold">プッシュ通知を受け取る</p>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                          {subscribed
                            ? "この端末は購読中です"
                            : "オフのままだとこの端末には配信されません"}
                          {permission === "denied"
                            ? "（OSの通知が拒否されています。端末の設定から許可してください）"
                            : ""}
                        </p>
                      </div>
                      <ToggleSwitch
                        checked={subscribed}
                        disabled={saving || permission === "denied"}
                        label="プッシュ通知を受け取る"
                        onChange={(next) => void (next ? handleEnablePush() : handleDisablePush())}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={saving || !subscribed}
                      onClick={() => void handleTestPush()}
                      className="w-full rounded-xl border bg-muted/40 px-4 py-2.5 text-[13.5px] font-bold transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      テスト通知を送信
                    </button>
                  </>
                )}
              </section>

              <section className="space-y-4 border-b pb-5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  ゴミの日を通知する
                </p>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-bold">前日に通知する</p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                        収集予定日の前日、設定した時刻に通知します
                      </p>
                    </div>
                    <ToggleSwitch
                      checked={settings.garbage_notify_enabled}
                      disabled={saving}
                      label="前日に通知する"
                      onChange={(next) => void saveSettings({ garbage_notify_enabled: next })}
                    />
                  </div>
                  {settings.garbage_notify_enabled && (
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="garbage-notify-time" className="text-[13px]">
                        通知時刻
                      </label>
                      <input
                        id="garbage-notify-time"
                        type="time"
                        value={
                          drafts[GARBAGE_TIME_DRAFT_KEY] ??
                          settings.garbage_notify_time ??
                          DEFAULT_GARBAGE_NOTIFY_TIME
                        }
                        onChange={(event) => setDraft(GARBAGE_TIME_DRAFT_KEY, event.target.value)}
                        onBlur={() =>
                          commitGarbageTime(
                            GARBAGE_TIME_DRAFT_KEY,
                            "garbage_notify_time",
                            DEFAULT_GARBAGE_NOTIFY_TIME
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        className="rounded-full bg-muted/40 px-3 py-1.5 text-[13.5px] font-bold tabular-nums"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-bold">当日に通知する</p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                        収集当日の朝、設定した時刻に通知します
                      </p>
                    </div>
                    <ToggleSwitch
                      checked={settings.garbage_notify_same_day_enabled}
                      disabled={saving}
                      label="当日に通知する"
                      onChange={(next) =>
                        void saveSettings({ garbage_notify_same_day_enabled: next })
                      }
                    />
                  </div>
                  {settings.garbage_notify_same_day_enabled && (
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="garbage-notify-same-day-time" className="text-[13px]">
                        通知時刻
                      </label>
                      <input
                        id="garbage-notify-same-day-time"
                        type="time"
                        value={
                          drafts[GARBAGE_SAME_DAY_TIME_DRAFT_KEY] ??
                          settings.garbage_notify_same_day_time ??
                          DEFAULT_GARBAGE_NOTIFY_SAME_DAY_TIME
                        }
                        onChange={(event) =>
                          setDraft(GARBAGE_SAME_DAY_TIME_DRAFT_KEY, event.target.value)
                        }
                        onBlur={() =>
                          commitGarbageTime(
                            GARBAGE_SAME_DAY_TIME_DRAFT_KEY,
                            "garbage_notify_same_day_time",
                            DEFAULT_GARBAGE_NOTIFY_SAME_DAY_TIME
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        className="rounded-full bg-muted/40 px-3 py-1.5 text-[13.5px] font-bold tabular-nums"
                      />
                    </div>
                  )}
                </div>

                {garbageCategories.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      ゴミの種類ごとの通知タイミング（前日・当日は独立にON/OFFでき、両方選ぶこともできます）
                    </p>
                    <div className="space-y-1.5">
                      {garbageCategories.map((category) => (
                        <div
                          key={category.id}
                          className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: category.color }}
                            />
                            <span className="truncate text-[13px] font-bold">
                              {category.name}
                            </span>
                          </div>
                          <div className="flex shrink-0 gap-1.5">
                            {(["before", "same_day"] as const).map((timing) => {
                              const active = categoryHasTiming(
                                settings.garbage_notify_category_timing,
                                category.id,
                                timing
                              );
                              return (
                                <button
                                  key={timing}
                                  type="button"
                                  disabled={saving}
                                  aria-pressed={active}
                                  onClick={() =>
                                    void saveSettings({
                                      garbage_notify_category_timing: toggleCategoryTiming(
                                        settings.garbage_notify_category_timing,
                                        category.id,
                                        timing,
                                        !active
                                      ),
                                    })
                                  }
                                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    active
                                      ? "border-foreground bg-foreground text-background"
                                      : "border-border bg-transparent text-muted-foreground"
                                  }`}
                                >
                                  {timing === "before" ? "前日" : "当日"}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold">室温・湿度の異常を通知する</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      閾値を超えたときと、正常に戻ったときに通知します
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={settings.room_anomaly_notify_enabled}
                    disabled={saving}
                    label="室温・湿度の異常を通知する"
                    onChange={(next) => void saveSettings({ room_anomaly_notify_enabled: next })}
                  />
                </div>

                {settings.room_anomaly_notify_enabled && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {THRESHOLD_FIELDS.map((field) => {
                        const key = thresholdDraftKey(field.metric, field.bound);
                        const stored = settings.room_anomaly_thresholds[field.metric][field.bound];
                        return (
                          <label key={key} className="block">
                            <span className="text-[11px] text-muted-foreground">{field.label}</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              step={field.step}
                              value={drafts[key] ?? String(stored)}
                              onChange={(event) => setDraft(key, event.target.value)}
                              onBlur={() => commitThreshold(field.metric, field.bound)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur();
                              }}
                              className="mt-1 w-full rounded-lg bg-muted/40 px-2.5 py-1.5 text-[13.5px] font-bold tabular-nums"
                            />
                          </label>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="room-anomaly-reminder" className="text-[13px]">
                        同じ異常の再通知間隔
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          id="room-anomaly-reminder"
                          type="number"
                          inputMode="numeric"
                          min={MIN_REMINDER_MINUTES}
                          max={MAX_REMINDER_MINUTES}
                          value={
                            drafts[REMINDER_DRAFT_KEY] ??
                            String(settings.room_anomaly_reminder_minutes)
                          }
                          onChange={(event) => setDraft(REMINDER_DRAFT_KEY, event.target.value)}
                          onBlur={commitReminder}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                          className="w-20 rounded-full bg-muted/40 px-3 py-1.5 text-right text-[13.5px] font-bold tabular-nums"
                        />
                        <span className="text-[13px] text-muted-foreground">分</span>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
