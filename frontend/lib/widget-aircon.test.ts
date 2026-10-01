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

  it("先頭2台だけを並べ、状態は表示中の台にだけ入れる", () => {
    const result = buildWidgetAircons(
      units,
      { ac_id: 1, power: "ON", mode: "COOLING", room_temperature: 27.8, target_temperature: 26 },
      true
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 1, power: "ON", targetTemperature: 26, roomTemperature: 27.8 });
    expect(result[1]).toEqual({
      id: 2,
      name: "寝室",
      power: null,
      mode: null,
      roomTemperature: null,
      targetTemperature: null,
    });
  });
});

describe("isWidgetAirconAction", () => {
  it("知らない操作は受けない", () => {
    expect(isWidgetAirconAction("power_on")).toBe(true);
    expect(isWidgetAirconAction("mode_cool")).toBe(false);
  });
});
