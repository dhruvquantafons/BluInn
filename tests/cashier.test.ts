import { describe, it, expect } from "vitest";
import { shiftBreakdown, varianceLabel } from "../app/lib/cashier";

/** Cashier shifts (0029): the drawer figure must match cashier_shift_expected(). */

describe("shiftBreakdown", () => {
  it("adds the float, cash taken and pay-ins, and takes off refunds, paid-outs and drops", () => {
    const b = shiftBreakdown({
      openingFloat: 1000,
      folio: [
        { kind: "payment", method: "cash", amount: 500, voided_at: null },
        { kind: "refund", method: "cash", amount: 120, voided_at: null },
        { kind: "payment", method: "card", amount: 4000, voided_at: null },
      ],
      pos: [
        { kind: "cash", amount: 250.5, voided_at: null },
        { kind: "upi", amount: 99, voided_at: null },
        { kind: "room_charge", amount: 800, voided_at: null },
      ],
      movements: [
        { kind: "pay_in", amount: 200 },
        { kind: "paid_out", amount: 75 },
        { kind: "safe_drop", amount: 300 },
      ],
    });
    expect(b.expected).toBe(1000 + 500 - 120 + 250.5 + 200 - 75 - 300);
    expect(b.otherByMethod).toEqual({ card: 4000, outlet_upi: 99 });
  });

  it("ignores voided lines and non-payment kinds", () => {
    const b = shiftBreakdown({
      openingFloat: 0,
      folio: [
        { kind: "payment", method: "cash", amount: 500, voided_at: "2026-11-05T10:00:00Z" },
        { kind: "extra", method: null, amount: 900, voided_at: null },
      ],
      pos: [{ kind: "cash", amount: 40, voided_at: "2026-11-05T10:00:00Z" }],
      movements: [],
    });
    expect(b.expected).toBe(0);
  });

  it("matches the database test: 1000 + 500 + 200 - 300 = 1400", () => {
    const b = shiftBreakdown({
      openingFloat: 1000,
      folio: [{ kind: "payment", method: "cash", amount: 500, voided_at: null }],
      pos: [],
      movements: [
        { kind: "pay_in", amount: 200 },
        { kind: "safe_drop", amount: 300 },
      ],
    });
    expect(b.expected).toBe(1400);
  });

  it("rounds to paise", () => {
    const b = shiftBreakdown({
      openingFloat: 0.1,
      folio: [{ kind: "payment", method: "cash", amount: 0.2, voided_at: null }],
      pos: [],
      movements: [],
    });
    expect(b.expected).toBe(0.3);
  });
});

describe("varianceLabel", () => {
  it("reads open, balanced, short and over", () => {
    expect(varianceLabel(null).text).toBe("Open");
    expect(varianceLabel(0)).toEqual({ text: "Balanced", tone: "green" });
    expect(varianceLabel(-10)).toEqual({ text: "Short 10.00", tone: "red" });
    expect(varianceLabel(5.5)).toEqual({ text: "Over 5.50", tone: "amber" });
  });
});
