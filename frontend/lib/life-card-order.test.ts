import { describe, expect, it } from "vitest";
import {
  buildDefaultLifeCardOrder,
  getOrderedLifeCards,
  moveLifeCardOrderItem,
  normalizeLifeCardOrder,
  reorderLifeCards,
} from "@/lib/life-card-order";
import {
  BILL_CARD_KEY,
  CLEANING_CARD_KEY,
  ENERGY_CARD_KEY,
  GARBAGE_CARD_KEY,
  LIFE_CARDS,
  PRINTER_CARD_KEY,
  REMOTE_CARD_KEY,
} from "@/lib/dashboard-sections";

describe("life-card-order", () => {
  it("falls back to the LIFE_CARDS order when nothing is saved", () => {
    expect(normalizeLifeCardOrder(null)).toEqual(buildDefaultLifeCardOrder());
    expect(normalizeLifeCardOrder([])).toEqual(LIFE_CARDS.map((card) => card.key));
  });

  it("keeps the saved order", () => {
    expect(
      normalizeLifeCardOrder([
        CLEANING_CARD_KEY,
        GARBAGE_CARD_KEY,
        REMOTE_CARD_KEY,
        ENERGY_CARD_KEY,
        BILL_CARD_KEY,
        PRINTER_CARD_KEY,
      ])
    ).toEqual([
      CLEANING_CARD_KEY,
      GARBAGE_CARD_KEY,
      REMOTE_CARD_KEY,
      ENERGY_CARD_KEY,
      BILL_CARD_KEY,
      PRINTER_CARD_KEY,
    ]);
  });

  // カードを1枚増やしたときに、並べ替え済みの人にだけ出ない状態にならないこと
  it("appends cards that are missing from the saved order", () => {
    const normalized = normalizeLifeCardOrder([CLEANING_CARD_KEY, GARBAGE_CARD_KEY]);
    expect(normalized.slice(0, 2)).toEqual([CLEANING_CARD_KEY, GARBAGE_CARD_KEY]);
    expect(normalized).toHaveLength(LIFE_CARDS.length);
    expect(new Set(normalized).size).toBe(LIFE_CARDS.length);
  });

  it("drops unknown keys and duplicates", () => {
    const normalized = normalizeLifeCardOrder([
      "removed-card",
      GARBAGE_CARD_KEY,
      GARBAGE_CARD_KEY,
    ]);
    expect(normalized).not.toContain("removed-card");
    expect(normalized[0]).toBe(GARBAGE_CARD_KEY);
    expect(normalized).toHaveLength(LIFE_CARDS.length);
  });

  it("resolves the order into card definitions", () => {
    const cards = getOrderedLifeCards([BILL_CARD_KEY]);
    expect(cards[0].key).toBe(BILL_CARD_KEY);
    expect(cards[0].label).toBe("電気・ガス・水道料金");
    expect(cards).toHaveLength(LIFE_CARDS.length);
  });

  it("swaps with the neighbour and stays put at the edges", () => {
    const order = [REMOTE_CARD_KEY, GARBAGE_CARD_KEY, ENERGY_CARD_KEY];
    expect(moveLifeCardOrderItem(order, 1, -1)).toEqual([
      GARBAGE_CARD_KEY,
      REMOTE_CARD_KEY,
      ENERGY_CARD_KEY,
    ]);
    expect(moveLifeCardOrderItem(order, 0, -1)).toEqual(order);
    expect(moveLifeCardOrderItem(order, 2, 1)).toEqual(order);
  });

  it("moves an item to the dropped position", () => {
    const order = [REMOTE_CARD_KEY, GARBAGE_CARD_KEY, ENERGY_CARD_KEY];
    expect(reorderLifeCards(order, 0, 2)).toEqual([
      GARBAGE_CARD_KEY,
      ENERGY_CARD_KEY,
      REMOTE_CARD_KEY,
    ]);
    expect(reorderLifeCards(order, 1, 1)).toEqual(order);
    expect(reorderLifeCards(order, 0, 9)).toEqual(order);
  });
});
