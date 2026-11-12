import { describe, expect, it } from "vitest";
import {
  checkoutDeparture,
  lateFeePosted,
  overstayExtension,
  propertyInvoiceProblem,
  suggestedPayment,
} from "../app/lib/checkout";
import { shiftBreakdown } from "../app/lib/cashier";
import { friendlyDbError } from "../app/lib/db-errors";
import type { FolioEntry, PropertySettings } from "../app/lib/types";

// The "Fix these first" list in docs/interconnection-audit-2026-11-07.md:
// the pieces of check-out and night audit that can be checked without a database.

describe("checkoutDeparture — the night the stay ends", () => {
  const stay = { check_in: "2026-11-05", check_out: "2026-11-08" };

  it("is the due-out date for an on-time departure", () => {
    expect(checkoutDeparture(stay, "2026-11-08", "2026-11-08")).toBe("2026-11-08");
  });
  it("is today for an early departure", () => {
    expect(checkoutDeparture(stay, "2026-11-06", "2026-11-06")).toBe("2026-11-06");
  });
  it("still charges one night for a same-day departure", () => {
    expect(checkoutDeparture(stay, "2026-11-05", "2026-11-05")).toBe("2026-11-06");
  });
  it("runs to the open business date when the guest stayed past due-out", () => {
    // Due out on the 8th, still in house on the 10th, business date the 10th:
    // the nights of the 8th and 9th were stayed and must be charged.
    expect(checkoutDeparture(stay, "2026-11-10", "2026-11-10")).toBe("2026-11-10");
  });
  it("does not charge a night the business day has not reached", () => {
    // Shortly after midnight, before night audit: the calendar says the 9th,
    // but the business day is still the 8th, the due-out date.
    expect(checkoutDeparture(stay, "2026-11-09", "2026-11-08")).toBe("2026-11-08");
  });
});

describe("overstayExtension — night audit keeps an overstaying guest's stay open", () => {
  const booking = {
    check_in: "2026-11-05",
    check_out: "2026-11-07",
    quoted_rate: 5000,
    rate_breakdown: [
      { date: "2026-11-05", rate: 5000 },
      { date: "2026-11-06", rate: 5500 },
    ],
  };

  it("leaves a stay that is not overdue alone", () => {
    expect(overstayExtension(booking, "2026-11-06")).toBeNull();
  });
  it("extends the stay by the audited night at the last night's rate", () => {
    expect(overstayExtension(booking, "2026-11-07")).toEqual({
      check_out: "2026-11-08",
      rate_breakdown: [
        { date: "2026-11-05", rate: 5000 },
        { date: "2026-11-06", rate: 5500 },
        { date: "2026-11-07", rate: 5500 },
      ],
    });
  });
  it("fills every missed night when audits were skipped", () => {
    expect(overstayExtension(booking, "2026-11-09")?.rate_breakdown.map((n) => n.date)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
    ]);
  });
  it("uses the quoted rate when the stay has no breakdown", () => {
    expect(overstayExtension({ ...booking, rate_breakdown: [] }, "2026-11-07")?.rate_breakdown).toEqual([
      { date: "2026-11-07", rate: 5000 },
    ]);
  });
});

const entry = (over: Partial<FolioEntry>): FolioEntry =>
  ({
    id: "e",
    booking_id: "b",
    folio_id: "f",
    kind: "fee",
    description: "Late check-out at 13:10",
    amount: 500,
    tax_amount: 25,
    tax_rate: 5,
    stay_date: "2026-11-08",
    voided_at: null,
    ...over,
  }) as FolioEntry;

describe("lateFeePosted — a retried check-out does not charge the late fee twice", () => {
  it("finds today's late check-out fee", () => {
    expect(lateFeePosted([entry({})], "2026-11-08")).toBe(true);
  });
  it("ignores a voided fee", () => {
    expect(lateFeePosted([entry({ voided_at: "2026-11-08T08:00:00Z" })], "2026-11-08")).toBe(false);
  });
  it("ignores another day's fee and other fees", () => {
    expect(lateFeePosted([entry({ stay_date: "2026-11-01" })], "2026-11-08")).toBe(false);
    expect(lateFeePosted([entry({ description: "Early check-in at 09:00" })], "2026-11-08")).toBe(false);
  });
});

describe("suggestedPayment — the amount the check-out form offers", () => {
  it("includes the late fee when it will be charged", () => {
    expect(suggestedPayment(4000, 525, true)).toBe(4525);
  });
  it("leaves it out when the fee is not being charged", () => {
    expect(suggestedPayment(4000, 525, false)).toBe(4000);
  });
  it("offers nothing when nothing is owed", () => {
    expect(suggestedPayment(-200, 0, false)).toBe(0);
  });
});

describe("propertyInvoiceProblem — what stops this hotel issuing any GST invoice", () => {
  const settings = (over: Partial<PropertySettings>) =>
    ({ tax_regime: "gst", gstin: "27AAPFU0939F1ZV", gst_state_code: "27", state: "Maharashtra", invoice_prefix: "INV", ...over }) as PropertySettings;

  it("is nothing for a hotel with a valid GSTIN", () => {
    expect(propertyInvoiceProblem(settings({}))).toBeNull();
  });
  it("names the missing GSTIN", () => {
    expect(propertyInvoiceProblem(settings({ gstin: "" }))).toMatch(/GSTIN/);
  });
  it("is nothing outside the GST regime", () => {
    expect(propertyInvoiceProblem(settings({ tax_regime: "simple", gstin: "" }))).toBeNull();
  });
});

describe("shiftBreakdown — event deposits and payments are in the drawer (0040)", () => {
  it("counts cash event money and its refunds, like cashier_shift_expected()", () => {
    const b = shiftBreakdown({
      openingFloat: 500,
      folio: [],
      pos: [],
      movements: [],
      events: [
        { kind: "advance", method: "cash", amount: 5000, voided_at: null },
        { kind: "payment", method: "cash", amount: 2000, voided_at: null },
        { kind: "refund", method: "cash", amount: 1000, voided_at: null },
        { kind: "payment", method: "card", amount: 3000, voided_at: null },
        { kind: "advance", method: "cash", amount: 900, voided_at: "2026-11-08T10:00:00Z" },
      ],
    });
    expect(b.eventCash).toBe(7000);
    expect(b.eventCashRefunds).toBe(1000);
    expect(b.otherByMethod.event_card).toBe(3000);
    expect(b.expected).toBe(6500);
  });
  it("is unchanged for a shift with no events", () => {
    expect(shiftBreakdown({ openingFloat: 100, folio: [], pos: [], movements: [] }).expected).toBe(100);
  });
});

describe("friendlyDbError — the 0040 guards", () => {
  it("explains a second invoice on the same folio", () => {
    expect(
      friendlyDbError('duplicate key value violates unique constraint "invoices_one_issued_per_folio"'),
    ).toBe("This folio already has an issued invoice. Cancel it before issuing another.");
  });
  it("explains why a room-charged event cannot be cancelled yet", () => {
    expect(
      friendlyDbError(
        "EVENT_ON_CLOSED_FOLIO: the event is on a guest folio that is invoiced or closed by night audit; issue a credit note or post an allowance, then cancel the event",
      ),
    ).toBe(
      "The event is on a guest folio that is invoiced or closed by night audit; issue a credit note or post an allowance, then cancel the event.",
    );
  });
  it("explains a refused staff removal", () => {
    expect(friendlyDbError("STAFF_SELF: you cannot remove your own account")).toBe("You cannot remove your own account.");
  });
});
