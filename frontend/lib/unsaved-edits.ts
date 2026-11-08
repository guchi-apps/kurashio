"use client";

import { useEffect } from "react";

/**
 * 「いま書きかけの入力を抱えている画面が開いているか」を、コンポーネントの木をまたいで
 * 知るための印（#277）。
 *
 * `components/app-update-checker.tsx` はバックグラウンドから戻った瞬間に自動でリロードする。
 * このアプリの設定シートは**閉じるまで保存しない**（電気の操作の設定・
 * ダッシュボードの表示）ため、そのまま流すと編集中に別アプリへ行って戻っただけで
 * 入力が黙って消える。開いている間はリロードを止め、バナーに倒す。
 *
 * 保存済みの内容しか持たない画面（ダッシュボード本体・詳細パネル）では呼ばない。
 */
let openEditors = 0;

export function hasUnsavedEdits(): boolean {
  return openEditors > 0;
}

/** 印を立てる。戻り値を呼ぶと下ろす（`useUnsavedEdits` が後始末に使う） */
export function beginUnsavedEdits(): () => void {
  openEditors += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openEditors = Math.max(0, openEditors - 1);
  };
}

/** テスト用。カウンタを初期状態へ戻す */
export function resetUnsavedEdits(): void {
  openEditors = 0;
}

/**
 * 未保存の編集を抱えている間だけ印を立てる。
 * `active` を渡さなければ、マウントしている間ずっと立てる。
 */
export function useUnsavedEdits(active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    return beginUnsavedEdits();
  }, [active]);
}
