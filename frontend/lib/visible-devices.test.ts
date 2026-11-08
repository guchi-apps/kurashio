import { describe, expect, it, vi } from "vitest";
import {
  applyHiddenDevicesToLineVisibility,
  buildAllDashboardTargetKeys,
  getVisibleChartDeviceIds,
  getVisibleSensorDeviceIds,
  isAirconRoomVisible,
  isAirconTargetVisible,
  isAirconAnyVisible,
  isDeviceDht11Visible,
  isHiddenKeyVisible,
  setHiddenKeyVisible,
  AIRCON_ROOM_HIDDEN_KEY,
  AIRCON_TARGET_VISIBILITY_KEY,
  loadHiddenDeviceKeys,
  normalizeHiddenDeviceKeys,
  saveHiddenDeviceKeys,
  setTargetVisible,
  isTargetVisible,
  sortDisplayOrderHiddenLast,
  HIDDEN_DEVICES_STORAGE_KEY,
} from "@/lib/visible-devices";
import { deviceDht11VisibilityKey } from "@/lib/chart-line-visibility";
import { buildDefaultChartLineVisibility } from "@/lib/chart-line-visibility";
import { outdoorMetricVisibilityKey } from "@/lib/chart-line-visibility";
import { AIRCON_CHART_DEVICE_ID, getSensorDeviceIds } from "@/lib/types";
import {
  BILL_CARD_KEY,
  COMING_SOON_SECTION_KEY,
  ENERGY_CARD_KEY,
  GARBAGE_CARD_KEY,
  PRINTER_CARD_KEY,
  REMOTE_CARD_KEY,
} from "@/lib/dashboard-sections";

