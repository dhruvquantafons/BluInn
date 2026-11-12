import { describe, expect, it } from "vitest";
import { shiftBreakdown } from "../app/lib/cashier";
import { friendlyDbError } from "../app/lib/db-errors";
import { rosterCellsToFill } from "../app/lib/hr";
import { stockState } from "../app/lib/inventory";

// Section 2 of docs/interconnection-audit-2026-11-07.md, "Data that doesn't
// flow between modules": the pieces that can be checked without a database.

describe("shiftBreakdown — foreign-currency cash is not rupees in the drawer (0041)", () => {
  it("counts USD cash in dollars, apart from the rupee drawer", () => {
    const b = shiftBreakdown({
      openingFloat: 1000,
      folio: [
        { kind: "payment", method: "cash", amount: 2000, voided_at: null },
        { kind: "payment", method: "cash", amount: 8400, voided_at: null, fx_currency: "USD", fx_amount: 100 },
        { kind: "refund", method: "cash", amount: 840, voided_at: null, fx_currency: "USD", fx_amount: 10 },
      ],
      pos: [],
      movements: [],
    });
    expect(b.folioCash).toBe(2000);
    expect(b.expected).toBe(3000);
    expect(b.foreignCash).toEqual({ USD: 90 });
  });
});

describe("rosterCellsToFill — the roster skips approved leave and people who have left (0041)", () => {
  const days = ["2026-11-16", "2026-11-17", "2026-11-18"];
  it("leaves the days someone is on approved leave empty", () => {
    const cells = rosterCellsToFill({
      days,
      people: [{ id: "a", default_shift_id: "s1", weekly_off: null }],
      taken: new Set(),
      leave: [{ staff_id: "a", start_date: "2026-11-17", end_date: "2026-11-17" }],
      dayOfWeek: () => 1,
    });
    expect(cells.map((c) => c.shift_date)).toEqual(["2026-11-16", "2026-11-18"]);
  });
  it("still marks the weekly day off as off", () => {
    const cells = rosterCellsToFill({
      days: ["2026-11-16"],
      people: [{ id: "a", default_shift_id: "s1", weekly_off: 1 }],
      taken: new Set(),
      leave: [],
      dayOfWeek: () => 1,
    });
    expect(cells).toEqual([{ staff_id: "a", shift_date: "2026-11-16", shift_type_id: null }]);
  });
  it("does not fill a cell already on the roster", () => {
    const cells = rosterCellsToFill({
      days: ["2026-11-16"],
      people: [{ id: "a", default_shift_id: "s1", weekly_off: null }],
      taken: new Set(["a:2026-11-16"]),
      leave: [],
      dayOfWeek: () => 1,
    });
    expect(cells).toEqual([]);
  });
});

describe("friendlyDbError — the 0041 guards", () => {
  it.each([
    ["POS_OTHER_PROPERTY: that guest is staying at another hotel; take payment at the outlet instead",
      "That guest is staying at another hotel; take payment at the outlet instead."],
    ["EVENT_ON_FOLIO: this event is billed to a guest's room; it is invoiced on their folio",
      "This event is billed to a guest's room; it is invoiced on their folio."],
    ["GUEST_ERASED: that profile was erased at the guest's request; keep the other one instead",
      "That profile was erased at the guest's request; keep the other one instead."],
    ["PROPERTY_NOT_YOURS: choose one of your hotels", "Choose one of your hotels."],
  ])("explains %s", (raw, friendly) => {
    expect(friendlyDbError(raw)).toBe(friendly);
  });
});

describe("stockState — stock that went below zero needs a count (0041)", () => {
  it("is 'short' when more was used than was recorded on hand", () => {
    expect(stockState(-2, 5, 10)).toBe("short");
  });
  it("is still 'out' at exactly zero", () => {
    expect(stockState(0, 5, 10)).toBe("out");
  });
});
