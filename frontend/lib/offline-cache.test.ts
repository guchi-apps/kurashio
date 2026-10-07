import { describe, expect, it } from "vitest";
import {
  OFFLINE_CACHE_WINDOW_MS,
  buildDashboardOfflineSnapshot,
  filterDailyStatsToOfflineWindow,
  filterHistoryToOfflineWindow,
  getLatestDataTimestamp,
  overlayBackgroundSensors,
} from "@/lib/offline-cache";
import type { DailyStat, HistoryPoint, LatestData } from "@/lib/types";

const latestMs = new Date("2026-06-07T12:00:00").getTime();

function makePoint(offsetHours: number): HistoryPoint {
  const datetimeObj = latestMs + offsetHours * 60 * 60 * 1000;
  return {
    datetime: new Date(datetimeObj).toISOString(),
    datetimeObj,
    temperature: 24,
  };
}

describe("getLatestDataTimestamp", () => {
  it("uses the newest timestamp across latest values and history", () => {
    const latestByDevice: Record<number, LatestData | null> = {
      1: { datetime: "2026-06-07T11:50:00" },
      2: { datetime: "2026-06-07T12:00:00" },
    };

    expect(getLatestDataTimestamp(latestByDevice, null, [makePoint(-1)])).toBe(latestMs);
  });
});

describe("filterHistoryToOfflineWindow", () => {
  it("keeps only the latest 24 hours of history", () => {
    const history = [makePoint(-30), makePoint(-23), makePoint(-1), makePoint(0)];

    const filtered = filterHistoryToOfflineWindow(history, latestMs);

    expect(filtered.map((point) => point.datetimeObj)).toEqual([
      makePoint(-23).datetimeObj,
      makePoint(-1).datetimeObj,
      makePoint(0).datetimeObj,
    ]);
  });

  it("defaults to a 24 hour window", () => {
    expect(OFFLINE_CACHE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("filterDailyStatsToOfflineWindow", () => {
  it("keeps daily stats that overlap the offline window", () => {
    const dailyStatsByDevice: Record<number, DailyStat[]> = {
      1: [
        { date: "2026-06-05" },
        { date: "2026-06-06" },
        { date: "2026-06-07" },
      ],
    };

    const filtered = filterDailyStatsToOfflineWindow(dailyStatsByDevice, latestMs);

    expect(filtered[1]?.map((stat) => stat.date)).toEqual(["2026-06-06", "2026-06-07"]);
  });
});

describe("buildDashboardOfflineSnapshot", () => {
  it("builds a trimmed snapshot from dashboard state", () => {
    const snapshot = buildDashboardOfflineSnapshot({
      sensorDeviceIds: [1, 2],
      airconAcId: 1,
      latestByDevice: {
        1: { datetime: "2026-06-07T12:00:00", temperature: 24.5 },
      },
      dailyStatsByDevice: {
        1: [{ date: "2026-06-07", temp_max: 26, temp_min: 22 }],
      },
      airconLatest: { datetime: "2026-06-07T11:55:00", room_temperature: 24.2 },
      historyData: [makePoint(-30), makePoint(-2)],
      devices: [{ id: 1, name: "リビング" }],
      airconUnits: [{ ac_id: 1, name: "エアコン" }],
      outdoorLocation: null,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.historyData).toHaveLength(1);
    expect(snapshot?.dataLatestAt).toBe(new Date(latestMs).toISOString());
    expect(snapshot?.latestByDevice[1]?.temperature).toBe(24.5);
  });

  it("起動直後に前回と同じ並びで出すため、表示設定と暮らしのカードを持つ（#735）", () => {
    const uiSettings = {
      displayOrder: [{ type: "device" as const, deviceId: 1 }],
      lifeCardOrder: ["garbage"],
      chartColors: {},
      hiddenDeviceKeys: ["device:2"],
      staleAlertExcludedKeys: [],
      lightThresholds: { "1": 100 },
    };
    const life = {
      garbageSchedule: null,
      energyBreakdown: null,
      remoteButtons: null,
      billSummary: null,
      cleaningSchedule: null,
      filament: null,
      sensorStatuses: [],
      staleThresholdMinutes: 30,
    };
    const snapshot = buildDashboardOfflineSnapshot({
      sensorDeviceIds: [1],
      airconAcId: 1,
      latestByDevice: { 1: { datetime: "2026-06-07T12:00:00" } },
      dailyStatsByDevice: {},
      airconLatest: null,
      historyData: [makePoint(-1)],
      devices: [],
      airconUnits: [],
      outdoorLocation: null,
      uiSettings: uiSettings as never,
      life,
    });

    expect(snapshot?.uiSettings).toEqual(uiSettings);
    expect(snapshot?.life).toEqual(life);
  });

  it("returns null when there is no history to cache", () => {
    const snapshot = buildDashboardOfflineSnapshot({
      sensorDeviceIds: [1],
      airconAcId: 1,
      latestByDevice: { 1: { datetime: "2026-06-07T12:00:00" } },
      dailyStatsByDevice: {},
      airconLatest: null,
      historyData: [makePoint(-30)],
      devices: [],
      airconUnits: [],
      outdoorLocation: null,
    });

    expect(snapshot).toBeNull();
  });
});

describe("overlayBackgroundSensors（#735）", () => {
  const latest: Record<number, LatestData | null> = {
    1: { datetime: "2026-10-07T12:00:00", temperature: 24, humidity: 50, co2: 600, illuminance: 120 },
    2: { datetime: "2026-10-07T12:00:00", temperature: 20 },
  };

  it("測った時刻が新しいセンサーだけ、届いた項目を差し替える", () => {
    const result = overlayBackgroundSensors(latest, [
      { deviceId: 1, measuredAt: "2026-10-07T12:30:00", temperature: 25, humidity: null, co2: 700 },
      { deviceId: 2, measuredAt: "2026-10-07T11:00:00", temperature: 18, humidity: null, co2: null },
    ]);

    expect(result[1]).toEqual({
      datetime: "2026-10-07T12:30:00",
      temperature: 25,
      humidity: 50,
      co2: 700,
      illuminance: 120,
    });
    expect(result[2]).toBe(latest[2]);
  });

  it("前回のデータに無いセンサーは足さず、変化が無ければ同じオブジェクトを返す", () => {
    const result = overlayBackgroundSensors(latest, [
      { deviceId: 9, measuredAt: "2026-10-07T13:00:00", temperature: 30, humidity: null, co2: null },
      { deviceId: 1, measuredAt: null, temperature: 30, humidity: null, co2: null },
    ]);

    expect(result).toBe(latest);
  });
});
