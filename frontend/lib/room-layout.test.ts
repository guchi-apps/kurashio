import { describe, expect, it } from "vitest";
import type { EnergySourceRow } from "@/lib/types";
import {
  buildDefaultRoomLayers,
  buildDefaultRoomLayout,
  buildRoomWallParts,
  getRoomZoneBinding,
  isApplianceActive,
  normalizeRoomLayout,
  resolveRoomZones,
  ROOM_WALL_PARTS,
  ROOM_ZONE_DEFS,
  roomTemperatureColor,
  setRoomZoneBinding,
  type RoomWallDefinition,
} from "@/lib/room-layout";

const NOW = new Date("2026-09-08T12:00:00Z");

function energySource(
  source: string,
  powerW: number | null,
  updatedAt: string | null = NOW.toISOString()
): EnergySourceRow {
  return {
    source,
    label: source.replace(/^tapo:/, ""),
    default_label: source.replace(/^tapo:/, ""),
    today_kwh: 0,
    today_cost_yen: 0,
    power_w: powerW,
    power_updated_at: updatedAt,
    this_month_kwh: 0,
    latest_date: "2026-09-08",
  };
}

describe("normalizeRoomLayout", () => {
  it("保存が無ければ既定の紐付けで始める", () => {
    const layout = normalizeRoomLayout(null);
    expect(layout.zones.map((zone) => zone.key)).toEqual(
      ROOM_ZONE_DEFS.map((zone) => zone.key)
    );
    expect(getRoomZoneBinding(layout, "ldk").device_id).toBe(1);
    expect(getRoomZoneBinding(layout, "bedroom").device_id).toBe(2);
    // エアコンは実物どおり洋室に1台（#406）
    expect(getRoomZoneBinding(layout, "bedroom").ac_id).toBe(1);
    expect(getRoomZoneBinding(layout, "ldk").ac_id).toBeNull();
  });

  it("実物の2LDKの場所がそろい、仮の1LDKのキーはそのまま残る（#406）", () => {
    const keys = ROOM_ZONE_DEFS.map((zone) => zone.key);
    expect(keys).toEqual([
      "ldk",
      "bedroom",
      "washitsu",
      "washroom",
      "bath",
      "toilet",
      "entrance",
      "balcony",
    ]);
    // 仮の1LDK時代に保存した紐付けは、キーが同じなので新しい間取りでも失われない
    const layout = normalizeRoomLayout({
      zones: [
        { key: "ldk", device_id: 1, ac_id: 1 },
        { key: "bedroom", device_id: 2, ac_id: null },
        { key: "bath", device_id: 3, ac_id: null },
        { key: "entrance", device_id: null, ac_id: null },
      ],
    });
    expect(getRoomZoneBinding(layout, "ldk").ac_id).toBe(1);
    expect(getRoomZoneBinding(layout, "bath").device_id).toBe(3);
    expect(getRoomZoneBinding(layout, "balcony").device_id).toBeNull();
  });

  it("知らないゾーンのキーを落とし、足りないゾーンを空で補う", () => {
    const layout = normalizeRoomLayout({
      zones: [
        { key: "ldk", device_id: 5, ac_id: 2, tapo_sources: ["tapo:冷蔵庫"] },
        { key: "kitchen-that-does-not-exist", device_id: 9 },
      ],
    });

    expect(layout.zones.map((zone) => zone.key)).toEqual(
      ROOM_ZONE_DEFS.map((zone) => zone.key)
    );
    expect(getRoomZoneBinding(layout, "ldk")).toEqual({
      key: "ldk",
      device_id: 5,
      ac_id: 2,
      tapo_sources: ["tapo:冷蔵庫"],
    });
    // 保存に無かったゾーンは既定へ戻さず空にする。1つでも保存されていれば人の意思なので
    expect(getRoomZoneBinding(layout, "bedroom").device_id).toBeNull();
  });

  it("読めないIDと重複したプラグのsourceを落とす", () => {
    const layout = normalizeRoomLayout({
      zones: [
        {
          key: "ldk",
          device_id: "abc",
          ac_id: -1,
          tapo_sources: ["tapo:冷蔵庫", "tapo:冷蔵庫", "", 3],
        },
      ],
    });
    expect(getRoomZoneBinding(layout, "ldk")).toEqual({
      key: "ldk",
      device_id: null,
      ac_id: null,
      tapo_sources: ["tapo:冷蔵庫"],
    });
  });

  it("全部の紐付けを外した状態を既定へ戻さない", () => {
    const cleared = buildDefaultRoomLayout().zones.map((zone) => ({
      ...zone,
      device_id: null,
      ac_id: null,
    }));
    const layout = normalizeRoomLayout({ zones: cleared });
    expect(getRoomZoneBinding(layout, "ldk").device_id).toBeNull();
  });
});

