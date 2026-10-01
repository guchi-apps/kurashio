import { describe, expect, it } from "vitest";
import { buildWidgetAircons, isWidgetAirconAction } from "@/lib/widget-aircon";

const units = [
  { ac_id: 1, name: "リビング" },
  { ac_id: 2, name: "寝室" },
  { ac_id: 3, name: "書斎" },
];

describe("buildWidgetAircons", () => {
  it("操作できない構成では空", () => {
    expect(buildWidgetAircons(units, null, false)).toEqual([]);
  });

  it("表示中の1台だけを、状態つきで返す", () => {
    const result = buildWidgetAircons(
      units,
      { ac_id: 2, power: "ON", mode: "COOLING", room_temperature: 27.8, target_temperature: 26 },
      true
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 2, name: "寝室", power: "ON", targetTemperature: 26, roomTemperature: 27.8 });
  });
});

describe("buildWidgetAircons（状態が未取得）", () => {
  it("先頭の台を状態なしで返す", () => {
    expect(buildWidgetAircons(units, null, true)).toEqual([
      { id: 1, name: "リビング", power: null, mode: null, roomTemperature: null, targetTemperature: null },
    ]);
  });
});

describe("isWidgetAirconAction", () => {
  it("知らない操作は受けない", () => {
    expect(isWidgetAirconAction("power_on")).toBe(true);
    expect(isWidgetAirconAction("mode_cool")).toBe(false);
  });
});
