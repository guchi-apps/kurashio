import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentReadings } from "@/components/current-readings";
import { buildIndoorReadings, buildOutdoorReadings } from "@/lib/device-metrics";
import type { LatestData } from "@/lib/types";

const indoor: LatestData = {
  device_id: 1,
  datetime: "2026-08-22 20:14:00",
  temperature: 24.62,
  humidity: 58,
  pressure: 1006.3,
  co2: 612,
  illuminance: 84.24,
};

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("CurrentReadings", () => {
  it("カードから外した気圧・CO2・照度もここで読める", () => {
    const html = render(
      <CurrentReadings
        readings={buildIndoorReadings(indoor)}
        measuredAt={indoor.datetime}
      />
    );
    expect(html).toContain("24.6");
    expect(html).toContain("58");
    expect(html).toContain("1006");
    expect(html).toContain("612");
    expect(html).toContain("84.2");
    expect(html).toContain("hPa");
    expect(html).toContain("ppm");
    expect(html).toContain("lx");
  });

  it("何時時点の値かを添える", () => {
    const html = render(
      <CurrentReadings
        readings={buildIndoorReadings(indoor)}
        measuredAt={indoor.datetime}
      />
    );
    expect(html).toContain("いまの値");
    expect(html).toContain("20:14");
  });

  it("時刻が読めなければ見出しだけにする", () => {
    const html = render(
      <CurrentReadings
        readings={buildIndoorReadings(indoor)}
        measuredAt="不正な日時"
      />
    );
    expect(html).toContain("いまの値");
    expect(html).not.toContain("時点");
  });

  it("値が1つも無ければ何も出さない", () => {
    expect(render(<CurrentReadings readings={buildIndoorReadings(null)} />)).toBe("");
  });

  it("屋外はCO2・照度の枠を作らない", () => {
    const html = render(
      <CurrentReadings
        readings={buildOutdoorReadings({
          device_id: 1,
          datetime: "2026-08-22 20:14:00",
          outdoor_temperature: 29.75,
          outdoor_humidity: 64,
          outdoor_pressure: 1005.4,
        })}
      />
    );
    expect(html).toContain("29.8");
    expect(html).toContain("1005");
    expect(html).not.toContain("ppm");
    expect(html).not.toContain("lx");
  });

  it("選択機能を渡さなければタイルは押せない（屋外詳細などの従来の表示）", () => {
    const html = render(<CurrentReadings readings={buildIndoorReadings(indoor)} />);
    expect(html).not.toContain("<button");
  });

  it("選択中のタイルだけ aria-pressed が true で、押せない指標は disabled になる（#592）", () => {
    const html = render(
      <CurrentReadings
        readings={buildIndoorReadings(indoor)}
        selectedMetric="humidity"
        onSelectMetric={() => {}}
        selectableMetrics={["temperature", "humidity"]}
      />
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="湿度のグラフを表示"');
    // 温度・湿度は押せる。気圧・CO2・照度は履歴が無いので押せない
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("押せる指標を省略したときは全部押せる（履歴の取得前）", () => {
    const html = render(
      <CurrentReadings
        readings={buildIndoorReadings(indoor)}
        selectedMetric="temperature"
        onSelectMetric={() => {}}
      />
    );
    expect(html).not.toContain('disabled=""');
  });
});
