import type { CreditNote, Invoice } from "./types";
import { splitGst } from "./gst";

/**
 * The month's GST register (0036): what an accountant keys into GSTR-1,
 * built from the invoices and credit notes exactly as issued.
 *
 *   b2b   — invoices to a registered buyer, one row per invoice and rate
 *   b2cs  — everything else, summed by place of supply and rate, including
 *           outlet bills settled at the outlet
 *   cdnr  — credit notes to registered buyers; cdnur — to everyone else
 *   hsn   — taxable value and tax by SAC code, net of credit notes
 *   docs  — the number range issued in each series, and how many cancelled
 *
 * Pure functions, unit tested in tests/gst-register.test.ts. Cancelled
 * invoices count only in the document summary.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const REGISTER_SECTIONS = ["b2b", "b2cs", "cdnr", "cdnur", "hsn", "docs"] as const;
export type RegisterSection = (typeof REGISTER_SECTIONS)[number];

export const REGISTER_LABELS: Record<RegisterSection, string> = {
  b2b: "B2B invoices",
  b2cs: "B2C (small) summary",
  cdnr: "Credit notes — registered",
  cdnur: "Credit notes — unregistered",
  hsn: "SAC summary",
  docs: "Documents issued",
};

/** One outlet B2C row from gst_outlet_sales(). */
export interface OutletSalesRow {
  sac: string;
  rate: number;
  net: number;
  tax: number;
  bills: number;
}

/** A credit note with the invoice it corrects, which GSTR-1 asks for. */
export type RegisterCreditNote = Pick<
  CreditNote,
  | "number"
  | "series"
  | "seq"
  | "issued_at"
  | "bill_to_name"
  | "bill_to_gstin"
  | "place_of_supply"
  | "is_interstate"
  | "grand_total"
  | "tax_breakdown"
> & { invoice_number: string; invoice_date: string };

export interface RegisterInput {
  invoices: Pick<
    Invoice,
    | "number"
    | "series"
    | "seq"
    | "issued_at"
    | "status"
    | "bill_to_name"
    | "bill_to_gstin"
    | "place_of_supply"
    | "is_interstate"
    | "grand_total"
    | "tax_breakdown"
    | "tax_regime"
  >[];
  creditNotes: RegisterCreditNote[];
  outlets: OutletSalesRow[];
  /** The hotel's place of supply, for outlet sales. */
  placeOfSupply: string;
  /** Local date of a timestamp, in the hotel's time zone. */
  dayOf: (iso: string) => string;
}

export type Grid = { header: string[]; body: (string | number)[][] };

function bandSplit(b: { tax: number; cgst?: number; sgst?: number; igst?: number }, interstate: boolean) {
  if (b.cgst !== undefined || b.igst !== undefined) {
    return { cgst: Number(b.cgst ?? 0), sgst: Number(b.sgst ?? 0), igst: Number(b.igst ?? 0) };
  }
  return splitGst(Number(b.tax), interstate);
}

