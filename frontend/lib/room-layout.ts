import { getLightThreshold, resolveLightStatus, type LightStatusResult } from "@/lib/light-status";
import type { AirconData, EnergySourceRow, LatestData } from "@/lib/types";

/**
 * 部屋の3Dビュー（`/room`・#399）の間取りと、場所ごとの紐付け。
 *
 * センサー・エアコンは、どれも「部屋のどこにあるか」を持っていない
 * （持っているのは `id` と表示名だけ）。そこで**場所（ゾーン）を軸にした対応表**を
 * ここで定義し、保存は `app_settings` の `room_layout` キー1つで済ませる。
 * テーブルを増やさないので本番DBのマイグレーションは要らない。
 *
 * **どのゾーンが存在するかの正はこのファイル**（`ROOM_ZONE_DEFS`）で、
 * バックエンドは形だけを整えて素通しする。`lib/dashboard-sections.ts` の `LIFE_CARDS` と
 * `backend/ui_settings.py` の `_normalize_life_card_order()` の分担と同じ考え方で、
 * 両側に一覧を持たせるとゾーンを増やしたときに片方だけ古くなる。
 *
 * **間取りは実物の2LDK（#406）を図面から起こした寸法データ**で、glTF/GLB は使っていない。
 * 全体を約 10.2m × 4.9m（洋室・和室がそれぞれ6帖相当）とみなし、X はバルコニー側（負）から
 * 玄関側（正）へ、Z は奥の外壁（負）から手前の水回り（正）へ取る。中心は LDK と洋室の境の
 * あたり（X=0, Z=0 は間取りの中央）で、カメラはここを回る。
 * 図面を直すときに触るのはこのファイルの寸法データと `components/room-scene.tsx` の描画だけ
 * （紐付け・画面・保存の形はゾーンのキーだけに依存する）。
 */

/** 3D上の区画。床は XZ 平面で、Y が高さ（単位はメートル相当） */
export interface RoomZoneRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** 床の地の色の種類。実際の色は明暗テーマごとに `room-scene.tsx` が持つ */
export type RoomFloorTone = "floor" | "tatami" | "balcony";

export interface RoomZoneDefinition {
  /** 保存に使うキー。名前を変えても紐付けが切れないよう、日本語にはしない */
  key: string;
  /** 画面に出す名前 */
  name: string;
  rect: RoomZoneRect;
  /** 床の地の色。省略は通常の床 */
  floor?: RoomFloorTone;
  /** 床の段差（メートル）。玄関は上がり框ぶん高く、バルコニーは少し低い */
  raise?: number;
}

/**
 * 実物の2LDK。バルコニー側（左）に洋室と和室が縦に並び、中央がLDK、手前に洗面所・浴室・
 * トイレ、右奥にキッチン、右手前が廊下と玄関。
 *
 * - **旧キーは据え置く**（`ldk`・`bedroom`・`bath`・`entrance`）。仮の1LDK時代に保存した紐付けを
 *   そのまま新しい間取りへ引き継ぐため。名前だけ「リビング」→「LDK」、「洗面・浴室」→「浴室」
 * - **バルコニーもゾーンにする。** 屋外のセンサーが置いてあり、温度・湿度を紐付けられる。
 *   照明・エアコンは置かないので `ROOM_CEILING_LIGHTS` / `ROOM_AIRCON_MOUNTS` にキーが無い
 * - 押入（洋室側に開く）・和室の押入・MB は場所として扱わず、`ROOM_FURNITURE` の箱で描くだけ
 */
export const ROOM_ZONE_DEFS: readonly RoomZoneDefinition[] = [
  { key: "ldk", name: "LDK", rect: { x0: -1.0, x1: 5.1, z0: -2.45, z1: 0.85 } },
  { key: "bedroom", name: "洋室", rect: { x0: -5.1, x1: -1.0, z0: -2.45, z1: -0.05 } },
  { key: "washitsu", name: "和室", rect: { x0: -5.1, x1: -1.0, z0: -0.05, z1: 2.45 }, floor: "tatami" },
  { key: "washroom", name: "洗面所", rect: { x0: -0.3, x1: 1.33, z0: 0.85, z1: 2.45 } },
  { key: "bath", name: "浴室", rect: { x0: 1.33, x1: 3.1, z0: 0.85, z1: 2.45 } },
  { key: "toilet", name: "トイレ", rect: { x0: 3.1, x1: 4.13, z0: 0.85, z1: 2.45 } },
  { key: "entrance", name: "玄関", rect: { x0: 3.15, x1: 5.1, z0: 0.07, z1: 0.85 }, raise: 0.05 },
  {
    key: "balcony",
    name: "バルコニー",
    rect: { x0: -5.95, x1: -5.1, z0: -2.45, z1: 2.45 },
    floor: "balcony",
    raise: -0.03,
  },
];

