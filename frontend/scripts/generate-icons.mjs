#!/usr/bin/env node
// kurashio のアプリアイコンとヘッダーのブランド画像を、assets/ の元画像から一括生成する（#447）。
//
// 元画像はどちらもデザイナーから受け取ったPNGで、SVGは無い。
//   assets/kurashio-app-icon.png     … 1024px・角丸の外は透明
//   assets/kurashio-brand-source.png … 横長のブランド画像（白背景・キャッチコピー入り）
//
// sharp は Next.js が連れてくる既存の依存なので、`npm ci` 済みなら追加インストールは要らない。
//
//   node scripts/generate-icons.mjs

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = join(ROOT, "assets");
const PUBLIC_DIR = join(ROOT, "public");
const APP_DIR = join(ROOT, "app");
// iOSアプリ（#526）のアイコン。Xcodeは1024pxの1枚から各サイズを作る
const IOS_ICON_DIR = join(dirname(ROOT), "ios", "Kurashio", "Assets.xcassets", "AppIcon.appiconset");

const ICON_SOURCE = join(ASSETS_DIR, "kurashio-app-icon.png");
const BRAND_SOURCE = join(ASSETS_DIR, "kurashio-brand-source.png");

// アイコンのタイル色。角丸の外（透明）をこの色で埋めると、端末側の切り抜き
// （iOSの角丸・Androidのmaskable）に任せられる全面塗りのアイコンになる。
const ICON_TILE = { r: 234, g: 251, b: 244, alpha: 1 };

// 角丸の透明を残すもの（ブラウザのタブ・Android の purpose: "any"）と、
// タイル色で埋めるもの（iOS のホーム画面・maskable）を分ける。
// 絵柄の最外（上の矢印）は中心から一辺の約0.38で、maskable の安全円（0.40）に収まる。
const ICON_OUTPUTS = [
  { path: join(PUBLIC_DIR, "kurashio-icon-512.png"), size: 512, flatten: false },
  { path: join(PUBLIC_DIR, "kurashio-icon-192.png"), size: 192, flatten: false },
  { path: join(PUBLIC_DIR, "kurashio-icon-maskable-512.png"), size: 512, flatten: true },
  { path: join(PUBLIC_DIR, "kurashio-apple-touch-icon.png"), size: 180, flatten: true },
  { path: join(PUBLIC_DIR, "kurashio-favicon.png"), size: 32, flatten: false },
  { path: join(APP_DIR, "apple-icon.png"), size: 180, flatten: true },
  { path: join(APP_DIR, "icon.png"), size: 32, flatten: false },
  // iOSアプリのアイコンは透明を持てない（角丸は端末が切り抜く）ので塗りつぶし版
  { path: join(IOS_ICON_DIR, "kurashio-app-icon-1024.png"), size: 1024, flatten: true },
];

// ブランド画像のうちヘッダーに使う範囲（元画像の画素座標）。キャッチコピーは
// ヘッダーの高さ（約36px）では潰れて読めないため、アイコンのタイルとロゴ文字だけを使う。
const BRAND_TILE = { left: 174, top: 215, width: 441, height: 433, radius: 100 };
const BRAND_WORDMARK = { left: 700, top: 318, width: 906, height: 188 };
const BRAND_GAP = 64;
// 書き出す高さ。ヘッダーでは36px前後で出すので、4倍あれば高密度の画面でも粗くならない。
const BRAND_OUTPUT_HEIGHT = 144;
// ダークテーマでロゴ文字（濃い紺）を塗り替える色。黄色の点とタイルはそのまま使う。
const BRAND_DARK_TEXT = [229, 238, 236];

await mkdir(PUBLIC_DIR, { recursive: true });
await mkdir(APP_DIR, { recursive: true });
await mkdir(IOS_ICON_DIR, { recursive: true });

for (const { path, size, flatten } of ICON_OUTPUTS) {
  let image = sharp(ICON_SOURCE).resize(size, size, { kernel: "lanczos3" });
  if (flatten) image = image.flatten({ background: ICON_TILE });
  await image.png().toFile(path);
  console.log(`Wrote ${path} (${size}x${size})`);
}

/** 角丸のタイルを切り出し、角の外を透明にする。 */
async function extractTile() {
  const { left, top, width, height, radius } = BRAND_TILE;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`,
  );
  return sharp(BRAND_SOURCE)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/**
 * 白背景のロゴ文字から白を抜く（色→透明。GIMP の Color to Alpha と同じ考え方）。
 * 輪郭のアンチエイリアスを半透明として残すので、どの背景に載せても縁が白く浮かない。
 * `darkText` を渡すと、濃い画素（ロゴ文字）だけその色へ塗り替える。
 */
async function extractWordmark(darkText) {
  const { left, top, width, height } = BRAND_WORDMARK;
  const { data, info } = await sharp(BRAND_SOURCE)
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
    const rgb = [data[i], data[i + 1], data[i + 2]];
    const alpha = Math.max(...rgb.map((c) => (255 - c) / 255));
    if (alpha < 0.02) continue;
    let color = rgb.map((c) => Math.round((c - 255 * (1 - alpha)) / alpha));
    const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    if (darkText && luminance < 110) color = darkText;
    out[o] = color[0];
    out[o + 1] = color[1];
    out[o + 2] = color[2];
    out[o + 3] = Math.round(alpha * 255);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

const tile = await extractTile();
const canvasWidth = BRAND_TILE.width + BRAND_GAP + BRAND_WORDMARK.width;
const canvasHeight = BRAND_TILE.height;
// ロゴ文字はタイルの縦中央に置く
const wordmarkTop = Math.round((canvasHeight - BRAND_WORDMARK.height) / 2);

for (const [name, darkText] of [
  ["kurashio-brand.png", null],
  ["kurashio-brand-dark.png", BRAND_DARK_TEXT],
]) {
  const wordmark = await extractWordmark(darkText);
  const composed = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: tile, left: 0, top: 0 },
      { input: wordmark, left: BRAND_TILE.width + BRAND_GAP, top: wordmarkTop },
    ])
    .png()
    .toBuffer();
  const path = join(PUBLIC_DIR, name);
  const { width } = await sharp(composed)
    .resize({ height: BRAND_OUTPUT_HEIGHT, kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toFile(path);
  console.log(`Wrote ${path} (${width}x${BRAND_OUTPUT_HEIGHT})`);
}
