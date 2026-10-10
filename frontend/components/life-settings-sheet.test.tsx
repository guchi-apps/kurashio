import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeSettingsSheet } from "@/components/life-settings-sheet";
import {
  BILL_CARD_KEY,
  CLEANING_CARD_KEY,
  GARBAGE_CARD_KEY,
  REMOTE_CARD_KEY,
} from "@/lib/dashboard-sections";
import { buildDefaultLifeCardOrder } from "@/lib/life-card-order";

function render(options?: {
  open?: boolean;
  order?: string[];
  hiddenKeys?: string[];
}) {
  return renderToStaticMarkup(
    <LifeSettingsSheet
      open={options?.open ?? true}
      order={options?.order ?? buildDefaultLifeCardOrder()}
      hiddenKeys={new Set(options?.hiddenKeys ?? [])}
      remoteSummary="ボタン3件を表示中（全5件）"
      onClose={() => {}}
      onOrderChange={() => {}}
      onVisibilityChange={() => {}}
      onEditRemoteButtons={() => {}}
    />
  );
}

describe("LifeSettingsSheet", () => {
  it("閉じているときは何も出さない", () => {
    expect(render({ open: false })).toBe("");
  });

  it("暮らしのカードを並び順どおりに出す", () => {
    const html = render({
      order: [CLEANING_CARD_KEY, GARBAGE_CARD_KEY, REMOTE_CARD_KEY],
    });
    const positions = ["掃除", "ゴミの日", "電気の操作"].map((label) =>
      html.indexOf(label)
    );
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // 並びに書いていないカードも落とさず末尾へ出す
    expect(html).toContain("消費電力");
    expect(html).toContain("電気・ガス・水道料金");
  });

  it("端の項目では矢印を押せない", () => {
    // Tailwind のバリアントが class に混ざるため、`disabled=""` で照合する（#269）
    const html = render({ order: buildDefaultLifeCardOrder() });
    expect(html).toContain('aria-label="電気の操作を上へ"');
    expect(html).toMatch(/disabled=""[^>]*aria-label="電気の操作を上へ"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="3Dプリンターを下へ"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="電気の操作を下へ"/);
  });

  it("隠しているカードは目のボタンの状態と説明で分かる", () => {
    const html = render({ hiddenKeys: [BILL_CARD_KEY] });
    expect(html).toContain('aria-label="電気・ガス・水道料金をダッシュボードに表示する"');
    expect(html).toContain('aria-label="消費電力をダッシュボードから隠す"');
    expect(html).toContain("非表示。ダッシュボードには出ません");
  });

  it("「電気の操作」だけボタンの編集への入口を持つ", () => {
    const html = render();
    expect(html).toContain("ボタン3件を表示中（全5件）");
    expect(html).toContain('aria-label="電気の操作のボタンを編集"');
    expect(html.match(/aria-label="電気の操作のボタンを編集"/g)).toHaveLength(1);
  });

  it("まだ並べ替えていなくても全部のカードを出す", () => {
    const html = render({ order: [] });
    for (const label of [
      "電気の操作",
      "ゴミの日",
      "消費電力",
      "電気・ガス・水道料金",
      "掃除",
    ]) {
      expect(html).toContain(label);
    }
  });
});
