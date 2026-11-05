import { describe, it, expect } from "vitest";
import { stockState, toOrder, totalsByItem } from "../app/lib/inventory";

describe("inventory", () => {
  it("adds stock across locations", () => {
    const t = totalsByItem([
      { item_id: "a", location_id: "x", qty: 24 },
      { item_id: "a", location_id: "y", qty: 20.5 },
      { item_id: "b", location_id: "x", qty: -1 },
    ]);
    expect(t.get("a")).toBe(44.5);
    expect(t.get("b")).toBe(-1);
  });
  it("reads out, re-order, below par and ok", () => {
    expect(stockState(0, 10, 50)).toBe("out");
    expect(stockState(-2, 10, 50)).toBe("out");
    expect(stockState(10, 10, 50)).toBe("reorder");
    expect(stockState(30, 10, 50)).toBe("below_par");
    expect(stockState(50, 10, 50)).toBe("ok");
    expect(stockState(5, 0, 0)).toBe("ok");
  });
  it("orders up to par, ignoring a negative balance", () => {
    expect(toOrder(30, 50)).toBe(20);
    expect(toOrder(-5, 50)).toBe(50);
    expect(toOrder(60, 50)).toBe(0);
  });
});
