/**
 * ダッシュボードのカードをどのセクションに置くかの方針。
 *
 * カードの性質はこれから増えるほどバラバラになる（計測値・操作ボタン・予定・稼働履歴）。
 * スマホ（最大幅 480px）の2列グリッドに全部を混ぜると、行の高さも情報量も揃わず崩れるため、
 * 次の3点を方針として固定する。
 *
 * 1. カードは必ずどれかのセクションに属する。
 *    - `life`（暮らし）: ゴミの日・照明の操作・電気代など、推移グラフの凡例を持たないもの。
 *      スマホは1列で全幅、PCは2列。1行あたりの情報量がカードごとに大きく違い、
 *      スマホの幅で2列に押し込むと読めなくなるため。日ごとの集計値（電気代）もここに置く。
 *      10分間隔の時系列ではないので凡例に混ぜられない。
 *    - `sensors`（いまの環境）: センサー・屋外・エアコンなど、時系列グラフを持つ計測値。
 *      スマホ2列・PC4列。**出すのは計測値の先頭2つだけ**（`lib/device-metrics.ts`）。
 *    - `comingSoon`（近日公開）: まだ作っていない機能の案内。押しても何も起きない。
 *
 * 2. 並び順の設定（`display_order`）はグラフ凡例の並びと同じ設定なので、
 *    凡例を持たない `life` のカードは混ぜない。`life` の並び順は別の設定
 *    （`life_card_order`・`lib/life-card-order.ts`）で持ち、LIFE_CARDS の定義順は
 *    「まだ並べ替えていないときの既定」になる。表示・非表示は共通の `hidden_devices`。
 *    **どちらの入口もダッシュボードの「暮らし」の見出しにある設定アイコン**で、
 *    `/devices`（いまの環境の設定）には暮らしの設定を置かない（#283）。
 *
 * 3. 画面上の並びは「いまの環境 → 暮らし → 近日公開」。スマホもPCも同じ順で、
 *    PCは各セクションの中で列数だけが増える。**推移グラフと最近の記録はここには置かない。**
 *    掘り下げる情報なので、「いまの環境」の見出しから開く推移パネル
 *    （`components/trend-panel.tsx`）へ移した（#226）。センサーだけのアプリだった頃の
 *    「計測値を全部出す」表示のままだと、暮らしのカードが増えた今は画面を食いすぎる。
 */

export type DashboardSection = "sensors" | "life" | "comingSoon";

export const DASHBOARD_SECTION_LABELS: Record<DashboardSection, string> = {
  // 屋内センサーだけでなく屋外・エアコンも並ぶ場所なので、機器の種類ではなく
  // 「いまの状態」を表す名前にする。この定数は `/devices` の見出しにも出る
  sensors: "いまの環境",
  life: "暮らし",
  comingSoon: "近日公開",
};

/** 暮らしセクションのカード。並べ替えるまではこの順で並ぶ */
export interface LifeCardDefinition {
  /** hidden_devices・life_card_order で使うキー */
  key: string;
  label: string;
  /**
   * 設定シートの行に出す色（`globals.css` のCSS変数名）。
   * カード自身が色を持っていないもの（ゴミの日・掃除）には付けない
   */
  accentVar?: string;
}

export const GARBAGE_CARD_KEY = "garbage";
export const ENERGY_CARD_KEY = "energy";
export const REMOTE_CARD_KEY = "remote";
export const BILL_CARD_KEY = "bill";
export const CLEANING_CARD_KEY = "cleaning";
export const PRINTER_CARD_KEY = "printer";

/**
 * 「電気の操作」だけは押すためのカードで、他は読むためのカード。
 * 目的があって開いたときに最初に触れるよう先頭へ置く。
 *
 * 電気・ガス・水道料金は消費電力のすぐ後ろに置く。片方が「計測できている分」で
 * もう片方が「実際の請求」なので、離すと突き合わせられない。
 *
 * 掃除は末尾。押すためのカードだが、ゴミの日のように日付が決まっているわけではなく
 * 「そろそろやる」を思い出すためのものなので、毎日見る値より後ろでよい。
 *
 * 3Dプリンターは掃除のさらに後ろ（#436）。読むだけのカードで、印刷していない時間のほうが長く、
 * 押して何かをするカードでもないため。
 *
 * これは**並べ替えるまでの既定**で、画面から変えた順は `life_card_order` に入る（#283）。
 */
export const LIFE_CARDS: readonly LifeCardDefinition[] = [
  { key: REMOTE_CARD_KEY, label: "電気の操作", accentVar: "--remote-color" },
  { key: GARBAGE_CARD_KEY, label: "ゴミの日" },
  { key: ENERGY_CARD_KEY, label: "消費電力", accentVar: "--energy-color" },
  { key: BILL_CARD_KEY, label: "電気・ガス・水道料金", accentVar: "--bill-color" },
  { key: CLEANING_CARD_KEY, label: "掃除" },
  { key: PRINTER_CARD_KEY, label: "3Dプリンター", accentVar: "--printer-color" },
];

export function getLifeCardLabel(key: string): string {
  return LIFE_CARDS.find((card) => card.key === key)?.label ?? key;
}

/**
 * 近日公開セクションのカード。実装が済んだものはここから消し、
 * `LIFE_CARDS` か `sensors` の本物のカードに置き換える。
 */
export interface ComingSoonCardDefinition {
  key: string;
  label: string;
  /** 「何ができるようになるか」を利用者の言葉で1行 */
  description: string;
}

/** 近日公開セクション全体の表示・非表示キー（カード単位では切り替えない） */
export const COMING_SOON_SECTION_KEY = "coming-soon";

export const COMING_SOON_CARDS: readonly ComingSoonCardDefinition[] = [];