describe("setRoomZoneBinding", () => {
  it("指定したゾーンだけを差し替える", () => {
    const before = buildDefaultRoomLayout();
    const after = setRoomZoneBinding(before, "bath", { device_id: 3 });

    expect(getRoomZoneBinding(after, "bath").device_id).toBe(3);
    expect(getRoomZoneBinding(after, "ldk").device_id).toBe(1);
    // 元の設定は書き換えない
    expect(getRoomZoneBinding(before, "bath").device_id).toBeNull();
  });
});

describe("resolveRoomZones", () => {
  const sources = {
    layout: normalizeRoomLayout({
      zones: [
        {
          key: "ldk",
          device_id: 1,
          ac_id: 1,
          tapo_sources: ["tapo:冷蔵庫", "tapo:テレビ"],
        },
        { key: "bedroom", device_id: 2, ac_id: null },
      ],
    }),
    latestByDevice: {
      1: { device_id: 1, temperature: 26.4, humidity: 58, illuminance: 320 },
      2: { device_id: 2, temperature: 25.1, humidity: 61, illuminance: 4 },
    },
    lightThresholds: { "1": 80, "2": 80 },
    airconByAcId: { 1: { ac_id: 1, mode: "COOLING", power: "ON", target_temperature: 26 } },
    energySources: [
      energySource("tapo:冷蔵庫", 45),
      energySource("tapo:テレビ", 0.4),
      energySource("tapo:洗濯機", 400),
    ],
    now: NOW,
  };

  it("場所ごとに室温・照明・エアコンをまとめる", () => {
    const zones = resolveRoomZones(sources);
    const ldk = zones.find((zone) => zone.key === "ldk");

    expect(ldk?.temperature).toBe(26.4);
    expect(ldk?.light?.status).toBe("on");
    expect(ldk?.aircon?.target_temperature).toBe(26);
  });

  it("紐付けたプラグを、動作中かどうかに関わらずすべて返す", () => {
    const zones = resolveRoomZones(sources);
    const ldk = zones.find((zone) => zone.key === "ldk");

    // 冷蔵庫（45W）は動作中、テレビ（0.4W・待機電力）は待機中として出す。
    // 洗濯機（400W）はどのゾーンにも紐付けていないので出ない
    expect(ldk?.appliances).toEqual([
      { source: "tapo:冷蔵庫", label: "冷蔵庫", active: true, powerW: 45 },
      { source: "tapo:テレビ", label: "テレビ", active: false, powerW: 0.4 },
    ]);
  });

  it("プラグを紐付けていない場所は家電を持たない", () => {
    const zones = resolveRoomZones(sources);
    expect(zones.find((zone) => zone.key === "bedroom")?.appliances).toEqual([]);
  });

  it("記録の無いプラグは待機中として返す（ラベルはsourceそのもの）", () => {
    const zones = resolveRoomZones({
      ...sources,
      layout: normalizeRoomLayout({
        zones: [{ key: "ldk", device_id: 1, ac_id: null, tapo_sources: ["tapo:未接続"] }],
      }),
    });
    expect(zones.find((zone) => zone.key === "ldk")?.appliances).toEqual([
      { source: "tapo:未接続", label: "tapo:未接続", active: false, powerW: null },
    ]);
  });

  it("しきい値を下回れば消灯として返す", () => {
    const zones = resolveRoomZones(sources);
    expect(zones.find((zone) => zone.key === "bedroom")?.light?.status).toBe("off");
  });

  it("センサーを紐付けていない場所は値を持たない", () => {
    const zones = resolveRoomZones(sources);
    const bath = zones.find((zone) => zone.key === "bath");

    expect(bath?.deviceId).toBeNull();
    expect(bath?.temperature).toBeNull();
    expect(bath?.light).toBeNull();
    expect(bath?.aircon).toBeNull();
  });

  it("全ゾーンを必ず返す（3Dの床は紐付けの有無に関わらず描くため）", () => {
    expect(resolveRoomZones(sources)).toHaveLength(ROOM_ZONE_DEFS.length);
  });

  it("床の地の色と段差を場所ごとに持ち、バルコニーは屋外センサーの値を出せる", () => {
    const zones = resolveRoomZones({
      ...sources,
      layout: normalizeRoomLayout({
        zones: [{ key: "balcony", device_id: 1, ac_id: null }],
      }),
    });
    const byKey = Object.fromEntries(zones.map((zone) => [zone.key, zone]));

    expect(byKey.washitsu.floor).toBe("tatami");
    expect(byKey.ldk.floor).toBe("floor");
    expect(byKey.entrance.raise).toBeGreaterThan(0);
    expect(byKey.balcony.floor).toBe("balcony");
    expect(byKey.balcony.temperature).toBe(26.4);
    expect(byKey.balcony.humidity).toBe(58);
  });
});