export function buildRegister(input: RegisterInput): Record<RegisterSection, Grid> {
  const issued = input.invoices.filter((i) => i.status === "issued");
  const b2bInvoices = issued.filter((i) => i.bill_to_gstin);
  const b2cInvoices = issued.filter((i) => !i.bill_to_gstin);

  const b2b: Grid = {
    header: [
      "GSTIN of recipient", "Receiver name", "Invoice number", "Invoice date", "Invoice value",
      "Place of supply", "Reverse charge", "Rate", "Taxable value", "IGST", "CGST", "SGST",
    ],
    body: b2bInvoices.flatMap((i) =>
      i.tax_breakdown.map((b) => {
        const s = bandSplit(b, i.is_interstate);
        return [
          i.bill_to_gstin, i.bill_to_name, i.number, input.dayOf(i.issued_at), Number(i.grand_total),
          i.place_of_supply, "N", Number(b.rate), Number(b.net), s.igst, s.cgst, s.sgst,
        ];
      }),
    ),
  };

  // B2C summed by place of supply and rate.
  const b2cMap = new Map<string, { pos: string; rate: number; net: number; cgst: number; sgst: number; igst: number }>();
  const addB2c = (pos: string, rate: number, net: number, s: { cgst: number; sgst: number; igst: number }) => {
    const key = `${pos}|${rate}`;
    const row = b2cMap.get(key) ?? { pos, rate, net: 0, cgst: 0, sgst: 0, igst: 0 };
    row.net += net;
    row.cgst += s.cgst;
    row.sgst += s.sgst;
    row.igst += s.igst;
    b2cMap.set(key, row);
  };
  for (const i of b2cInvoices) {
    for (const b of i.tax_breakdown) addB2c(i.place_of_supply, Number(b.rate), Number(b.net), bandSplit(b, i.is_interstate));
  }
  for (const o of input.outlets) {
    addB2c(input.placeOfSupply, Number(o.rate), Number(o.net), splitGst(Number(o.tax), false));
  }
  const b2cs: Grid = {
    header: ["Type", "Place of supply", "Rate", "Taxable value", "IGST", "CGST", "SGST"],
    body: [...b2cMap.values()]
      .sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate)
      .map((r) => ["OE", r.pos, r.rate, round2(r.net), round2(r.igst), round2(r.cgst), round2(r.sgst)]),
  };

  const noteRows = (registered: boolean) =>
    input.creditNotes
      .filter((c) => !!c.bill_to_gstin === registered)
      .flatMap((c) =>
        c.tax_breakdown.map((b) => {
          const s = bandSplit(b, c.is_interstate);
          return [
            ...(registered ? [c.bill_to_gstin] : []),
            c.bill_to_name,
            c.number,
            input.dayOf(c.issued_at),
            "C",
            c.invoice_number,
            c.invoice_date,
            Number(c.grand_total),
            c.place_of_supply,
            Number(b.rate),
            Number(b.net),
            s.igst,
            s.cgst,
            s.sgst,
          ];
        }),
      );
  const noteHeader = [
    "Receiver name", "Note number", "Note date", "Note type", "Original invoice", "Original invoice date",
    "Note value", "Place of supply", "Rate", "Taxable value", "IGST", "CGST", "SGST",
  ];
  const cdnr: Grid = { header: ["GSTIN of recipient", ...noteHeader], body: noteRows(true) };
  const cdnur: Grid = { header: noteHeader, body: noteRows(false) };

  // SAC summary: invoices plus outlet sales, less credit notes.
  const hsnMap = new Map<string, { sac: string; rate: number; net: number; cgst: number; sgst: number; igst: number }>();
  const addHsn = (sac: string, rate: number, net: number, s: { cgst: number; sgst: number; igst: number }, sign = 1) => {
    const key = `${sac}|${rate}`;
    const row = hsnMap.get(key) ?? { sac, rate, net: 0, cgst: 0, sgst: 0, igst: 0 };
    row.net += sign * net;
    row.cgst += sign * s.cgst;
    row.sgst += sign * s.sgst;
    row.igst += sign * s.igst;
    hsnMap.set(key, row);
  };
  for (const i of issued) {
    for (const b of i.tax_breakdown) addHsn(b.sac ?? "", Number(b.rate), Number(b.net), bandSplit(b, i.is_interstate));
  }
  for (const o of input.outlets) addHsn(o.sac, Number(o.rate), Number(o.net), splitGst(Number(o.tax), false));
  for (const c of input.creditNotes) {
    for (const b of c.tax_breakdown) addHsn(b.sac ?? "", Number(b.rate), Number(b.net), bandSplit(b, c.is_interstate), -1);
  }
  const hsn: Grid = {
    header: ["SAC", "UQC", "Rate", "Taxable value", "IGST", "CGST", "SGST", "Total value"],
    body: [...hsnMap.values()]
      .filter((r) => round2(r.net) !== 0 || round2(r.cgst + r.sgst + r.igst) !== 0)
      .sort((a, b) => a.sac.localeCompare(b.sac) || a.rate - b.rate)
      .map((r) => [
        r.sac || "—", "NA", r.rate, round2(r.net), round2(r.igst), round2(r.cgst), round2(r.sgst),
        round2(r.net + r.igst + r.cgst + r.sgst),
      ]),
  };

  // Document summary: the range of numbers used in each series this month.
  const series = new Map<string, { kind: string; numbers: { seq: number; number: string }[]; cancelled: number }>();
  const addDoc = (kind: string, s: string, seq: number, number: string, cancelled: boolean) => {
    const key = `${kind}|${s}`;
    const row = series.get(key) ?? { kind, numbers: [], cancelled: 0 };
    row.numbers.push({ seq, number });
    if (cancelled) row.cancelled += 1;
    series.set(key, row);
  };
  for (const i of input.invoices) addDoc("Invoices for outward supply", i.series, i.seq, i.number, i.status === "cancelled");
  for (const c of input.creditNotes) addDoc("Credit notes", c.series, c.seq, c.number, false);
  const docs: Grid = {
    header: ["Nature of document", "From", "To", "Total issued", "Cancelled", "Net issued"],
    body: [...series.values()].map((r) => {
      const sorted = [...r.numbers].sort((a, b) => a.seq - b.seq);
      return [
        r.kind, sorted[0].number, sorted[sorted.length - 1].number, sorted.length, r.cancelled, sorted.length - r.cancelled,
      ];
    }),
  };

  return { b2b, b2cs, cdnr, cdnur, hsn, docs };
}

export interface RegisterTotals {
  b2bCount: number;
  b2bValue: number;
  b2cValue: number;
  creditValue: number;
  outletValue: number;
  taxableNet: number;
  taxNet: number;
}

/** Headline figures for the month, net of credit notes. */
export function registerTotals(input: RegisterInput): RegisterTotals {
  const issued = input.invoices.filter((i) => i.status === "issued");
  const b2b = issued.filter((i) => i.bill_to_gstin);
  const b2c = issued.filter((i) => !i.bill_to_gstin);
  const sumBands = (rows: { tax_breakdown: { net: number; tax: number }[] }[], key: "net" | "tax") =>
    rows.reduce((s, r) => s + r.tax_breakdown.reduce((t, b) => t + Number(b[key]), 0), 0);
  const outletNet = input.outlets.reduce((s, o) => s + Number(o.net), 0);
  const outletTax = input.outlets.reduce((s, o) => s + Number(o.tax), 0);
  return {
    b2bCount: b2b.length,
    b2bValue: round2(b2b.reduce((s, i) => s + Number(i.grand_total), 0)),
    b2cValue: round2(b2c.reduce((s, i) => s + Number(i.grand_total), 0)),
    creditValue: round2(input.creditNotes.reduce((s, c) => s + Number(c.grand_total), 0)),
    outletValue: round2(outletNet + outletTax),
    taxableNet: round2(sumBands(issued, "net") + outletNet - sumBands(input.creditNotes, "net")),
    taxNet: round2(sumBands(issued, "tax") + outletTax - sumBands(input.creditNotes, "tax")),
  };
}
