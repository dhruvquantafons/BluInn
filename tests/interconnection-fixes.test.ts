import { describe, expect, it } from "vitest";
import { friendlyDbError } from "../app/lib/db-errors";
import { ancillaryTax, type TaxSlab } from "../app/lib/tax";
import { kpisFrom, lastClosedDay, type DailyRow } from "../app/lib/reports";
import { ancillaryCharge, insertFolioEntries } from "../app/lib/folio";
import { foliosToInvoice } from "../app/lib/invoices";
import type { FolioEntry } from "../app/lib/types";

// The slabs in force from 22 September 2025: 5% up to ₹7,500 a night, 18% above.
const SLABS: TaxSlab[] = [
  { up_to: 7500, rate: 5 },
  { up_to: null, rate: 18 },
];

describe("ancillaryTax — fees and penalties take the room's GST rate", () => {
  it("adds tax on top when prices exclude tax", () => {
    // A ₹6,000 room is in the 5% slab, so a ₹1,000 late check-out fee is too.
    expect(ancillaryTax(1000, 6000, SLABS, false)).toEqual({ net: 1000, tax: 50, rate: 5 });
  });
  it("uses the 18% slab for a room above ₹7,500", () => {
    expect(ancillaryTax(2000, 9000, SLABS, false)).toEqual({ net: 2000, tax: 360, rate: 18 });
  });
  it("takes tax out of the amount when prices include tax", () => {
    // ₹1,050 inclusive at 5% is ₹1,000 + ₹50.
    expect(ancillaryTax(1050, 6300, SLABS, true)).toEqual({ net: 1000, tax: 50, rate: 5 });
  });
  it("is tax-free when nothing is charged or no slabs are set", () => {
    expect(ancillaryTax(0, 6000, SLABS, false)).toEqual({ net: 0, tax: 0, rate: 0 });
    expect(ancillaryTax(500, 6000, [], false)).toEqual({ net: 500, tax: 0, rate: 0 });
  });
});

describe("friendlyDbError — the interconnection guards", () => {
  it("explains an invoiced folio", () => {
    expect(friendlyDbError("FOLIO_INVOICED: that charge is on an issued invoice; issue a credit note instead")).toBe(
      "That charge is on an issued invoice; issue a credit note instead.",
    );
  });
  it("explains a refund above what was paid", () => {
    expect(friendlyDbError("REFUND_EXCEEDS_PAID: only 400.00 has been paid and not yet refunded")).toBe(
      "Only 400.00 has been paid and not yet refunded.",
    );
    expect(friendlyDbError("EVENT_REFUND_EXCEEDS_PAID: only 0 has been paid and not yet refunded")).toBe(
      "Only 0 has been paid and not yet refunded.",
    );
  });
  it("explains a bill from a closed day", () => {
    expect(friendlyDbError("POS_DAY_CLOSED: this bill was settled on 2026-11-01, which night audit has closed; refund or adjust it today instead")).toBe(
      "This bill was settled on 2026-11-01, which night audit has closed; refund or adjust it today instead.",
    );
  });
});

const day = (over: Partial<DailyRow>): DailyRow =>
  ({
    day: "2026-11-06",
    source: "audit",
    rooms_available: 10,
    rooms_sold: 5,
    room_revenue: 25000,
    other_revenue: 5000,
    tax_total: 5400,
    total_revenue: 35400,
    ...over,
  }) as DailyRow;

describe("kpisFrom — revenue is reported before tax", () => {
  it("exposes revenue excluding tax", () => {
    expect(kpisFrom([day({})]).netRevenue).toBe(30000);
  });
  it("computes GOPPAR on revenue excluding tax", () => {
    // A month is prorated as 30.44 days, so ₹3,04,400 a month is ₹10,000 a day;
    // (30,000 revenue before tax − 10,000) ÷ 10 rooms. With tax it would be 2,540.
    expect(kpisFrom([day({})], 304400).goppar).toBe(2000);
  });
});

describe("lastClosedDay — the dashboard reports the day night audit last closed", () => {
  it("is the day before the open business date", () => {
    expect(lastClosedDay("2026-11-07")).toBe("2026-11-06");
    expect(lastClosedDay("2027-01-01")).toBe("2026-12-31");
  });
});

describe("insertFolioEntries — a folio posting that fails is reported, not dropped", () => {
  const client = (error: { message: string } | null) =>
    ({ from: () => ({ insert: async () => ({ error }) }) }) as never;

  it("returns null when the rows were written", async () => {
    expect(await insertFolioEntries(client(null), [{ kind: "payment", amount: 1 }])).toBeNull();
  });
  it("gives every row of a mixed batch the same columns, with the table's defaults", async () => {
    let sent: Record<string, unknown>[] = [];
    const capture = {
      from: () => ({
        insert: async (rows: Record<string, unknown>[]) => {
          sent = rows;
          return { error: null };
        },
      }),
    } as never;
    await insertFolioEntries(capture, [
      { kind: "payment", amount: 1000, method: "card", is_deposit: true },
      { kind: "fee", amount: 500, tax_amount: 25, tax_rate: 5, stay_date: "2026-11-07" },
    ]);
    // A missing key would be written as null, and these columns are NOT NULL.
    expect(sent[0]).toMatchObject({ tax_amount: 0, tax_rate: 0, stay_date: null });
    expect(sent[1]).toMatchObject({ method: null, is_deposit: false });
  });
  it("returns the desk's wording when the database refuses", async () => {
    expect(
      await insertFolioEntries(client({ message: "CASHIER_NO_SHIFT: open a shift before taking cash" }), [
        { kind: "payment", amount: 1 },
      ]),
    ).toBe("Open your cash shift before taking or refunding cash (Front desk → Cash shift).");
  });
});

const entry = (over: Partial<FolioEntry>): FolioEntry =>
  ({ id: "e", folio_id: "F1", kind: "room", amount: 100, tax_amount: 5, voided_at: null, applies_to: null, ...over }) as FolioEntry;

describe("foliosToInvoice — check-out invoices every folio that has charges", () => {
  it("lists folios with live charges and no issued invoice", () => {
    const entries = [
      entry({ folio_id: "F1" }),
      entry({ folio_id: "F2", kind: "extra" }),
      entry({ folio_id: "F3", kind: "payment" }),
      entry({ folio_id: "F4", voided_at: "2026-11-06T10:00:00Z" }),
      entry({ folio_id: "F5" }),
    ];
    expect(foliosToInvoice(entries, new Set(["F5"]))).toEqual(["F1", "F2"]);
  });
  it("skips a folio whose only charges are free nights (complimentary or house use)", () => {
    expect(foliosToInvoice([entry({ folio_id: "F1", amount: 0, tax_amount: 0 })], new Set())).toEqual([]);
  });
});

describe("ancillaryCharge — the folio columns for a fee or penalty", () => {
  const settings = { tax_inclusive: false, tax_slabs: SLABS } as never;
  const stay = { check_in: "2026-11-10", quoted_rate: 6000, rate_breakdown: [{ date: "2026-11-10", rate: 9000 }] } as never;

  it("taxes a penalty at the slab of the stay's first night", () => {
    expect(ancillaryCharge(1000, stay, settings)).toEqual({ amount: 1000, tax_amount: 180, tax_rate: 18 });
  });
  it("uses the named night when there is one", () => {
    expect(ancillaryCharge(1000, stay, settings, "2026-11-11")).toEqual({ amount: 1000, tax_amount: 50, tax_rate: 5 });
  });
});