describe("visible-devices", () => {
  it("includes real sensor device id 3", () => {
    expect(
      getSensorDeviceIds([
        { id: 1, name: "リビング" },
        { id: 2, name: "寝室" },
        { id: 3, name: "書斎" },
      ])
    ).toEqual([1, 2, 3]);
    expect(getSensorDeviceIds([{ id: 3, name: "書斎" }])).toEqual([3]);
  });

  it("treats all dashboard targets as visible by default", () => {
    expect([...buildAllDashboardTargetKeys([1, 2])].sort()).toEqual(
      [
        "device:1",
        "device:2",
        "device-dht11:1",
        "device-dht11:2",
        "device:9001",
        "airconTarget",
        "outdoor",
        REMOTE_CARD_KEY,
        GARBAGE_CARD_KEY,
        ENERGY_CARD_KEY,
        BILL_CARD_KEY,
        PRINTER_CARD_KEY,
        COMING_SOON_SECTION_KEY,
      ].sort()
    );
    expect(isTargetVisible(new Set(), { type: "device", deviceId: 2 })).toBe(true);
    expect(isTargetVisible(new Set(), { type: "aircon" })).toBe(true);
  });

  it("supports separate aircon room and target visibility", () => {
    const hidden = setHiddenKeyVisible(new Set(), AIRCON_ROOM_HIDDEN_KEY, false);
    expect(isAirconRoomVisible(hidden)).toBe(false);
    expect(isAirconTargetVisible(hidden)).toBe(true);
    expect(isTargetVisible(hidden, { type: "aircon" })).toBe(true);

    const bothHidden = setHiddenKeyVisible(hidden, AIRCON_TARGET_VISIBILITY_KEY, false);
    expect(isAirconAnyVisible(bothHidden)).toBe(false);
    expect(isTargetVisible(bothHidden, { type: "aircon" })).toBe(false);
  });

  it("migrates legacy aircon hidden key to room and target", () => {
    const hidden = normalizeHiddenDeviceKeys(["aircon"], [1, 2]);
    expect(isAirconRoomVisible(hidden)).toBe(false);
    expect(isAirconTargetVisible(hidden)).toBe(false);
    expect(isHiddenKeyVisible(hidden, "aircon")).toBe(false);
  });

  it("keeps hidden devices hidden while new devices stay visible", () => {
    const hidden = normalizeHiddenDeviceKeys(["device:2"], [1, 2, 3]);
    expect(isTargetVisible(hidden, { type: "device", deviceId: 2 })).toBe(false);
    expect(isTargetVisible(hidden, { type: "device", deviceId: 3 })).toBe(true);
  });

  it("filters visible sensor and chart device ids", () => {
    const hidden = new Set(["device:1", "outdoor"]);
    expect(getVisibleSensorDeviceIds([1, 2], hidden)).toEqual([2]);
    expect(getVisibleChartDeviceIds([1, 2], hidden)).toEqual([
      2,
      AIRCON_CHART_DEVICE_ID,
    ]);

    const roomHidden = new Set([AIRCON_ROOM_HIDDEN_KEY]);
    expect(getVisibleChartDeviceIds([1, 2], roomHidden)).toEqual([1, 2]);
  });

  it("hides DHT11 chart lines when configured in hidden devices", () => {
    const hidden = new Set([deviceDht11VisibilityKey(1)]);
    expect(isDeviceDht11Visible(hidden, 1)).toBe(false);
    expect(isDeviceDht11Visible(hidden, 2)).toBe(true);

    const defaults = buildDefaultChartLineVisibility([1, 2]);
    const merged = applyHiddenDevicesToLineVisibility(defaults, hidden, [1, 2]);
    expect(merged[deviceDht11VisibilityKey(1)]).toBe(false);
    expect(merged[deviceDht11VisibilityKey(2)]).toBe(true);
  });

  it("hides all outdoor metric chart lines when outdoor is hidden from the dashboard", () => {
    const hidden = new Set(["outdoor"]);
    const defaults = buildDefaultChartLineVisibility([1, 2]);
    const merged = applyHiddenDevicesToLineVisibility(defaults, hidden, [1, 2]);

    expect(merged[outdoorMetricVisibilityKey("temperature")]).toBe(false);
    expect(merged[outdoorMetricVisibilityKey("humidity")]).toBe(false);
    expect(merged[outdoorMetricVisibilityKey("pressure")]).toBe(false);
  });

  it("toggles visibility for a target", () => {
    const hidden = setTargetVisible(new Set(), { type: "device", deviceId: 1 }, false);
    expect(hidden.has("device:1")).toBe(true);
    const shown = setTargetVisible(hidden, { type: "device", deviceId: 1 }, true);
    expect(shown.has("device:1")).toBe(false);
  });

  it("brings the aircon card back after hiding it and reloading (#358)", () => {
    // 非表示にして保存 → 読み込み直し（`normalizeHiddenDeviceKeys` が2つのキーへ読み替える）
    const hidden = setTargetVisible(new Set(), { type: "aircon" }, false);
    expect(isAirconAnyVisible(hidden)).toBe(false);

    const reloaded = normalizeHiddenDeviceKeys([...hidden], [1, 2]);
    expect(isTargetVisible(reloaded, { type: "aircon" })).toBe(false);

    const shown = setTargetVisible(reloaded, { type: "aircon" }, true);
    expect(isAirconRoomVisible(shown)).toBe(true);
    expect(isAirconTargetVisible(shown)).toBe(true);
    expect(getVisibleChartDeviceIds([1, 2], shown)).toContain(AIRCON_CHART_DEVICE_ID);
  });

  it("sorts hidden targets to the end", () => {
    const order = [
      { type: "device" as const, deviceId: 1 },
      { type: "outdoor" as const },
      { type: "device" as const, deviceId: 2 },
      { type: "aircon" as const },
    ];
    const hidden = new Set(["device:2", "outdoor"]);
    expect(
      sortDisplayOrderHiddenLast(order, hidden).map((item) =>
        item.type === "device" ? `device:${item.deviceId}` : item.type
      )
    ).toEqual(["device:1", "aircon", "outdoor", "device:2"]);
  });

  it("persists hidden devices to localStorage", () => {
    const backing: Record<string, string> = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => backing[key] ?? null,
        setItem: (key: string, value: string) => {
          backing[key] = value;
        },
      },
      dispatchEvent: vi.fn(),
    });

    saveHiddenDeviceKeys(new Set(["device:2"]));
    expect(JSON.parse(backing[HIDDEN_DEVICES_STORAGE_KEY]!)).toEqual(["device:2"]);
    expect(
      isTargetVisible(loadHiddenDeviceKeys([1, 2]), { type: "device", deviceId: 2 })
    ).toBe(false);
    expect(
      isTargetVisible(loadHiddenDeviceKeys([1, 2]), { type: "device", deviceId: 1 })
    ).toBe(true);

    vi.unstubAllGlobals();
  });

  it("暮らしセクションのカードも表示・非表示の対象キーに含む", () => {
    expect(buildAllDashboardTargetKeys([1, 2]).has(REMOTE_CARD_KEY)).toBe(true);
    expect(buildAllDashboardTargetKeys([1, 2]).has(GARBAGE_CARD_KEY)).toBe(true);
    expect(buildAllDashboardTargetKeys([1, 2]).has(ENERGY_CARD_KEY)).toBe(true);
    expect(buildAllDashboardTargetKeys([1, 2]).has(BILL_CARD_KEY)).toBe(true);
  });

  it("近日公開セクションはセクションごと表示・非表示を切り替えられる", () => {
    expect(buildAllDashboardTargetKeys([1, 2]).has(COMING_SOON_SECTION_KEY)).toBe(true);
    const hidden = normalizeHiddenDeviceKeys([COMING_SOON_SECTION_KEY], [1, 2]);
    expect(isHiddenKeyVisible(hidden, COMING_SOON_SECTION_KEY)).toBe(false);
  });

  it("屋外は地点ごとに表示・非表示を持ち、旧`outdoor`は基準地点として読む", () => {
    const outdoor = { locationIds: ["tokyo", "osaka"], primaryId: "tokyo" };
    expect(buildAllDashboardTargetKeys([1], ["tokyo", "osaka"]).has("outdoor:osaka")).toBe(
      true
    );

    const legacy = normalizeHiddenDeviceKeys(["outdoor"], [1], outdoor);
    expect(isTargetVisible(legacy, { type: "outdoor", locationId: "tokyo" })).toBe(false);
    expect(isTargetVisible(legacy, { type: "outdoor", locationId: "osaka" })).toBe(true);

    const perLocation = normalizeHiddenDeviceKeys(["outdoor:osaka"], [1], outdoor);
    expect(isTargetVisible(perLocation, { type: "outdoor", locationId: "tokyo" })).toBe(
      true
    );
    expect(isTargetVisible(perLocation, { type: "outdoor", locationId: "osaka" })).toBe(
      false
    );
  });

  it("推移グラフの屋外ラインが消えるのは基準地点を隠したときだけ", () => {
    const outdoor = { locationIds: ["tokyo", "osaka"], primaryId: "tokyo" };
    const base = { "outdoor:temperature": true };

    const osakaHidden = normalizeHiddenDeviceKeys(["outdoor:osaka"], [1], outdoor);
    expect(
      applyHiddenDevicesToLineVisibility(base, osakaHidden, [1], "outdoor:tokyo")[
        "outdoor:temperature"
      ]
    ).toBe(true);

    const tokyoHidden = normalizeHiddenDeviceKeys(["outdoor:tokyo"], [1], outdoor);
    expect(
      applyHiddenDevicesToLineVisibility(base, tokyoHidden, [1], "outdoor:tokyo")[
        "outdoor:temperature"
      ]
    ).toBe(false);
  });

  it("暮らしセクションのカードの非表示設定は保存から復元される", () => {
    const hidden = normalizeHiddenDeviceKeys([GARBAGE_CARD_KEY], [1, 2]);
    expect(isHiddenKeyVisible(hidden, GARBAGE_CARD_KEY)).toBe(false);
    expect(
      isHiddenKeyVisible(
        setHiddenKeyVisible(hidden, GARBAGE_CARD_KEY, true),
        GARBAGE_CARD_KEY
      )
    ).toBe(true);
  });
});
