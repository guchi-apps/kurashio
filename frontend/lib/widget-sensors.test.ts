import { describe, expect, it } from "vitest";
import type { DisplayOrderItem } from "@/lib/display-order";
import type { LatestData } from "@/lib/types";
import { buildWidgetSensors, pickDefaultWidgetSensor } from "@/lib/widget-sensors";

const names: Record<number, string> = { 1: "リビング(旧)", 2: "寝室", 3: "リビング", 4: "屋外" };

function build(
  order: DisplayOrderItem[],
  latest: Record<number, LatestData | null>,
  stale: number[] = []
) {
  return buildWidgetSensors(
    order,
    latest,
    (id) => names[id] ?? `デバイス ${id}`,
    (id) => stale.includes(id)
  );
}

describe("buildWidgetSensors", () => {
  it("表示中のセンサーのカードだけを並び順どおりに並べる", () => {
    const sensors = build(
      [
        { type: "device", deviceId: 3 },
        { type: "outdoor", locationId: "home" },
        { type: "aircon" },
        { type: "device", deviceId: 2 },
      ],
      { 2: { temperature: 26.6, humidity: 61 }, 3: { temperature: 28.5, humidity: 64, co2: 1500 } },
      [2]
    );
    expect(sensors).toEqual([
      { id: 3, name: "リビング", temperature: 28.5, humidity: 64, co2: 1500, co2Level: "high", stale: false, measuredAt: null },
      { id: 2, name: "寝室", temperature: 26.6, humidity: 61, co2: null, co2Level: null, stale: true, measuredAt: null },
    ]);
  });

  it("値の時刻（datetime）をそのまま measuredAt に渡す（#677）", () => {
    const [sensor] = build(
      [{ type: "device", deviceId: 3 }],
      { 3: { temperature: 25, datetime: "2026-10-02T12:34:56" } }
    );
    expect(sensor.measuredAt).toBe("2026-10-02T12:34:56");
  });

  it("値が届いていないセンサーも選択肢には残す（値は null）", () => {
    expect(build([{ type: "device", deviceId: 4 }], {})).toEqual([
      { id: 4, name: "屋外", temperature: null, humidity: null, co2: null, co2Level: null, stale: false, measuredAt: null },
    ]);
  });
});

describe("CO2の段階", () => {
  it("Webの getCo2Level() と同じしきい値で段階を付ける（1000・1500ちょうどは上の段階）", () => {
    const levels = [999, 1000, 1499, 1500].map(
      (co2) => build([{ type: "device", deviceId: 3 }], { 3: { temperature: 25, co2 } })[0].co2Level
    );
    expect(levels).toEqual(["good", "elevated", "elevated", "high"]);
  });
});

describe("pickDefaultWidgetSensor", () => {
  it("ID 1 に固定せず、受信中で室温を持つ最初のセンサーを選ぶ（#560）", () => {
    const sensors = build(
      [
        { type: "device", deviceId: 1 },
        { type: "device", deviceId: 4 },
        { type: "device", deviceId: 3 },
      ],
      { 1: { temperature: 26.2 }, 4: null, 3: { temperature: 28.5, humidity: 64 } },
      [1]
    );
    expect(pickDefaultWidgetSensor(sensors)?.id).toBe(3);
  });

  it("受信中のものが無ければ、止まっていても室温を持つ最初のセンサーへ倒す", () => {
    const sensors = build(
      [
        { type: "device", deviceId: 2 },
        { type: "device", deviceId: 3 },
      ],
      { 2: null, 3: { temperature: 28.5 } },
      [2, 3]
    );
    expect(pickDefaultWidgetSensor(sensors)?.id).toBe(3);
  });

  it("室温を持つセンサーが無ければ null", () => {
    expect(pickDefaultWidgetSensor([])).toBeNull();
  });
});
