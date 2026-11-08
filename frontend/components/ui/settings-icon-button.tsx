"use client";

import Link from "next/link";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 設定への入口。**アプリの中で1つの形に揃えるためのコンポーネント**（#277）。
 *
 * 以前は「いまの環境」が歯車＋「表示設定」の文字、掃除カードが文字だけの「設定」で、
 * 同じ役割なのに形が違っていた。ここに寄せて、**位置だけが意味を分ける**ようにする。
 *
 * - ヘッダー右上（`tone="header"`）＝ アプリ全体の設定
 * - セクション見出し・カード見出し（`tone="inline"`）＝ その場の設定
 *
 * 文字ラベルは出さないので、`label` は `aria-label` と `title` の両方に入れる
 * （読み上げと、PCでの長押し／ホバーのツールチップで伝わる）。
 */
interface SettingsIconButtonProps {
  /** 読み上げ・ツールチップに使う名前。「表示設定」「暮らしの設定」など */
  label: string;
  /** 大きめ（ヘッダー）か、小さめ（セクション・カード）か。見た目はどちらも枠なし（#483） */
  tone?: "header" | "inline";
  className?: string;
  /** 渡すとリンクになる。渡さなければ `onClick` のボタン */
  href?: string;
  onClick?: () => void;
}

function iconButtonClass(tone: "header" | "inline", className?: string) {
  return cn(
    "flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    tone === "header" ? "size-9" : "size-8",
    className
  );
}

export function SettingsIconButton({
  label,
  tone = "inline",
  className,
  href,
  onClick,
}: SettingsIconButtonProps) {
  const icon = <Settings className="size-[18px]" strokeWidth={1.75} />;

  if (href) {
    return (
      <Link
        href={href}
        aria-label={label}
        title={label}
        className={iconButtonClass(tone, className)}
      >
        {icon}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={iconButtonClass(tone, className)}
    >
      {icon}
    </button>
  );
}
