import path from "path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * 早期 return の後ろでフックを呼ぶと、描画ごとにフックの数が変わって React #310 で
 * 画面ごと落ちる（#559。ダッシュボードの認証ゲートの後ろに `useMemo` を置いていた）。
 * CI は `npm run lint` を回しておらず、既存の lint エラーに紛れて気付けないため、
 * `react-hooks/rules-of-hooks` だけをここで確かめる。
 */
describe("react-hooks/rules-of-hooks", () => {
  it("フックを条件付き・早期 return の後ろで呼んでいない", async () => {
    const eslint = new ESLint({
      cwd: path.resolve(__dirname, ".."),
      overrideConfig: {
        rules: { "react-hooks/rules-of-hooks": "error" },
      },
    });
    const results = await eslint.lintFiles(["app", "components", "lib"]);
    const violations = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "react-hooks/rules-of-hooks")
        .map(
          (message) =>
            `${path.relative(process.cwd(), result.filePath)}:${message.line} ${message.message}`
        )
    );
    expect(violations).toEqual([]);
  }, 120_000);
});
