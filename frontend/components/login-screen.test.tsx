import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginScreen } from "@/components/login-screen";

describe("LoginScreen", () => {
  it("アプリアイコンとGoogleログインのボタンを出す", () => {
    const html = renderToStaticMarkup(<LoginScreen />);
    expect(html).toContain('alt="kurashio"');
    expect(html).toContain("Googleでログイン");
  });

  it("読み込み中のプログレスバーは出さない", () => {
    const html = renderToStaticMarkup(<LoginScreen />);
    expect(html).not.toContain('role="progressbar"');
  });

  it("読み込み画面とアイコン・アプリ名の位置を揃える", () => {
    const html = renderToStaticMarkup(<LoginScreen />);
    // 切り替わったときに要素が飛び跳ねないよう、下段のブロックの高さを固定している
    expect(html).toContain("min-h-[96px]");
  });

  describe("戻ってきたときのエラー表示", () => {
    afterEach(() => vi.unstubAllGlobals());

    const renderWithSearch = (search: string) => {
      vi.stubGlobal("window", { location: { search } });
      return renderToStaticMarkup(<LoginScreen />);
    };

    it("許可されていないアカウントなら、その旨を出す", () => {
      expect(renderWithSearch("?authError=forbidden")).toContain(
        "このGoogleアカウントではログインできません"
      );
    });

    it("iOSアプリの認証シートから戻れなかったら、失敗を出す（#526）", () => {
      expect(renderWithSearch("?authError=failed")).toContain("Googleログインに失敗しました");
    });

    it("認証サーバーへ届かなかったら、アカウントのせいにしない（#724）", () => {
      const html = renderWithSearch("?authError=unavailable");
      expect(html).toContain("認証サーバーに接続できませんでした");
      expect(html).not.toContain("このGoogleアカウントではログインできません");
    });
  });
});
