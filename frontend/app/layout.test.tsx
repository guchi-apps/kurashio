import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");
const dashboard = fs.readFileSync(
  path.join(process.cwd(), "components/myroom-dashboard.tsx"),
  "utf8",
);
const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "public/manifest.json"), "utf8"),
) as { theme_color: string };

describe("iOS PWAの安全領域", () => {
  it("viewportを画面端まで広げて透過ステータスバーを使う", () => {
    expect(source).toContain('statusBarStyle: "black-translucent"');
    expect(source).toContain('viewportFit: "cover"');
  });

  it("上端をヘッダー色で覆い、コンテンツを安全領域の下へ配置する", () => {
    expect(source).toContain("bg-header-band pt-[env(safe-area-inset-top)]");
    expect(source).toContain("min-h-[calc(100vh-env(safe-area-inset-top))]");
  });

  it("スクロールしても動かない帯で安全領域を塞ぐ（#478）", () => {
    expect(source).toContain(
      "pointer-events-none fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top)] bg-header-band",
    );
  });

  it("ページの下地をヘッダー色にして、上端のぼかしに灰色を混ぜない（#478）", () => {
    expect(source).toContain("min-h-screen bg-header-band`}");
    expect(css).toMatch(/html\s*\{\s*@apply bg-header-band;/);
  });

  it("背景の描画されない最前面の要素でWebKitに固定ヘッダーの実在を認識させる（#517）", () => {
    expect(source).toContain('className="ios-status-bar-blur-fix"');
    expect(css).toMatch(/\.ios-status-bar-blur-fix\s*\{[^}]*z-index:\s*2147483647;/);
    expect(css).toMatch(
      /\.ios-status-bar-blur-fix\s*\{[^}]*\n\s*-webkit-background-clip:\s*text;/,
    );
    expect(css).toMatch(/\.ios-status-bar-blur-fix\s*\{[^}]*\n\s*background-clip:\s*text;/);
  });

  it("ダッシュボードのヘッダーは上端から始まる固定要素で、安全領域も自分で塗る（#513）", () => {
    expect(dashboard).toContain(
      "fixed inset-x-0 top-0 z-[45] border-b border-header-band-border bg-header-band pt-[env(safe-area-inset-top)]",
    );
    // 安全領域の下から始まる sticky に戻すと、iOS が固定ヘッダーと見なさずぼかしが届く
    expect(dashboard).not.toContain("sticky top-[env(safe-area-inset-top)]");
  });

  it("iOS 27のぼかし範囲を避けるため、PWA standalone時だけヘッダー内側へ追加の余白を持たせる（#521）", () => {
    expect(css).toMatch(/:root\s*\{\s*--pwa-header-safe-gap:\s*0px;\s*\}/);
    expect(css).toMatch(
      /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(display-mode: standalone\), \(display-mode: fullscreen\)\s*\{\s*:root\s*\{\s*--pwa-header-safe-gap:\s*\d+px;/,
    );
    // useElementHeight が実測している内側の div（ref="headerBarRef"）に足すこと。
    // ヘッダー自体の pt に足すと、直後の余白（headerBarHeight）が追従せず本文が隠れる
    expect(dashboard).toContain("pt-[calc(0.625rem+var(--pwa-header-safe-gap))]");
  });

  it("theme-colorとマニフェストをヘッダーの帯の色に揃える（#478）", () => {
    const light = css.match(/:root\s*\{[^}]*--header-band:\s*(#[0-9a-f]{6})/)?.[1];
    const dark = css.match(/\.dark\s*\{[^}]*--header-band:\s*(#[0-9a-f]{6})/)?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(source).toContain(`media: "(prefers-color-scheme: light)", color: "${light}"`);
    expect(source).toContain(`media: "(prefers-color-scheme: dark)", color: "${dark}"`);
    expect(manifest.theme_color).toBe(light);
  });
});
