import { splitGst, type GstSplit } from "./gst";
import type { FolioEntry, InvoiceLine, TaxBand, TaxRegime } from "./types";

/**
 * Turning a folio into a tax invoice (Module 7).
 *
 * An invoice bills the *charges* on a folio — rooms, fees, extras, penalties.
 * Payments are not lines on it; they decide how much of it is still owed. The
 * rate-wise summary (how much was taxed at 5%, how much at 18%) is what a GST
 * invoice has to show, so it is computed here and frozen onto the invoice row.
 *
 * These are pure functions with no database access, so the arithmetic is unit
 * tested in tests/billing.test.ts.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Kinds that appear on an invoice. Credits are settlement, not billing. */
const BILLABLE = new Set(["room", "fee", "penalty", "extra"]);

export interface InvoiceLineOptions {
  /** GST invoices split each line's tax into CGST/SGST or IGST (0036). */
  regime?: TaxRegime;
  interstate?: boolean;
}

/** An allowance that names the charge it reduces is a discount on the bill. */
export function isAllowance(e: Pick<FolioEntry, "kind" | "applies_to">): boolean {
  return e.kind === "adjustment" && !!e.applies_to;
}

/** GST lines carry their SAC code and the tax split; plain ones neither. */
function withSplit(line: InvoiceLine, opts: InvoiceLineOptions): InvoiceLine {
  if (opts.regime !== "gst") {
    const plain = { ...line };
    delete plain.sac;
    return plain;
  }
  return { ...line, sac: line.sac ?? "", ...splitGst(line.tax, !!opts.interstate) };
}

/**
 * The lines of an invoice: every charge on the folio, then any allowance
 * against one of those charges as a negative line at the charge's rate. GST
 * treats a discount given before the invoice as lowering the taxable value,
 * which is what the negative line does.
 */
export function invoiceLines(entries: FolioEntry[], opts: InvoiceLineOptions = {}): InvoiceLine[] {
  const live = entries.filter((e) => !e.voided_at);
  const charges = live
    .filter((e) => BILLABLE.has(e.kind))
    .map((e) =>
      withSplit(
        {
          date: e.stay_date ?? e.created_at.slice(0, 10),
          description: e.description || e.kind,
          kind: e.kind,
          net: round2(Number(e.amount)),
          tax_rate: Number(e.tax_rate),
          tax: round2(Number(e.tax_amount)),
          total: round2(Number(e.amount) + Number(e.tax_amount)),
          sac: e.sac_code ?? "",
          dept: e.revenue_dept ?? null,
        },
        opts,
      ),
    );
  const allowances = live.filter(isAllowance).map((e) =>
    withSplit(
      {
        date: e.created_at.slice(0, 10),
        description: `Allowance: ${e.description || "discount"}`,
        kind: "allowance",
        net: -round2(Number(e.amount) - Number(e.tax_amount)),
        tax_rate: Number(e.tax_rate),
        tax: -round2(Number(e.tax_amount)),
        total: -round2(Number(e.amount)),
        sac: e.sac_code ?? "",
        dept: e.revenue_dept ?? null,
      },
      opts,
    ),
  );
  return [...charges, ...allowances];
}

/**
 * How much was charged at each tax rate, lowest rate first. Lines that carry
 * a SAC code (GST invoices) are grouped by code and rate, with the split.
 */
export function taxBreakdown(lines: InvoiceLine[]): TaxBand[] {
  const bands = new Map<string, TaxBand>();
  for (const l of lines) {
    const key = `${l.sac ?? ""}|${l.tax_rate}`;
    const band = bands.get(key) ?? {
      rate: l.tax_rate,
      net: 0,
      tax: 0,
      ...(l.sac !== undefined ? { sac: l.sac } : {}),
      ...(l.cgst !== undefined ? { cgst: 0, sgst: 0, igst: 0 } : {}),
    };
    band.net += l.net;
    band.tax += l.tax;
    if (band.cgst !== undefined) {
      band.cgst += l.cgst ?? 0;
      band.sgst = (band.sgst ?? 0) + (l.sgst ?? 0);
      band.igst = (band.igst ?? 0) + (l.igst ?? 0);
    }
    bands.set(key, band);
  }
  return [...bands.values()]
    .map((b) => ({
      ...b,
      net: round2(b.net),
      tax: round2(b.tax),
      ...(b.cgst !== undefined ? { cgst: round2(b.cgst), sgst: round2(b.sgst ?? 0), igst: round2(b.igst ?? 0) } : {}),
    }))
    .filter((b) => b.net !== 0 || b.tax !== 0)
    .sort((a, b) => (a.sac ?? "").localeCompare(b.sac ?? "") || a.rate - b.rate);
}

/** CGST, SGST and IGST across the lines of a GST invoice. */
export function gstTotals(lines: InvoiceLine[]): GstSplit {
  return {
    cgst: round2(lines.reduce((s, l) => s + (l.cgst ?? 0), 0)),
    sgst: round2(lines.reduce((s, l) => s + (l.sgst ?? 0), 0)),
    igst: round2(lines.reduce((s, l) => s + (l.igst ?? 0), 0)),
  };
}

export interface InvoiceTotals {
  net: number;
  tax: number;
  grand: number;
}

export function invoiceTotals(lines: InvoiceLine[]): InvoiceTotals {
  const net = round2(lines.reduce((s, l) => s + l.net, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  return { net, tax, grand: round2(net + tax) };
}

/**
 * How much of this folio has already been paid, for the "balance due" line.
 * An allowance against a charge is already a discount line on the invoice,
 * so it is not counted again here.
 */
export function amountPaid(entries: FolioEntry[]): number {
  return round2(
    entries
      .filter((e) => !e.voided_at && (e.kind === "payment" || (e.kind === "adjustment" && !isAllowance(e))))
      .reduce((s, e) => s + Number(e.amount), 0) -
      entries
        .filter((e) => !e.voided_at && e.kind === "refund")
        .reduce((s, e) => s + Number(e.amount) + Number(e.tax_amount), 0),
  );
}

/**
 * The printed number: prefix, financial year and a zero-padded sequence, e.g.
 * INV/2026-27/0001. The sequence comes from the database, which is what makes
 * it sequential and non-repeating.
 */
export function formatInvoiceNumber(prefix: string, financialYear: string, seq: number) {
  return `${prefix}/${financialYear}/${String(seq).padStart(4, "0")}`;
}

/** Indian financial year, 1 April to 31 March, written "2026-27". */
export function financialYearOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * Module 7: "Refunds above a set amount require manager or finance-head
 * approval before processing." At or above the threshold, someone else has to
 * approve. A threshold of zero means every refund does.
 */
export function refundNeedsApproval(amount: number, threshold: number): boolean {
  return amount >= threshold;
}