describe("roomTemperatureColor", () => {
  it("凡例の両端を外れた値でも色を返す", () => {
    expect(roomTemperatureColor(-40)).toMatch(/^#[0-9a-f]{6}$/);
    expect(roomTemperatureColor(99)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("寒いほうが青く、暑いほうが赤い", () => {
    const cold = roomTemperatureColor(18);
    const hot = roomTemperatureColor(31);
    const blue = (hex: string) => parseInt(hex.slice(5, 7), 16);
    const red = (hex: string) => parseInt(hex.slice(1, 3), 16);

    expect(blue(cold)).toBeGreaterThan(blue(hot));
    expect(red(hot)).toBeGreaterThan(red(cold));
  });
});

describe("buildRoomWallParts", () => {
  it("開口の数だけ壁を分割する", () => {
    const wall: RoomWallDefinition = {
      runs: "x",
      at: 0,
      from: -2,
      to: 2,
      height: 1,
      thickness: 0.1,
      tone: "partition",
      gaps: [[0, 1]],
    };
    const parts = buildRoomWallParts([wall]);
    expect(parts).toHaveLength(2);
    expect(parts[0].size[0]).toBeCloseTo(1.5);
    expect(parts[1].size[0]).toBeCloseTo(1.5);
  });

  it("開口の並び順が逆でも同じ位置に穴が空く（#406）", () => {
    const base: RoomWallDefinition = {
      runs: "z",
      at: 0,
      from: -3,
      to: 3,
      height: 1,
      thickness: 0.1,
      tone: "wall",
    };
    const ordered = buildRoomWallParts([{ ...base, gaps: [[-1.5, 1], [1.5, 1]] }]);
    const reversed = buildRoomWallParts([{ ...base, gaps: [[1.5, 1], [-1.5, 1]] }]);
    expect(reversed).toEqual(ordered);
    expect(ordered.map((part) => part.position[2])).toEqual([-2.5, 0, 2.5]);
  });

  it("間取りの壁がすべて正の大きさになる", () => {
    for (const part of ROOM_WALL_PARTS) {
      for (const value of part.size) expect(value).toBeGreaterThan(0);
    }
  });
});

describe("buildDefaultRoomLayers", () => {
  it("狭い画面では温度とエアコンだけを出す", () => {
    expect(buildDefaultRoomLayers(true)).toEqual({
      temperature: true,
      aircon: true,
      light: false,
      appliance: false,
    });
    expect(buildDefaultRoomLayers(false).appliance).toBe(true);
  });
});

describe("isApplianceActive", () => {
  it("しきい値（3W）以上・値が新しければ動作中", () => {
    expect(isApplianceActive(3, NOW.toISOString(), NOW)).toBe(true);
    expect(isApplianceActive(45, NOW.toISOString(), NOW)).toBe(true);
  });

  it("しきい値未満・値が無ければ動作中ではない", () => {
    expect(isApplianceActive(2.9, NOW.toISOString(), NOW)).toBe(false);
    expect(isApplianceActive(0, NOW.toISOString(), NOW)).toBe(false);
    expect(isApplianceActive(null, NOW.toISOString(), NOW)).toBe(false);
  });

  it("値が無い・壊れていれば動作中ではない", () => {
    expect(isApplianceActive(45, null, NOW)).toBe(false);
    expect(isApplianceActive(45, "not-a-date", NOW)).toBe(false);
  });

  it("しきい値を超えていても、値が古ければ動作中ではない（#410）", () => {
    // プラグが応答しなくなると`power_w`は最後の値のまま残るため、15分より古い値は信用しない
    const staleBy16Minutes = new Date(NOW.getTime() - 16 * 60 * 1000).toISOString();
    const staleBy14Minutes = new Date(NOW.getTime() - 14 * 60 * 1000).toISOString();
    expect(isApplianceActive(45, staleBy16Minutes, NOW)).toBe(false);
    expect(isApplianceActive(45, staleBy14Minutes, NOW)).toBe(true);
  });
});
