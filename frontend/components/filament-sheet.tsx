"use client";

import { useState } from "react";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createFilamentSpool,
  deleteFilamentSpool,
  deleteFilamentUsage,
  deleteFilamentWeighing,
  recordFilamentUsage,
  recordFilamentWeighing,
  setActiveFilamentSpool,
  updateFilamentSpool,
} from "@/lib/api";
import {
  DEFAULT_NET_G,
  FILAMENT_COLOR_PRESETS,
  FILAMENT_MATERIALS,
  LEVEL_TEXT_CLASS,
  MAX_GROSS_G,
  MAX_NET_G,
  MAX_TARE_G,
  MAX_USAGE_G,
  buildCalcRows,
  buildHistory,
  formatFilamentDate,
  formatGrams,
  formatLevelHint,
  getActiveSpool,
  parseGramsInput,
  splitSpools,
  type FilamentMaterial,
  type FilamentPayload,
  type FilamentSpool,
  type FilamentSpoolInput,
} from "@/lib/filament";
import { LevelBar, SpoolSwatch } from "@/components/filament-parts";
import { useUnsavedEdits } from "@/lib/unsaved-edits";
import { cn } from "@/lib/utils";

/** シートの外枠。ゴミの日の詳細パネルと同じ形にそろえる */
function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex min-h-0 items-end justify-center bg-black/40 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-label={title}
        className="flex min-h-0 max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[20px] bg-card shadow-lg sm:max-h-[88vh] sm:rounded-[20px]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{title}</h2>
            {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [-webkit-overflow-scrolling:touch]">
          {children}
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-[11px] tracking-wider text-muted-foreground">
      {children}
    </label>
  );
}

const INPUT_CLASS = "h-10 tabular-nums";

type Run = (action: () => Promise<FilamentPayload>) => Promise<boolean>;

// --- スプールの追加・編集フォーム ---------------------------------------------

/**
 * 追加と編集で共用する入力フォーム。**下書きは文字列のまま持ち、「保存」で数値へ読む**（#348）。
 * 変更のたびに保存すると、途中の値（空欄・「1」だけ）が保存されて打ち直せなくなる。
 */
