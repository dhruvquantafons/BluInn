import { describe, it, expect } from "vitest";
import {
  gstinError,
  gstinCheckChar,
  stateFromGstin,
  stateCodeFor,
  stateLabel,
  splitGst,
  cancelDeadline,
  creditNoteDeadline,
  invoiceTaxFields,
  MAX_GST_PREFIX_LENGTH,
  type InvoiceTaxContext,
} from "../app/lib/gst";
import { invoiceLines, taxBreakdown, gstTotals, invoiceTotals, amountPaid } from "../app/lib/invoices";
import type { FolioEntry } from "../app/lib/types";

/** 0036 — what a GST invoice and credit note depend on. */

const VALID = "27AAPFU0939F1ZV";

describe("GSTIN", () => {
  it("accepts a well-formed GSTIN with the right check character", () => {
    expect(gstinError(VALID)).toBeNull();
    expect(gstinError("29AAGCB7383J1Z4")).toBeNull();
    expect(gstinError(" 27aapfu0939f1zv ")).toBeNull();
  });

  it("computes the check character the GSTN uses", () => {
    expect(gstinCheckChar(VALID.slice(0, 14))).toBe("V");
  });

  it("catches a typo through the check character", () => {
    expect(gstinError("27AAPFU0939F1ZW")).toMatch(/check character/);
    expect(gstinError("27AAPFU0938F1ZV")).toMatch(/check character/);
  });

  it("rejects the wrong length, shape or state", () => {
    expect(gstinError("27AAPFU0939F1Z")).toMatch(/15 characters/);
    expect(gstinError("2AAAPFU0939F1ZV")).toMatch(/does not look/);
    expect(gstinError("99AAPFU0939F1ZV")).toMatch(/not a GST state code/);
  });

  it("reads the state from the first two digits", () => {
    expect(stateFromGstin(VALID)).toBe("27");
    expect(stateLabel("27")).toBe("27 – Maharashtra");
    expect(stateCodeFor("  tamil   nadu")).toBe("33");
    expect(stateCodeFor("Jammu & Kashmir")).toBe("01");
    expect(stateCodeFor("Atlantis")).toBe("");
  });
});

describe("splitting tax", () => {
  it("halves intra-state tax into CGST and SGST, SGST taking the odd paisa", () => {
    expect(splitGst(50, false)).toEqual({ cgst: 25, sgst: 25, igst: 0 });
    expect(splitGst(50.01, false)).toEqual({ cgst: 25.01, sgst: 25, igst: 0 });
    const s = splitGst(0.03, false);
    expect(s.cgst + s.sgst).toBeCloseTo(0.03, 10);
  });

  it("puts inter-state tax on IGST", () => {
    expect(splitGst(180, true)).toEqual({ cgst: 0, sgst: 0, igst: 180 });
  });
});

describe("deadlines", () => {
  it("allows cancelling until the 11th of the next month", () => {
    expect(cancelDeadline("2026-11-30")).toBe("2026-12-11");
    expect(cancelDeadline("2026-12-01")).toBe("2027-01-11");
  });

  it("allows credit notes until 30 November after the financial year", () => {
    expect(creditNoteDeadline("2026-04-01")).toBe("2027-11-30");
    expect(creditNoteDeadline("2027-03-31")).toBe("2027-11-30");
    expect(creditNoteDeadline("2027-04-01")).toBe("2028-11-30");
  });
});

