import { describe, expect, it } from "vitest";
import type { RemoteButtons } from "@/lib/remote";
import { buildWidgetRemoteButtons } from "@/lib/widget-remote-buttons";
import { claimPressKey } from "@/lib/widget-press";

const buttons: RemoteButtons = {
  configured: true,
  groups: [
    { id: "g1", name: "リビング", buttons: [{ id: "a", label: "照明オン" }, { id: "b", label: "照明オフ", hidden: true }] },
    { id: "g2", name: "寝室", buttons: [{ id: "c", label: "照明オフ" }, { id: "d", label: "常夜灯" }, { id: "e", label: "扇風機" }] },
  ],
};

describe("buildWidgetRemoteButtons", () => {
  it("非表示を除き、グループ名つきで先頭から上限まで並べる", () => {
    expect(buildWidgetRemoteButtons(buttons, 3)).toEqual([
      { id: "a", label: "照明オン", groupName: "リビング" },
      { id: "c", label: "照明オフ", groupName: "寝室" },
      { id: "d", label: "常夜灯", groupName: "寝室" },
    ]);
  });

  it("未取得なら空", () => {
    expect(buildWidgetRemoteButtons(null)).toEqual([]);
  });
});

describe("claimPressKey", () => {
  it("同じキーは2回目に false（最大1回だけ送る）", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(claimPressKey(storage, "k1")).toBe(true);
    expect(claimPressKey(storage, "k1")).toBe(false);
    expect(claimPressKey(storage, "k2")).toBe(true);
  });

  it("保存できないときは送らない側に倒す", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(claimPressKey(storage, "k1")).toBe(false);
  });
});
