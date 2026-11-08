import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PowerDailyChart } from "@/components/power-daily-chart";

describe("PowerDailyChart", () => {
  it("スクロール枠は左右にだけ動く（縦方向は隠して、上下の操作でグラフがずれないようにする・#864）", () => {
    const html = renderToStaticMarkup(
      <PowerDailyChart
        columns={[
          {
            date: "2026-11-01",
            kwh: 3,
            ratio: 1,
            segments: [{ source: "a", share: 1, color: "#000" }],
          } as never,
        ]}
        startNote={null}
      />,
    );
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("overflow-y-hidden");
  });
});
