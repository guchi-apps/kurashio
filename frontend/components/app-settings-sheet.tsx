"use client";

import { Bell, ChevronRight, LogOut, RotateCcw, X } from "lucide-react";
import { APP_VERSION } from "@/lib/app-version";
import { WidgetRefreshRow } from "@/components/widget-refresh-row";

interface AppSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  onReload: () => void;
  onLogout: () => void;
  onOpenVersionHistory: () => void;
  onOpenNotificationSettings: () => void;
}

/**
 * アプリ全体の設定シート（#277）。
 *
 * 以前はページの末尾に「画面再読み込み」「ログアウト」「バージョン」がフッターとして
 * 並んでいたが、**どれも普段は押さないのに、掃除カードの次に大きい面積を取っていた**。
 * ヘッダー右上の設定アイコンから開くここへ移し、フッターごと無くしている。
 *
 * 出し方（スマホは下から、PCは中央）は `version-history-dialog.tsx` と揃える。
 */
export function AppSettingsSheet({
  open,
  onClose,
  onReload,
  onLogout,
  onOpenVersionHistory,
  onOpenNotificationSettings,
}: AppSettingsSheetProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        className="w-full max-w-md overflow-hidden rounded-[20px] bg-card shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-lg font-bold">設定</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full hover:bg-accent"
            aria-label="閉じる"
          >
            <X className="size-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={onReload}
          className="flex w-full items-start gap-3 border-b px-5 py-3.5 text-left transition-colors hover:bg-accent"
        >
          <RotateCcw
            className="mt-0.5 size-[19px] shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold leading-snug">
              アプリを再読み込み
            </span>
            {/*
              バージョンの取り込みは `app-update-checker.tsx` が自動で行う。
              ここは表示が崩れたときの手当てとして残すだけなので、そう分かる文言にする。
            */}
            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
              新しいバージョンは自動で入ります。表示が崩れたときだけ、ここからページ全体を開き直してください。
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenNotificationSettings}
          className="flex w-full items-start gap-3 border-b px-5 py-3.5 text-left transition-colors hover:bg-accent"
        >
          <Bell className="mt-0.5 size-[19px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold leading-snug">通知設定</span>
            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
              ゴミの日・室温湿度の異常をプッシュ通知で受け取れます
            </span>
          </span>
        </button>

        <WidgetRefreshRow />

        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-3 border-b px-5 py-3.5 text-left text-destructive transition-colors hover:bg-accent"
        >
          <LogOut className="size-[19px] shrink-0" strokeWidth={1.75} />
          <span className="text-[15px] font-bold">ログアウト</span>
        </button>

        <button
          type="button"
          onClick={onOpenVersionHistory}
          className="flex w-full items-center justify-between gap-3 bg-muted px-5 py-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent"
        >
          <span>バージョン {APP_VERSION}</span>
          <span className="flex items-center gap-1">
            更新履歴
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </span>
        </button>
      </div>
    </div>
  );
}