export function getRoomZoneDef(key: string): RoomZoneDefinition | null {
  return ROOM_ZONE_DEFS.find((zone) => zone.key === key) ?? null;
}

export function roomZoneCenter(rect: RoomZoneRect): [number, number] {
  return [(rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2];
}

/* ────────── 間取りの寸法（図面を直すときに置き換わる部分） ────────── */

/** 面の質感。実際の色は明暗テーマごとに `room-scene.tsx` が持つ */
export type RoomSurfaceTone =
  | "wall"
  | "partition"
  | "wood"
  | "woodDark"
  | "metal"
  | "screen"
  | "glass";

export interface RoomBoxPart {
  size: [number, number, number];
  position: [number, number, number];
  tone: RoomSurfaceTone;
  /** 省略は箱。円柱は `size[0]` を直径、`size[1]` を高さとして描く */
  shape?: "box" | "cylinder";
}

export interface RoomWallDefinition {
  /** 壁が伸びる向き。"x" は X 方向へ走る（＝Z が一定）壁 */
  runs: "x" | "z";
  /** 走らないほうの座標 */
  at: number;
  from: number;
  to: number;
  height: number;
  thickness: number;
  tone: RoomSurfaceTone;
  /** 開口（ドア・窓）。`[中心, 幅]`。並び順は問わない（`buildRoomWallParts()` が並べ直す） */
  gaps?: [number, number][];
}

/**
 * 壁。カメラはバルコニー側の手前から見下ろすので、奥（Z が負）と右（X が正）の外壁だけ
 * 天井まで立て、手前と左は腰までの高さに切って中を見せる。間仕切りも腰の高さ
 * （上から覗き込む視点で中が見えなくなるため）。
 */
const ROOM_WALLS: readonly RoomWallDefinition[] = [
  // 奥の外壁（LDKの窓を開ける）と右の外壁（玄関ドア）
  { runs: "x", at: -2.45, from: -5.1, to: 5.1, height: 2.1, thickness: 0.12, tone: "wall", gaps: [[1.5, 1.8]] },
  { runs: "z", at: 5.1, from: -2.45, to: 0.85, height: 2.1, thickness: 0.12, tone: "wall", gaps: [[0.46, 0.72]] },
  // バルコニー側。エアコンを掛ける角だけ高く、あとは窓（低い壁＋ガラス）
  { runs: "z", at: -5.1, from: -2.45, to: -1.45, height: 2.1, thickness: 0.12, tone: "wall" },
  {
    runs: "z",
    at: -5.1,
    from: -1.45,
    to: 2.45,
    height: 1.35,
    thickness: 0.12,
    tone: "wall",
    gaps: [
      [-0.775, 1.35],
      [1.2, 2.2],
    ],
  },
  // 手前の外壁とトイレの右（MB側）
  { runs: "x", at: 2.45, from: -5.1, to: 4.13, height: 1.35, thickness: 0.12, tone: "wall" },
  { runs: "z", at: 4.13, from: 0.85, to: 2.45, height: 1.35, thickness: 0.12, tone: "wall" },
  // 間仕切り。洋室・和室とLDKの間は引き戸、LDKと水回りの間は洗面所・トイレのドア
  {
    runs: "z",
    at: -1.0,
    from: -1.6,
    to: 0.85,
    height: 1.35,
    thickness: 0.1,
    tone: "partition",
    gaps: [
      [-0.85, 1.3],
      [0.42, 0.76],
    ],
  },
  { runs: "x", at: -0.05, from: -5.1, to: -1.0, height: 1.35, thickness: 0.1, tone: "partition" },
  {
    runs: "x",
    at: 0.85,
    from: -0.3,
    to: 5.1,
    height: 1.35,
    thickness: 0.1,
    tone: "partition",
    gaps: [
      [0.9, 0.8],
      [3.58, 0.6],
    ],
  },
  { runs: "z", at: 1.33, from: 0.85, to: 2.45, height: 1.35, thickness: 0.1, tone: "partition", gaps: [[1.32, 0.75]] },
  { runs: "z", at: 3.1, from: 0.85, to: 2.45, height: 1.35, thickness: 0.1, tone: "partition" },
  // 廊下・玄関とLDK（キッチン）の間。右端まで壁で仕切る
  { runs: "x", at: 0.07, from: 3.15, to: 5.1, height: 1.35, thickness: 0.1, tone: "partition" },
  // バルコニーの手すりと袖壁
  { runs: "z", at: -5.95, from: -2.45, to: 2.45, height: 1.1, thickness: 0.06, tone: "glass" },
  { runs: "x", at: -2.45, from: -5.95, to: -5.1, height: 1.1, thickness: 0.1, tone: "wall" },
  { runs: "x", at: 2.45, from: -5.95, to: -5.1, height: 1.1, thickness: 0.1, tone: "wall" },
];

/**
 * 開口で分割した壁を、そのまま置ける箱の一覧にする。
 *
 * 開口の始点・終点は `from`→`to` の昇順に並べ直してから2つずつ取る。並び順に頼ると、
 * 図面から起こした順のまま書いた開口が**黙って塞がり、別の場所に穴が空く**（#406の計画レビュー）。
 */
export function buildRoomWallParts(walls: readonly RoomWallDefinition[] = ROOM_WALLS): RoomBoxPart[] {
  const parts: RoomBoxPart[] = [];
  for (const wall of walls) {
    const cuts: number[] = [wall.from];
    for (const [center, width] of wall.gaps ?? []) {
      cuts.push(center - width / 2, center + width / 2);
    }
    cuts.push(wall.to);
    cuts.sort((a, b) => a - b);

    for (let i = 0; i + 1 < cuts.length; i += 2) {
      const start = cuts[i];
      const end = cuts[i + 1];
      const length = end - start;
      if (length <= 0.02) continue;
      const middle = (start + end) / 2;
      parts.push({
        size:
          wall.runs === "x"
            ? [length, wall.height, wall.thickness]
            : [wall.thickness, wall.height, length],
        position:
          wall.runs === "x"
            ? [middle, wall.height / 2, wall.at]
            : [wall.at, wall.height / 2, middle],
        tone: wall.tone,
      });
    }
  }
  return parts;
}

export const ROOM_WALL_PARTS: readonly RoomBoxPart[] = buildRoomWallParts();

/**
 * 置き家具と造作。どの部屋の何かが分かる程度の箱で、形そのものに意味は持たせていない。
 * 位置は間取り図の書き込み（#406）に合わせてある。
 */
export const ROOM_FURNITURE: readonly RoomBoxPart[] = [
  // 窓ガラス（奥の外壁のLDKの窓、バルコニー側の洋室・和室の窓）
  { size: [1.8, 1.9, 0.04], position: [1.5, 1.05, -2.45], tone: "glass" },
  { size: [0.04, 1.3, 1.35], position: [-5.1, 0.67, -0.775], tone: "glass" },
  { size: [0.04, 1.3, 2.2], position: [-5.1, 0.67, 1.2], tone: "glass" },
  // 押入（洋室側に開く。LDK側は壁）・和室の押入
  { size: [1.0, 1.35, 0.85], position: [-0.5, 0.675, -2.025], tone: "partition" },
  { size: [0.7, 1.35, 1.6], position: [-0.65, 0.675, 1.65], tone: "partition" },
  // 洋室: デスクとモニター・窓側のエアコンの下にPC・棚・ベッド・小物入れ
  { size: [1.33, 0.72, 0.5], position: [-4.15, 0.36, -2.13], tone: "wood" },
  { size: [0.55, 0.36, 0.04], position: [-4.15, 0.95, -2.3], tone: "screen" },
  { size: [0.22, 0.45, 0.45], position: [-4.88, 0.225, -1.9], tone: "screen" },
  { size: [0.5, 1.0, 0.32], position: [-3.0, 0.5, -2.18], tone: "woodDark" },
  { size: [2.14, 0.35, 1.0], position: [-2.34, 0.175, -0.73], tone: "wood" },
  { size: [2.0, 0.16, 0.9], position: [-2.34, 0.43, -0.73], tone: "wall" },
  { size: [0.62, 0.6, 0.36], position: [-4.63, 0.3, -0.41], tone: "woodDark" },
  { size: [0.5, 0.6, 0.3], position: [-3.88, 0.3, -0.4], tone: "woodDark" },
  // LDK: テレビ・食器棚とその前のゴミ箱・机・冷蔵庫・キッチン・お掃除ロボット
  { size: [1.2, 0.42, 0.43], position: [0.86, 0.21, -2.07], tone: "woodDark" },
  { size: [1.05, 0.6, 0.05], position: [0.86, 0.75, -2.2], tone: "screen" },
  { size: [1.1, 1.5, 0.3], position: [3.38, 0.75, -2.2], tone: "wood" },
  { size: [0.3, 0.6, 0.3], position: [3.38, 0.3, -1.82], tone: "metal", shape: "cylinder" },
  { size: [0.85, 0.7, 0.74], position: [0.72, 0.35, -0.57], tone: "wood" },
  { size: [0.52, 1.7, 0.48], position: [3.38, 0.85, -0.31], tone: "metal" },
  { size: [0.7, 0.85, 2.28], position: [4.7, 0.425, -1.26], tone: "metal" },
  { size: [0.34, 0.09, 0.34], position: [1.85, 0.045, 0.62], tone: "screen", shape: "cylinder" },
  // 洗面所: 洗濯機と乾燥機の2段・洗面台
  { size: [0.55, 0.9, 0.6], position: [0.15, 0.45, 2.1], tone: "metal" },
  { size: [0.55, 0.75, 0.6], position: [0.15, 1.275, 2.1], tone: "wall" },
  { size: [0.62, 0.8, 0.78], position: [0.17, 0.4, 1.3], tone: "wall" },
  // 浴室・トイレ
  { size: [1.6, 0.55, 0.65], position: [2.21, 0.275, 2.08], tone: "metal" },
  { size: [0.4, 0.4, 0.62], position: [3.58, 0.2, 1.85], tone: "wall" },
  { size: [0.42, 0.4, 0.2], position: [3.58, 0.6, 2.2], tone: "wall" },
];

export interface RoomAirconMount {
  position: [number, number, number];
  /**
   * 本体の向き（Y軸まわりの回転・ラジアン）。0 で吹き出し口が +Z（手前）を向く。
   * 本体・風・ピンをこの回転の中に入れるので、壁の向きに関係なく風が部屋の中へ流れる
   */
  rotationY: number;
}

/**
 * エアコン本体の位置。ゾーンごとに1台までを前提にしている。
 *
 * 実物は洋室の1台だけ（バルコニー側の壁）だが、**LDK の位置も残す**。仮の1LDK時代に設定を
 * 保存した人には `ldk` に `ac_id` が残っており、位置を消すと一覧には「冷房 26℃」と出るのに
 * 3Dには本体もピンも出なくなる（#406の計画レビュー）。付け替えは設定シートから行う。
 */
export const ROOM_AIRCON_MOUNTS: Readonly<Record<string, RoomAirconMount>> = {
  bedroom: { position: [-4.97, 1.62, -1.92], rotationY: Math.PI / 2 },
  ldk: { position: [-0.45, 1.62, -2.34], rotationY: 0 },
};

/** シーリングライトの位置。センサーを紐付けたゾーンだけ点灯・消灯を描く。バルコニーには無い */
export const ROOM_CEILING_LIGHTS: Readonly<Record<string, [number, number, number]>> = {
  ldk: [1.6, 1.98, -0.8],
  bedroom: [-3.05, 1.98, -1.25],
  washitsu: [-3.05, 1.98, 1.2],
  washroom: [0.5, 1.9, 1.65],
  bath: [2.2, 1.9, 1.65],
  toilet: [3.6, 1.9, 1.65],
  entrance: [4.4, 1.9, 0.46],
};

/* ────────── 保存する紐付け ────────── */

/**
 * ゾーン1つぶんの紐付け。**寸法はここに入れない**——寸法は上の定義が正で、
 * 保存するのは「その場所が何と結び付いているか」だけ。
 */
export interface RoomZoneBinding {
  key: string;
  /** 室温・湿度・照明を読むセンサーの device_id。null = センサーなし */
  device_id: number | null;
  /** その場所にあるエアコンの ac_id。null = 無し */
  ac_id: number | null;
  /** その場所にあるTapoスマートプラグの `source`（`GET /api/energy/breakdown` の `sources[].source`） */
  tapo_sources: string[];
}

export interface RoomLayout {
  zones: RoomZoneBinding[];
}

/**
 * 初期の紐付け。`display_order` の既定（`["device:1", "device:2", …]`）と同じく、
 * このアプリの標準構成（LDK=1・洋室=2）を置いている。エアコンは実物どおり洋室（#406）。
 * バルコニーの屋外センサーはどの device_id かを決め打ちできないので、設定シートで選ぶ。
 */
export const DEFAULT_ROOM_BINDINGS: Readonly<Record<string, Omit<RoomZoneBinding, "key">>> = {
  ldk: { device_id: 1, ac_id: null, tapo_sources: [] },
  bedroom: { device_id: 2, ac_id: 1, tapo_sources: [] },
};

/** 紐付けの無い状態。配列を共有しないよう、使うたびに新しく作る */
function emptyRoomBinding(): Omit<RoomZoneBinding, "key"> {
  return { device_id: null, ac_id: null, tapo_sources: [] };
}

export function buildDefaultRoomLayout(): RoomLayout {
  return {
    zones: ROOM_ZONE_DEFS.map((zone) => ({
      key: zone.key,
      ...emptyRoomBinding(),
      ...(DEFAULT_ROOM_BINDINGS[zone.key] ?? {}),
      tapo_sources: [...(DEFAULT_ROOM_BINDINGS[zone.key]?.tapo_sources ?? [])],
    })),
  };
}

function toNullableId(raw: unknown): number | null {
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** 重複の無い文字列配列へ整える。Tapoの `source` で使う */
function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * 保存値を画面で使える形へ整える。
 *
 * **知らないキーを落とし、足りないキーを既定で補うのはこちら側の仕事**
 * （`lib/life-card-order.ts` と同じ分担）。間取りを変えてゾーンを増減しても、
 * 「保存済みの人にだけ出ない／消えたゾーンの設定が残り続ける」が起きない。
 *
 * 保存が一度も無い（`zones` が空）ときだけ既定の紐付けへ倒す。1つでも保存されていれば、
 * 全部の紐付けを外した状態もそのまま尊重する（外したのに既定へ戻ると設定できない）。
 */
export function normalizeRoomLayout(raw: unknown): RoomLayout {
  const rawZones =
    raw && typeof raw === "object" && Array.isArray((raw as { zones?: unknown }).zones)
      ? ((raw as { zones: unknown[] }).zones)
      : [];

  const saved = new Map<string, RoomZoneBinding>();
  for (const entry of rawZones) {
    if (!entry || typeof entry !== "object") continue;
    const key = String((entry as { key?: unknown }).key ?? "").trim();
    if (!key || saved.has(key) || !getRoomZoneDef(key)) continue;
    saved.set(key, {
      key,
      device_id: toNullableId((entry as { device_id?: unknown }).device_id),
      ac_id: toNullableId((entry as { ac_id?: unknown }).ac_id),
      tapo_sources: toStringList((entry as { tapo_sources?: unknown }).tapo_sources),
    });
  }

  if (saved.size === 0) return buildDefaultRoomLayout();

  return {
    zones: ROOM_ZONE_DEFS.map((zone) => saved.get(zone.key) ?? { key: zone.key, ...emptyRoomBinding() }),
  };
}

export function getRoomZoneBinding(layout: RoomLayout, key: string): RoomZoneBinding {
  return layout.zones.find((zone) => zone.key === key) ?? { key, ...emptyRoomBinding() };
}

/** 1つのゾーンの紐付けだけを差し替えた新しい設定を返す（保存は呼び出し側） */
export function setRoomZoneBinding(
  layout: RoomLayout,
  key: string,
  patch: Partial<Omit<RoomZoneBinding, "key">>
): RoomLayout {
  const normalized = normalizeRoomLayout(layout);
  return {
    zones: normalized.zones.map((zone) =>
      zone.key === key ? { ...zone, ...patch, key } : zone
    ),
  };
}

/* ────────── 表示に使う色 ────────── */

const TEMPERATURE_RAMP: readonly [number, [number, number, number]][] = [
  [18, [74, 144, 217]],
  [22, [95, 191, 168]],
  [25, [232, 195, 90]],
  [28, [224, 138, 74]],
  [31, [217, 85, 63]],
];

/**
 * 室温 -> 床に敷く色。**数字を読まずに暑い部屋・寒い部屋が分かる**ことが
 * 3Dにする一番の理由なので、凡例（18〜31℃）と同じ並びをここで持つ。
 */
export function roomTemperatureColor(temperature: number): string {
  const clamped = Math.min(
    TEMPERATURE_RAMP[TEMPERATURE_RAMP.length - 1][0],
    Math.max(TEMPERATURE_RAMP[0][0], temperature)
  );
  let rgb = TEMPERATURE_RAMP[0][1];
  for (let i = 1; i < TEMPERATURE_RAMP.length; i += 1) {
    const [lowStop, lowColor] = TEMPERATURE_RAMP[i - 1];
    const [highStop, highColor] = TEMPERATURE_RAMP[i];
    if (clamped <= highStop) {
      const k = (clamped - lowStop) / (highStop - lowStop);
      rgb = [0, 1, 2].map((j) =>
        Math.round(lowColor[j] + (highColor[j] - lowColor[j]) * k)
      ) as [number, number, number];
      break;
    }
    rgb = highColor;
  }
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export const ROOM_TEMPERATURE_RAMP_MIN = TEMPERATURE_RAMP[0][0];
export const ROOM_TEMPERATURE_RAMP_MAX = TEMPERATURE_RAMP[TEMPERATURE_RAMP.length - 1][0];

/** 動作中の家電を表すピンの色。`app/globals.css` の `--bill-color` と同じ値 */
export const ROOM_APPLIANCE_ACTIVE_COLOR = "#2f9e8f";
/** 待機中の家電を表すピンの色。エアコン停止中・消灯と同じ、状態を表す共通のグレー */
export const ROOM_APPLIANCE_IDLE_COLOR = "#93999f";

/**
 * Tapoスマートプラグを「動作中」と見なす消費電力（W）のしきい値（#410）。
 *
 * 機器ごとの個別設定はまだ無く、固定値だけで判定する（待機電力が大きい機器で誤判定が
 * 出るようなら別途調整する）。
 */
export const ROOM_APPLIANCE_ACTIVE_THRESHOLD_W = 3;

/**
 * `power_w` の値をどれだけ新しいとみなすか（ミリ秒）。
 *
 * スマートプラグが応答しなくなると収集スクリプトはその機器ぶんを送信せず
 * （`collectors/tapo_to_myroom.py` の `read_device()`）、`daily_energy` は上書き方式のため
 * **最後に受け取った値がその日の残り時間ずっと残る**。値の大きさだけで判定すると、
 * プラグやサブPCが落ちた瞬間の「動作中」が消えなくなる。収集は5分ごとなので、3回ぶん
 * （15分）応答が無ければ「いまは分からない」として動作中の判定から外す。
 */
export const ROOM_APPLIANCE_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Tapoの消費電力（W）がしきい値を超え、かつ値が新しければ「動作中」とみなす。
 * 値が古い・無いときは「動作中ではない」に倒す（誤って動作中と言い切るほうが実害が大きいため）。
 */
export function isApplianceActive(
  powerW: number | null,
  updatedAt: string | null,
  now: Date
): boolean {
  if (powerW == null || powerW < ROOM_APPLIANCE_ACTIVE_THRESHOLD_W) return false;
  if (!updatedAt) return false;
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return false;
  return now.getTime() - updatedMs <= ROOM_APPLIANCE_FRESHNESS_MS;
}

/* ────────── 重ねる情報のレイヤ ────────── */

export type RoomLayerKey = "temperature" | "aircon" | "light" | "appliance";

export interface RoomLayerDefinition {
  key: RoomLayerKey;
  label: string;
  /** チップの色見本に使う CSS 変数（`app/globals.css`） */
  colorVar: string;
}

export const ROOM_LAYERS: readonly RoomLayerDefinition[] = [
  { key: "temperature", label: "温度", colorVar: "--temp-color" },
  { key: "aircon", label: "エアコン", colorVar: "--temp-color" },
  { key: "light", label: "照明", colorVar: "--remote-color" },
  { key: "appliance", label: "家電", colorVar: "--bill-color" },
];

export type RoomLayerState = Record<RoomLayerKey, boolean>;

/**
 * 初期状態。4種類すべてを重ねるとピンが混み合うため、狭い画面では温度とエアコンだけで開く。
 * 出す・出さないはチップからいつでも変えられる。
 */
export function buildDefaultRoomLayers(compact: boolean): RoomLayerState {
  return {
    temperature: true,
    aircon: true,
    light: !compact,
    appliance: !compact,
  };
}

/* ────────── 画面に出す形へまとめる ────────── */

/**
 * この場所に紐付けたTapoスマートプラグ1台ぶん。
 *
 * 照明・エアコンと同じく、動作中のものだけでなく**紐付けた全台**を返す。動作中だけを
 * 返すと「待機中」と「紐付けていない・記録がまだ無い」が画面上で区別できないため（#410）
 */
export interface ResolvedRoomAppliance {
  source: string;
  label: string;
  active: boolean;
  powerW: number | null;
}

export interface ResolvedRoomZone {
  key: string;
  name: string;
  rect: RoomZoneRect;
  center: [number, number];
  floor: RoomFloorTone;
  raise: number;
  deviceId: number | null;
  temperature: number | null;
  humidity: number | null;
  /** 照度としきい値から出した点灯・消灯。しきい値未設定なら null */
  light: LightStatusResult | null;
  acId: number | null;
  aircon: AirconData | null;
  /** この場所に紐付けたTapoスマートプラグ */
  appliances: ResolvedRoomAppliance[];
}

export interface RoomZoneSources {
  layout: RoomLayout;
  latestByDevice: Record<number, LatestData | null>;
  lightThresholds: Record<string, number>;
  airconByAcId: Record<number, AirconData | null>;
  /** `GET /api/energy/breakdown` の `sources`。Tapoスマートプラグの動作判定に使う */
  energySources: readonly EnergySourceRow[];
  /** 動作中判定の鮮度チェックの基準時刻。省略時は呼び出し時点（テストでは固定値を渡す） */
  now?: Date;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/**
 * 間取りと各APIの最新値を突き合わせて、ゾーンごとの表示内容を作る。
 *
 * 判定そのもの（照明の点灯）は既存の実装をそのまま使う。ここは
 * 「どの場所の値か」を決めるだけで、同じ判定をもう一度書かないこと。
 */
export function resolveRoomZones(sources: RoomZoneSources): ResolvedRoomZone[] {
  const layout = normalizeRoomLayout(sources.layout);
  const energyBySource = new Map(sources.energySources.map((row) => [row.source, row]));
  const now = sources.now ?? new Date();

  return ROOM_ZONE_DEFS.map((def) => {
    const binding = getRoomZoneBinding(layout, def.key);
    const latest = binding.device_id != null ? sources.latestByDevice[binding.device_id] : null;
    const aircon = binding.ac_id != null ? sources.airconByAcId[binding.ac_id] ?? null : null;
    const appliances: ResolvedRoomAppliance[] = binding.tapo_sources.map((source) => {
      const row = energyBySource.get(source);
      return {
        source,
        label: row?.label ?? source,
        active: row != null && isApplianceActive(row.power_w, row.power_updated_at, now),
        powerW: row?.power_w ?? null,
      };
    });

    return {
      key: def.key,
      name: def.name,
      rect: def.rect,
      center: roomZoneCenter(def.rect),
      floor: def.floor ?? "floor",
      raise: def.raise ?? 0,
      deviceId: binding.device_id,
      temperature: finiteOrNull(latest?.temperature),
      humidity: finiteOrNull(latest?.humidity),
      light:
        binding.device_id != null
          ? resolveLightStatus(
              latest?.illuminance,
              getLightThreshold(sources.lightThresholds, binding.device_id)
            )
          : null,
      acId: binding.ac_id,
      aircon,
      appliances,
    };
  });
}
