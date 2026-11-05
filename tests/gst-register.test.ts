import { describe, it, expect } from "vitest";
import { buildRegister, registerTotals, type RegisterInput } from "../app/lib/gst-register";

/** 0036 — the month's GST register, as GSTR-1 reads it. */

const band = (sac: string, rate: number, net: number) => {
  const tax = Math.round(net * rate) / 100;
  return { sac, rate, net, tax, cgst: tax / 2, sgst: tax / 2, igst: 0 };
};

const invoice = (over: Partial<RegisterInput["invoices"][number]>): RegisterInput["invoices"][number] => ({
  number: "INV/2026-27/0001",
  series: "INV",
  seq: 1,
  issued_at: "2026-11-10T06:00:00.000Z",
  status: "issued",
  bill_to_name: "Guest",
  bill_to_gstin: "",
  place_of_supply: "27 – Maharashtra",
  is_interstate: false,
  grand_total: 4200,
  tax_breakdown: [band("996311", 5, 4000)],
  tax_regime: "gst",
  ...over,
});

const input: RegisterInput = {
  invoices: [
    invoice({}),
    invoice({
      number: "INV/2026-27/0002",
      seq: 2,
      bill_to_name: "Acme Pvt Ltd",
      bill_to_gstin: "29AAGCB7383J1Z4",
      grand_total: 5250,
      tax_breakdown: [band("996311", 5, 4000), band("996331", 5, 1000)],
    }),
    invoice({ number: "INV/2026-27/0003", seq: 3, status: "cancelled", grand_total: 999 }),
  ],
  creditNotes: [
    {
      number: "CN/2026-27/0001",
      series: "CN",
      seq: 1,
      issued_at: "2026-11-20T06:00:00.000Z",
      bill_to_name: "Acme Pvt Ltd",
      bill_to_gstin: "29AAGCB7383J1Z4",
      place_of_supply: "27 – Maharashtra",
      is_interstate: false,
      grand_total: 1050,
      tax_breakdown: [band("996311", 5, 1000)],
      invoice_number: "INV/2026-27/0002",
      invoice_date: "2026-11-10",
    },
  ],
  outlets: [{ sac: "996331", rate: 5, net: 2000, tax: 100, bills: 7 }],
  placeOfSupply: "27 – Maharashtra",
  dayOf: (iso) => iso.slice(0, 10),
};

describe("GST register", () => {
  const reg = buildRegister(input);

  it("lists business invoices one row per rate band, with the buyer's GSTIN", () => {
    expect(reg.b2b.body).toHaveLength(2);
    expect(reg.b2b.body[0].slice(0, 4)).toEqual(["29AAGCB7383J1Z4", "Acme Pvt Ltd", "INV/2026-27/0002", "2026-11-10"]);
  });

  it("sums personal invoices and outlet bills by place of supply and rate, leaving cancelled ones out", () => {
    expect(reg.b2cs.body).toEqual([["OE", "27 – Maharashtra", 5, 6000, 0, 150, 150]]);
  });

  it("files credit notes by whether the buyer is registered, quoting the original invoice", () => {
    expect(reg.cdnr.body).toHaveLength(1);
    expect(reg.cdnur.body).toHaveLength(0);
    expect(reg.cdnr.body[0]).toContain("INV/2026-27/0002");
  });

  it("nets credit notes off the SAC summary", () => {
    expect(reg.hsn.body).toEqual([
      ["996311", "NA", 5, 7000, 0, 175, 175, 7350],
      ["996331", "NA", 5, 3000, 0, 75, 75, 3150],
    ]);
  });

  it("gives each series' range and its cancellations", () => {
    expect(reg.docs.body).toEqual([
      ["Invoices for outward supply", "INV/2026-27/0001", "INV/2026-27/0003", 3, 1, 2],
      ["Credit notes", "CN/2026-27/0001", "CN/2026-27/0001", 1, 0, 1],
    ]);
  });

  it("totals the month net of credit notes", () => {
    expect(registerTotals(input)).toEqual({
      b2bCount: 1,
      b2bValue: 5250,
      b2cValue: 4200,
      creditValue: 1050,
      outletValue: 2100,
      taxableNet: 10000,
      taxNet: 500,
    });
  });
});
