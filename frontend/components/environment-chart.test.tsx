import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentChart } from "@/components/environment-chart";
import {
  buildDefaultChartLineVisibility,
  outdoorMetricVisibilityKey,
  deviceMetricVisibilityKey,
} from "@/lib/chart-line-visibility";
import {
  normalizeDisplayOrder,
  outdoorOrderKey,
  type OutdoorOrderContext,
} from "@/lib/display-order";
import {
  applyHiddenDevicesToLineVisibility,
  filterDisplayOrderByVisibility,
  getVisibleChartDeviceIds,
  AIRCON_ROOM_HIDDEN_KEY,
} from "@/lib/visible-devices";
import { AIRCON_CHART_DEVICE_ID, type HistoryPoint } from "@/lib/types";
import type { LightSegment } from "@/lib/light-history";

const noop = () => {};

const SENSOR_DEVICE_IDS = [1, 2];
const DEVICE_NAMES = {
  1: "リビング",
  2: "寝室",
  [AIRCON_CHART_DEVICE_ID]: "エアコン",
};

/** 屋外の地点を2つ登録している状態（基準は高槻市） */
const TWO_LOCATIONS: OutdoorOrderContext = {
  locationIds: ["taka", "settsu"],
  primaryId: "taka",
};

function buildHistory(): HistoryPoint[] {
  const base = new Date("2026-09-03T20:00:00").getTime();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      datetime: new Date(base + i * 5 * 60 * 1000).toISOString(),
      datetimeObj: base + i * 5 * 60 * 1000,
      outdoor_temperature: 23.5,
      d1_temperature: 33.6,
      d2_temperature: 27.9,
      d9001_temperature: 25.5,
      d9001_target_temperature: 26,
      d9001_power: "ON",
    });
  }
  return rows as unknown as HistoryPoint[];
}

/** 凡例の行名。表示切替ボタンの `aria-label` から拾う */
function legendNames(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)の表示切替"/g)].map((match) => match[1]);
}

function render(
  hiddenKeys: Set<string> = new Set(),
  lineOverrides: Record<string, boolean> = {}
) {
  const legendOrder = filterDisplayOrderByVisibility(
    normalizeDisplayOrder(null, SENSOR_DEVICE_IDS, TWO_LOCATIONS),
    hiddenKeys
  );
  // 屋外の線は既定で非表示のため、凡例の並びを見るテストでは表示に上書きする（#638）
  const lineVisibility = {
    ...applyHiddenDevicesToLineVisibility(
      buildDefaultChartLineVisibility(SENSOR_DEVICE_IDS),
      hiddenKeys,
      SENSOR_DEVICE_IDS,
      outdoorOrderKey(TWO_LOCATIONS.primaryId)
    ),
    [outdoorMetricVisibilityKey("temperature")]: true,
    ...lineOverrides,
  };

  return renderToStaticMarkup(
    <EnvironmentChart
      historyData={buildHistory()}
      deviceIds={getVisibleChartDeviceIds(SENSOR_DEVICE_IDS, hiddenKeys)}
      deviceNames={DEVICE_NAMES}
      chartMetric="temperature"
      onChartMetricChange={noop}
      viewRange="day"
      onViewRangeChange={noop}
      loading={false}
      onVisibleDomainChange={noop}
      airconTargetDeviceId={AIRCON_CHART_DEVICE_ID}
      outdoorLocationName="高槻市"
      outdoorPrimaryLocationId={TWO_LOCATIONS.primaryId}
      legendOrder={legendOrder}
      chartColors={{}}
      lineVisibility={lineVisibility}
      onLineVisibilityChange={noop}
    />
  );
}

describe("EnvironmentChart の凡例", () => {
  it("屋外の地点を複数登録しても屋外の行は基準地点の1行だけ（#358）", () => {
    const names = legendNames(render());
    expect(names.filter((name) => name === "高槻市")).toHaveLength(1);
  });

  it("室温・設定温度・DHT11以外の行を落とさない", () => {
    const names = legendNames(render());
    expect(names).toContain("リビング");
    expect(names).toContain("寝室");
    expect(names).toContain("エアコン");
    expect(names).toContain("エアコン（設定温度）");
  });

  it("エアコンの室温だけ非表示にしても設定温度の行は残る（線だけ描かれるのを防ぐ。#358）", () => {
    const names = legendNames(render(new Set([AIRCON_ROOM_HIDDEN_KEY])));
    expect(names).not.toContain("エアコン");
    expect(names).toContain("エアコン（設定温度）");
  });

  it("非表示にした行は初期状態の凡例に出さず、件数つきのリンクだけを出す（#638）", () => {
    const html = render(new Set(), {
      [deviceMetricVisibilityKey(2, "temperature")]: false,
    });
    expect(legendNames(html)).not.toContain("寝室");
    expect(html).toContain("非表示の項目を表示（1）");
  });

  it("全行を非表示にしてもリンクは残り、戻せる（#638）", () => {
    const html = render(new Set(), {
      [deviceMetricVisibilityKey(1, "temperature")]: false,
      [deviceMetricVisibilityKey(2, "temperature")]: false,
      [deviceMetricVisibilityKey(AIRCON_CHART_DEVICE_ID, "temperature")]: false,
      [outdoorMetricVisibilityKey("temperature")]: false,
      airconTarget: false,
    });
    expect(legendNames(html)).toHaveLength(0);
    expect(html).toContain("非表示の項目を表示（");
  });

  it("非表示の行が無ければリンクを出さない（#638）", () => {
    expect(render()).not.toContain("非表示の項目を表示");
  });
});

/** 照明の帯だけを見るための描画。区間は `buildHistory()` が作る範囲の中に置く */
function renderBand(segments: LightSegment[]) {
  return renderToStaticMarkup(
    <EnvironmentChart
      historyData={buildHistory()}
      deviceIds={SENSOR_DEVICE_IDS}
      deviceNames={DEVICE_NAMES}
      chartMetric="illuminance"
      onChartMetricChange={noop}
      viewRange="day"
      onViewRangeChange={noop}
      loading={false}
      onVisibleDomainChange={noop}
      chartColors={{}}
      lineVisibility={buildDefaultChartLineVisibility(SENSOR_DEVICE_IDS)}
      onLineVisibilityChange={noop}
      lightSegments={segments}
      lightSourceLabel="照度から判定"
    />
  );
}

function segment(start: string, end: string, daylight: boolean): LightSegment {
  return { start, end, open_start: false, open_end: false, daylight };
}

describe("EnvironmentChart の照明の帯（#371）", () => {
  it("日中に収まる区間だけを縞で塗り、凡例を添える", () => {
    const html = renderBand([
      segment("2026-09-03T12:00:00", "2026-09-03T13:00:00", true),
      segment("2026-09-03T20:10:00", "2026-09-03T20:30:00", false),
    ]);
    expect(html).toContain("repeating-linear-gradient");
    expect(html).toContain("縞の区間は日射の可能性があります");
  });

  it("日中に収まる区間が無ければ縞も凡例も出さない", () => {
    const html = renderBand([segment("2026-09-03T20:10:00", "2026-09-03T20:30:00", false)]);
    expect(html).not.toContain("repeating-linear-gradient");
    expect(html).not.toContain("縞の区間は日射の可能性があります");
  });

  it("「日中」を時間軸の固定位置で塗らない（domain は日付境界に整列しない）", () => {
    const html = renderBand([segment("2026-09-03T12:00:00", "2026-09-03T13:00:00", true)]);
    expect(html).not.toContain("left:25%;width:50%");
  });
});