function SpoolForm({
  mode,
  spool,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  spool: FilamentSpool | null;
  busy: boolean;
  onSubmit: (input: FilamentSpoolInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(spool?.name ?? "");
  const [material, setMaterial] = useState<FilamentMaterial>(spool?.material ?? "PLA");
  const [color, setColor] = useState<string | null>(spool?.color ?? null);
  const [purchasedOn, setPurchasedOn] = useState(spool?.purchased_on ?? "");
  const [netG, setNetG] = useState(String(spool?.net_g ?? DEFAULT_NET_G));
  const [tareG, setTareG] = useState(spool?.tare_g != null ? String(spool.tare_g) : "");
  const [grossG, setGrossG] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const idPrefix = `spool-form-${mode}-${spool?.id ?? "new"}`;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setFormError("名前を入力してください");
    const net = parseGramsInput(netG, 1, MAX_NET_G);
    if (net == null) return setFormError(`初期フィラメント量は1〜${MAX_NET_G}gで入力してください`);
    let tare: number | null = null;
    if (tareG.trim() !== "") {
      tare = parseGramsInput(tareG, 0, MAX_TARE_G);
      if (tare == null) return setFormError(`空スプールの重さは0〜${MAX_TARE_G}gで入力してください`);
    }
    let gross: number | null = null;
    if (mode === "create" && grossG.trim() !== "") {
      gross = parseGramsInput(grossG, 0, MAX_GROSS_G);
      if (gross == null) return setFormError(`全体重量は0〜${MAX_GROSS_G}gで入力してください`);
      if (tare == null) return setFormError("いまの全体重量を入れるには、空スプールの重さも必要です");
    }
    setFormError(null);
    onSubmit({
      name: trimmed,
      material,
      color,
      purchased_on: purchasedOn || null,
      net_g: net,
      tare_g: tare,
      ...(mode === "create" ? { current_gross_g: gross } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-muted p-3">
      <div>
        <FieldLabel htmlFor={`${idPrefix}-name`}>名前</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          maxLength={60}
          placeholder="例: ELEGOO PLA (ホワイト)"
          onChange={(event) => setName(event.target.value)}
          className="h-10"
        />
      </div>

      <div>
        <FieldLabel>素材</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {FILAMENT_MATERIALS.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={material === item}
              onClick={() => setMaterial(item)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-bold",
                material === item
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground"
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div>
        <FieldLabel>色</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          {FILAMENT_COLOR_PRESETS.map((preset) => (
            <button
              key={preset.color}
              type="button"
              aria-label={preset.name}
              aria-pressed={color === preset.color}
              onClick={() => setColor(preset.color)}
              className={cn(
                "rounded-full p-0.5",
                color === preset.color && "outline outline-2 outline-offset-1 outline-foreground"
              )}
            >
              <SpoolSwatch color={preset.color} />
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="color"
              aria-label="色を選ぶ"
              value={color ?? "#888888"}
              onChange={(event) => setColor(event.target.value.toUpperCase())}
              className="size-7 cursor-pointer rounded-full border-0 bg-transparent p-0"
            />
            その他
          </label>
          {color && (
            <button
              type="button"
              onClick={() => setColor(null)}
              className="text-[11px] text-muted-foreground underline"
            >
              色なし
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <FieldLabel htmlFor={`${idPrefix}-net`}>初期フィラメント量（g）</FieldLabel>
          <Input
            id={`${idPrefix}-net`}
            inputMode="decimal"
            value={netG}
            onChange={(event) => setNetG(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <FieldLabel htmlFor={`${idPrefix}-tare`}>空スプールの重さ（g）</FieldLabel>
          <Input
            id={`${idPrefix}-tare`}
            inputMode="decimal"
            value={tareG}
            placeholder="例: 152"
            onChange={(event) => setTareG(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        {mode === "create" && (
          <div className="col-span-2">
            <FieldLabel htmlFor={`${idPrefix}-gross`}>いまの全体重量（使いかけのとき・g）</FieldLabel>
            <Input
              id={`${idPrefix}-gross`}
              inputMode="decimal"
              value={grossG}
              placeholder="スプールごと秤に載せた重さ"
              onChange={(event) => setGrossG(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
        )}
        <div className="col-span-2">
          <FieldLabel htmlFor={`${idPrefix}-purchased`}>購入日（任意）</FieldLabel>
          <Input
            id={`${idPrefix}-purchased`}
            type="date"
            value={purchasedOn}
            onChange={(event) => setPurchasedOn(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        空スプールの重さは、秤で量った全体重量から残量を出すときに使います。未入力だと計量はできず、使用量だけで管理します。
      </p>

      {formError && <p className="text-xs text-destructive">{formError}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          onClick={onCancel}
        >
          キャンセル
        </Button>
        <Button
          type="button"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          disabled={busy}
          onClick={submit}
        >
          {busy ? "保存中..." : mode === "create" ? "追加する" : "保存する"}
        </Button>
      </div>
    </div>
  );
}

// --- 使用量・計量のフォーム ---------------------------------------------------

function UsageForm({
  today,
  suggestedNote,
  busy,
  onSubmit,
  onCancel,
}: {
  today: string;
  suggestedNote: string | null;
  busy: boolean;
  onSubmit: (grams: number, date: string, note: string) => void;
  onCancel: () => void;
}) {
  const [grams, setGrams] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState(suggestedNote ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    const value = parseGramsInput(grams, 0.1, MAX_USAGE_G);
    if (value == null) return setFormError(`使った量は0.1〜${MAX_USAGE_G}gで入力してください`);
    if (!date || date > today) return setFormError("今日以前の日付を選んでください");
    setFormError(null);
    onSubmit(value, date, note.trim());
  };

  return (
    <div className="mt-3 grid grid-cols-2 gap-2.5 rounded-2xl bg-muted p-3">
      <div>
        <FieldLabel htmlFor="filament-usage-grams">使った量（g）</FieldLabel>
        <Input
          id="filament-usage-grams"
          inputMode="decimal"
          value={grams}
          placeholder="例: 26.4"
          onChange={(event) => setGrams(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <FieldLabel htmlFor="filament-usage-date">印刷した日</FieldLabel>
        <Input
          id="filament-usage-date"
          type="date"
          value={date}
          max={today}
          onChange={(event) => setDate(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="col-span-2">
        <FieldLabel htmlFor="filament-usage-note">メモ（任意）</FieldLabel>
        <Input
          id="filament-usage-note"
          value={note}
          maxLength={60}
          placeholder="印刷したもの"
          onChange={(event) => setNote(event.target.value)}
          className="h-10"
        />
      </div>
      <p className="col-span-2 text-[11px] text-muted-foreground">
        スライサーの「フィラメント使用量」に出る数字を入れます。間違えたときは、履歴の行を取り消して入れ直してください。
      </p>
      {formError && <p className="col-span-2 text-xs text-destructive">{formError}</p>}
      <div className="col-span-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          onClick={onCancel}
        >
          キャンセル
        </Button>
        <Button
          type="button"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          disabled={busy}
          onClick={submit}
        >
          {busy ? "記録中..." : "記録する"}
        </Button>
      </div>
    </div>
  );
}

function WeighForm({
  spool,
  today,
  busy,
  onSubmit,
  onCancel,
  onEditSpool,
}: {
  spool: FilamentSpool;
  today: string;
  busy: boolean;
  onSubmit: (grossG: number, date: string) => void;
  onCancel: () => void;
  onEditSpool: () => void;
}) {
  const [gross, setGross] = useState("");
  const [date, setDate] = useState(today);
  const [formError, setFormError] = useState<string | null>(null);

  if (spool.tare_g == null) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-2xl bg-muted p-3 text-sm">
        <p>計量には空スプールの重さが必要です。先にスプールの設定へ入力してください。</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-10 flex-1 rounded-xl" onClick={onCancel}>
            閉じる
          </Button>
          <Button type="button" className="h-10 flex-1 rounded-xl font-bold" onClick={onEditSpool}>
            設定を開く
          </Button>
        </div>
      </div>
    );
  }

  const parsed = parseGramsInput(gross, 0, MAX_GROSS_G);
  const submit = () => {
    if (parsed == null) return setFormError(`全体重量は0〜${MAX_GROSS_G}gで入力してください`);
    if (!date || date > today) return setFormError("今日以前の日付を選んでください");
    setFormError(null);
    onSubmit(parsed, date);
  };

  return (
    <div className="mt-3 grid grid-cols-2 gap-2.5 rounded-2xl bg-muted p-3">
      <div>
        <FieldLabel htmlFor="filament-weigh-gross">全体重量（スプールごと・g）</FieldLabel>
        <Input
          id="filament-weigh-gross"
          inputMode="decimal"
          value={gross}
          placeholder="例: 611"
          onChange={(event) => setGross(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <FieldLabel htmlFor="filament-weigh-date">量った日</FieldLabel>
        <Input
          id="filament-weigh-date"
          type="date"
          value={date}
          max={today}
          onChange={(event) => setDate(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <p className="col-span-2 text-[11px] text-muted-foreground">
        {parsed != null
          ? `空スプール ${spool.tare_g}g を引くと、フィラメントの重さは ${formatGrams(Math.max(parsed - spool.tare_g, 0))}g です。`
          : "秤で量った重さを入れると、以後の残量はこの値が基準になります（これより前の使用量は引きません）。"}
      </p>
      {formError && <p className="col-span-2 text-xs text-destructive">{formError}</p>}
      <div className="col-span-2 flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          onClick={onCancel}
        >
          キャンセル
        </Button>
        <Button
          type="button"
          className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
          disabled={busy}
          onClick={submit}
        >
          {busy ? "記録中..." : "この重さで合わせる"}
        </Button>
      </div>
    </div>
  );
}

// --- スプール1本 --------------------------------------------------------------

type DetailMode = "usage" | "weigh" | "edit" | null;

function SpoolDetail({
  spool,
  today,
  suggestedNote,
  busy,
  run,
}: {
  spool: FilamentSpool;
  today: string;
  suggestedNote: string | null;
  busy: boolean;
  run: Run;
}) {
  const [mode, setMode] = useState<DetailMode>(null);
  // 取り消し・削除は押し間違えると残量が動くので、同じ場所でもう一度押させる
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const rows = buildCalcRows(spool);
  const history = buildHistory(spool);
  const close = () => setMode(null);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="text-[12.5px] tabular-nums">
        {rows.map((row) => (
          <div
            key={row.label}
            className={cn(
              "flex justify-between gap-3 py-0.5",
              row.total ? "mt-1 border-t border-border pt-1.5 font-bold" : "text-muted-foreground"
            )}
          >
            <span>{row.label}</span>
            <span className={row.total ? LEVEL_TEXT_CLASS[spool.level] : "text-foreground"}>
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {!spool.archived && (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            variant={mode === "usage" ? "outline" : "default"}
            className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
            onClick={() => setMode(mode === "usage" ? null : "usage")}
          >
            使用量を記録
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 flex-1 rounded-xl text-[13.5px] font-bold"
            onClick={() => setMode(mode === "weigh" ? null : "weigh")}
          >
            計量して合わせる
          </Button>
        </div>
      )}

      {mode === "usage" && (
        <UsageForm
          key="usage"
          today={today}
          suggestedNote={suggestedNote}
          busy={busy}
          onCancel={close}
          onSubmit={async (grams, date, note) => {
            if (await run(() => recordFilamentUsage(spool.id, grams, date, note))) close();
          }}
        />
      )}
      {mode === "weigh" && (
        <WeighForm
          key="weigh"
          spool={spool}
          today={today}
          busy={busy}
          onCancel={close}
          onEditSpool={() => setMode("edit")}
          onSubmit={async (gross, date) => {
            if (await run(() => recordFilamentWeighing(spool.id, gross, date))) close();
          }}
        />
      )}
      {mode === "edit" && (
        <div className="mt-3">
          <SpoolForm
            key="edit"
            mode="edit"
            spool={spool}
            busy={busy}
            onCancel={close}
            onSubmit={async (input) => {
              if (await run(() => updateFilamentSpool(spool.id, input))) close();
            }}
          />
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] tracking-wider text-muted-foreground">履歴</p>
          {history.map((row) => {
            const confirming = pendingDelete === row.key;
            return (
              <div
                key={row.key}
                className="flex items-baseline gap-2 border-t border-border py-1.5 text-[12.5px] tabular-nums first:border-t-0"
              >
                <span className="w-[3.6em] shrink-0 text-muted-foreground">
                  {formatFilamentDate(row.date)}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", row.settled && "text-muted-foreground")}>
                  {row.label}
                  {row.badge && (
                    <span
                      className={cn(
                        "ml-1.5 rounded-full px-1.5 align-[1px] text-[10.5px] font-bold",
                        row.badge === "estimate"
                          ? "bg-[#a86200]/15 text-[#a86200] dark:bg-[#f0b556]/15 dark:text-[#f0b556]"
                          : "bg-[color:var(--printer-color)]/15 text-[color:var(--printer-color)]"
                      )}
                    >
                      {row.badge === "estimate" ? "自動・概算" : "自動"}
                    </span>
                  )}
                  {row.settled && (
                    <span className="ml-1.5 text-[10.5px]">計量に反映済み</span>
                  )}
                </span>
                <span className={cn("shrink-0 font-bold", row.settled && "font-normal text-muted-foreground")}>
                  {row.value}
                </span>
                {confirming ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setPendingDelete(null);
                      await run(() =>
                        row.kind === "usage"
                          ? deleteFilamentUsage(spool.id, row.id)
                          : deleteFilamentWeighing(spool.id, row.id)
                      );
                    }}
                    className="shrink-0 rounded-full bg-destructive px-2.5 py-0.5 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    取り消す
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingDelete(row.key)}
                    className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                    aria-label={`${formatFilamentDate(row.date)}の${row.kind === "usage" ? "使用量" : "計量"}を取り消す`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={() => setMode(mode === "edit" ? null : "edit")}
        >
          スプールの設定
        </button>
        <button
          type="button"
          disabled={busy}
          className="text-muted-foreground underline disabled:opacity-50"
          onClick={() => run(() => updateFilamentSpool(spool.id, { archived: !spool.archived }))}
        >
          {spool.archived ? "使い切りを戻す" : "使い切りにする"}
        </button>
        {pendingDelete === `spool:${spool.id}` ? (
          <button
            type="button"
            disabled={busy}
            className="rounded-full bg-destructive px-2.5 py-0.5 text-[11px] font-bold text-white disabled:opacity-50"
            onClick={() => run(() => deleteFilamentSpool(spool.id))}
          >
            記録ごと削除する
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="text-muted-foreground underline hover:text-destructive disabled:opacity-50"
            onClick={() => setPendingDelete(`spool:${spool.id}`)}
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
}

function SpoolRow({
  spool,
  expanded,
  today,
  suggestedNote,
  busy,
  run,
  onToggle,
}: {
  spool: FilamentSpool;
  expanded: boolean;
  today: string;
  suggestedNote: string | null;
  busy: boolean;
  run: Run;
  onToggle: () => void;
}) {
  const hint = formatLevelHint(spool);
  const meta = [
    spool.material,
    spool.purchased_on ? `${formatFilamentDate(spool.purchased_on)} 購入` : null,
  ]
    .filter(Boolean)
    .join("・");

  return (
    <div
      className={cn(
        "rounded-2xl border p-3",
        spool.active ? "border-[color:var(--printer-color)]" : "border-border"
      )}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <SpoolSwatch color={spool.color} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold leading-snug">
              {spool.name}
              {spool.active && (
                <span className="ml-1.5 rounded-full bg-[color-mix(in_srgb,var(--printer-color)_16%,transparent)] px-2 py-px align-[1px] text-[10.5px] font-bold text-[color:var(--printer-color)]">
                  使用中
                </span>
              )}
            </span>
            <span className="block truncate text-[11.5px] text-muted-foreground">{meta}</span>
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
          />
        </button>
        {!spool.active && !spool.archived && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => setActiveFilamentSpool(spool.id))}
            className="shrink-0 whitespace-nowrap rounded-full border border-border px-2.5 py-0.5 text-xs font-bold disabled:opacity-50"
          >
            これを使う
          </button>
        )}
        <div className="shrink-0 whitespace-nowrap text-right text-xs leading-tight text-muted-foreground tabular-nums">
          <b className={cn("text-lg", LEVEL_TEXT_CLASS[spool.level])}>{formatGrams(spool.remaining_g)} g</b>
          <br />
          {spool.percent}%{hint ? `・${hint}` : ""}
        </div>
      </div>
      <div className="mt-2">
        <LevelBar spool={spool} label={`${spool.name}の残量`} />
      </div>
      {expanded && (
        <SpoolDetail
          key={spool.id}
          spool={spool}
          today={today}
          suggestedNote={suggestedNote}
          busy={busy}
          run={run}
        />
      )}
    </div>
  );
}

// --- シート -------------------------------------------------------------------

interface FilamentSheetProps {
  payload: FilamentPayload;
  /** 直近に終わった印刷の名前。使用量のメモの初期値にする */
  suggestedNote?: string | null;
  onChange: (payload: FilamentPayload) => void;
  onClose: () => void;
}

/**
 * フィラメント在庫のシート（#445）。
 *
 * スプールの追加・使用量の記録・計量・使い切りをここで行う。**開いている間だけ描く**
 * （呼び出し側が `filamentOpen` で出し分ける）ので、下書きの状態は閉じると消える。
 * 入力途中で別アプリから戻ったときに自動リロードで消えないよう、`useUnsavedEdits()` で印を立てる（#277）。
 */
export function FilamentSheet({
  payload,
  suggestedNote = null,
  onChange,
  onClose,
}: FilamentSheetProps) {
  useUnsavedEdits();
  const { inUse, archived } = splitSpools(payload);
  const active = getActiveSpool(payload);

  const [expandedId, setExpandedId] = useState<string | null>(
    () => payload.active_id ?? inUse[0]?.id ?? null
  );
  const [adding, setAdding] = useState(() => payload.spools.length === 0);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run: Run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存できませんでした");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (spool: FilamentSpool) => (
    <SpoolRow
      key={spool.id}
      spool={spool}
      expanded={expandedId === spool.id}
      today={payload.today}
      suggestedNote={suggestedNote}
      busy={busy}
      run={run}
      onToggle={() => setExpandedId(expandedId === spool.id ? null : spool.id)}
    />
  );

  return (
    <Sheet
      title="フィラメント在庫"
      subtitle={active ? `使用中: ${active.name}` : "使用中のスプールはありません"}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2.5">
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {payload.spools.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">まだスプールが登録されていません。</p>
        )}

        {inUse.map(renderRow)}

        {adding ? (
          <SpoolForm
            key="create"
            mode="create"
            spool={null}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              if (await run(() => createFilamentSpool(input))) setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-dashed border-border px-3 py-2.5 text-[13px] font-bold text-muted-foreground"
          >
            <Plus className="size-4" />
            スプールを追加
          </button>
        )}

        {archived.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
              className="text-center text-[12.5px] text-muted-foreground"
            >
              使い切ったスプール {archived.length}本 {archivedOpen ? "▲" : "▼"}
            </button>
            {archivedOpen && archived.map(renderRow)}
          </>
        )}
      </div>
    </Sheet>
  );
}
