import type { Metadata, Viewport } from "next";
import { Noto_Sans_JP } from "next/font/google";
import "./globals.css";
import { AppUpdateChecker } from "@/components/app-update-checker";
import { NativeWidgetPressReceiver } from "@/components/native-widget-press-receiver";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { ThemeProvider } from "@/components/theme-provider";

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "kurashio",
  description: "暮らしを、ひとつに整える。",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/kurashio-favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/kurashio-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/kurashio-apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "kurashio",
    // PWAでは上端までアプリ側で描画し、安全領域をヘッダー色で明示的に覆う。
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // ステータスバー・タイトルバーの色をヘッダーの帯（globals.css の --header-band）に揃える（#478・#483）
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f5" },
    { media: "(prefers-color-scheme: dark)", color: "#060606" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      {/*
        body もヘッダーの帯の色にする（#478）。iOS がぼかしの色付けに html と body の
        どちらを見ても灰色が混ざらないようにするため。本文の灰色は内側の div が塗る
        （global-error.tsx は globals.css の body の既定色のまま）
      */}
      <body className={`${notoSansJP.className} min-h-screen bg-header-band`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ServiceWorkerRegister />
          {/* 新しいビルドを自分で見つけて取り込む。全画面に効かせたいのでここに置く（#277） */}
          <AppUpdateChecker />
          {/* iOSアプリのウィジェットで押された電気の操作を、どの画面でも受けて送る（#546） */}
          <NativeWidgetPressReceiver />
          {/*
            iOS 26以降のPWAは、ステータスバーの下へ潜った内容を上端でぼかす（#478）。
            下の余白は本文と一緒にスクロールするので、スクロールするとカードや文字が
            潜ってモザイク状に見える。安全領域の高さぶんを動かない単色の帯で塞ぎ、
            ぼかす下地を常にヘッダー色にする（単色はぼかしても単色）。モーダルの
            暗幕（z-50）より下に置き、開いたときは帯も一緒に暗くする。
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top)] bg-header-band"
          />
          {/*
            iOS 27以降のPWAは、CSSの静的な見た目だけで上端に固定ヘッダーが実在するかを
            判定し、無いと判断すると自動でぼかしを重ねる（opacity:0・display:noneの要素は
            判定から除外される。#482 https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17）。
            上の帯（#478）は可視の単色塗りなのでこの用途には使えない（background-clip:textを
            付けると背景そのものが消えて#478の効果が壊れる）。テキストを持たないため見た目には
            何も描画されない別要素を置き、WebKitに「実在する固定ヘッダーがある」と誤認させて
            自動ぼかしの発生自体を止める。高さは記事が示す下限（10px超）に合わせた固定値。
          */}
          <div
            aria-hidden="true"
            className="ios-status-bar-blur-fix"
          />
          {/*
            iOS PWAではステータスバー直下に半透明の効果が重なるため、上端まで
            ヘッダー色で塗り、安全領域の下から画面を始める。env()が0の環境では
            従来と同じ配置になる。画面ごとの最大幅は各画面が決める。
          */}
          <div className="min-h-screen w-full bg-header-band pt-[env(safe-area-inset-top)]">
            <div className="min-h-[calc(100vh-env(safe-area-inset-top))] w-full bg-background">
              {children}
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