describe("bill-to on a GST invoice", () => {
  const ctx: InvoiceTaxContext = {
    regime: "gst",
    propertyGstin: VALID,
    propertyStateCode: "",
    propertyState: "Maharashtra",
    invoicePrefix: "INV",
    grandTotal: 10000,
  };

  it("bills a guest with place of supply at the hotel", () => {
    const r = invoiceTaxFields({ name: "Asha Rao", gstin: "", address: "" }, ctx);
    expect("fields" in r && r.fields).toMatchObject({
      tax_regime: "gst",
      supplier_gstin: VALID,
      supplier_state_code: "27",
      place_of_supply: "27 – Maharashtra",
      bill_to_gstin: "",
      is_interstate: false,
    });
  });

  it("keeps a business from another state on CGST + SGST (place of supply is the hotel)", () => {
    const r = invoiceTaxFields({ name: "Acme", gstin: "29AAGCB7383J1Z4", address: "MG Road, Bengaluru" }, ctx);
    expect("fields" in r && r.fields).toMatchObject({ bill_to_state_code: "29", is_interstate: false });
  });

  it("needs a valid buyer GSTIN and an address for a business bill", () => {
    expect(invoiceTaxFields({ name: "Acme", gstin: "29AAGCB7383J1Z5", address: "x" }, ctx)).toEqual({
      error: expect.stringMatching(/Buyer's GSTIN/),
    });
    expect(invoiceTaxFields({ name: "Acme", gstin: "29AAGCB7383J1Z4", address: "" }, ctx)).toEqual({
      error: expect.stringMatching(/registered address/),
    });
  });

  it("needs an address on an unregistered bill of ₹50,000 or more", () => {
    expect(invoiceTaxFields({ name: "Asha", gstin: "", address: "" }, { ...ctx, grandTotal: 50000 })).toEqual({
      error: expect.stringMatching(/needs their address/),
    });
  });

  it("refuses until the hotel's own GSTIN is set, and keeps the number within 16 characters", () => {
    expect(invoiceTaxFields({ name: "A", gstin: "", address: "" }, { ...ctx, propertyGstin: "" })).toEqual({
      error: expect.stringMatching(/hotel's GSTIN/),
    });
    expect(MAX_GST_PREFIX_LENGTH).toBe(3);
    expect(invoiceTaxFields({ name: "A", gstin: "", address: "" }, { ...ctx, invoicePrefix: "HOTEL" })).toEqual({
      error: expect.stringMatching(/16 characters/),
    });
  });

  it("leaves a plain invoice alone", () => {
    const r = invoiceTaxFields({ name: "A", gstin: "", address: "" }, { ...ctx, regime: "simple", propertyGstin: "" });
    expect("fields" in r && r.fields).toMatchObject({ tax_regime: "simple", place_of_supply: "Maharashtra" });
  });
});

const entry = (e: Partial<FolioEntry>): FolioEntry => ({
  id: crypto.randomUUID(),
  booking_id: "b1",
  folio_id: "f1",
  kind: "room",
  description: "Room 101",
  stay_date: "2026-11-20",
  amount: 0,
  tax_amount: 0,
  tax_rate: 0,
  method: null,
  reference: "",
  is_deposit: false,
  fx_currency: null,
  fx_amount: null,
  fx_rate: null,
  night_audit_date: null,
  voided_at: null,
  void_reason: "",
  created_at: "2026-11-20T10:00:00.000Z",
  ...e,
});

describe("GST invoice lines", () => {
  const room = entry({ id: "r1", amount: 4000, tax_amount: 200, tax_rate: 5, sac_code: "996311", revenue_dept: "rooms" });
  const dinner = entry({
    kind: "extra",
    description: "Main Restaurant — RST/000012",
    amount: 1000,
    tax_amount: 50,
    tax_rate: 5,
    sac_code: "996331",
    revenue_dept: "fnb",
  });
  // The database worked out the tax inside the allowance (0036).
  const allowance = entry({
    kind: "adjustment",
    description: "AC fault",
    amount: 1050,
    tax_amount: 50,
    tax_rate: 5,
    sac_code: "996311",
    revenue_dept: "rooms",
    applies_to: "r1",
    created_at: "2026-11-21T09:00:00.000Z",
  });
  const payment = entry({ kind: "payment", amount: 4200, method: "card" });

  it("carries the SAC code and the CGST/SGST split", () => {
    const [line] = invoiceLines([room], { regime: "gst" });
    expect(line).toMatchObject({ sac: "996311", cgst: 100, sgst: 100, igst: 0, total: 4200 });
  });

  it("prints an allowance against a charge as a discount that lowers the tax", () => {
    const lines = invoiceLines([room, dinner, allowance, payment], { regime: "gst" });
    expect(lines.map((l) => l.kind)).toEqual(["room", "extra", "allowance"]);
    expect(lines[2]).toMatchObject({ net: -1000, tax: -50, cgst: -25, sgst: -25, total: -1050, sac: "996311" });
    expect(invoiceTotals(lines)).toEqual({ net: 4000, tax: 200, grand: 4200 });
    expect(gstTotals(lines)).toEqual({ cgst: 100, sgst: 100, igst: 0 });
  });

  it("groups the summary by SAC and rate", () => {
    const bands = taxBreakdown(invoiceLines([room, dinner, allowance], { regime: "gst" }));
    expect(bands).toEqual([
      { sac: "996311", rate: 5, net: 3000, tax: 150, cgst: 75, sgst: 75, igst: 0 },
      { sac: "996331", rate: 5, net: 1000, tax: 50, cgst: 25, sgst: 25, igst: 0 },
    ]);
  });

  it("does not count an allowance as paid as well as discounted", () => {
    expect(amountPaid([room, allowance, payment])).toBe(4200);
  });

  it("keeps plain invoices as they were", () => {
    const [line] = invoiceLines([room]);
    expect(line).not.toHaveProperty("sac");
    expect(line).not.toHaveProperty("cgst");
  });
});
