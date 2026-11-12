import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "./db-errors";
import { invoiceLines, invoiceTotals, taxBreakdown, gstTotals, formatInvoiceNumber, financialYearOf, foliosToInvoice } from "./invoices";
import { invoiceTaxFields } from "./gst";
import { todayIn } from "./dates";
import type { Booking, FolioEntry, PropertySettings } from "./types";

export interface BillTo {
  name: string;
  gstin: string;
  address: string;
}

/**
 * Issues a GST invoice for one folio — from the Billing panel, and at check-out
 * for every folio holding charges. The number is claimed by the database so
 * it is sequential and never repeated, and the lines, totals and the
 * customer's details are frozen onto the row: a later change to the guest
 * record cannot alter a tax document that has already been given out.
 *
 * The caller checks folio.invoice; the database checks it again (RLS).
 */
export async function issueFolioInvoice(
  supabase: SupabaseClient,
  settings: PropertySettings,
  folioId: string,
  billTo: BillTo,
  staffId: string,
): Promise<{ error: string; overAllowed?: true } | { id: string; number: string; bookingId: string }> {
  const { data: folio } = await supabase
    .from("folios")
    .select("id, booking_id, label")
    .eq("id", folioId)
    .maybeSingle();
  if (!folio) return { error: "Folio not found." };

  const { data: existing } = await supabase
    .from("invoices")
    .select("number")
    .eq("folio_id", folioId)
    .eq("status", "issued")
    .maybeSingle();
  if (existing) return { error: `This folio already has invoice ${existing.number}. Cancel it before issuing another.` };

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("*, guests(full_name)")
    .eq("id", folio.booking_id)
    .maybeSingle();
  if (!bookingRow) return { error: "Booking not found." };
  const booking = bookingRow as Booking;

  const { data: entryRows } = await supabase
    .from("folio_entries")
    .select("*")
    .eq("folio_id", folioId)
    .order("created_at");
  const entries = (entryRows ?? []) as FolioEntry[];

  const regime = settings.tax_regime ?? "gst";
  const draft = invoiceLines(entries, { regime });
  if (draft.length === 0) return { error: "There is nothing to invoice on this folio yet." };
  const draftTotals = invoiceTotals(draft);

  // Who it is to, checked against what a tax invoice must carry. A business
  // guest gives their GSTIN; place of supply is always the hotel's state.
  const tax = invoiceTaxFields(
    {
      name: billTo.name || booking.contact_name,
      gstin: billTo.gstin,
      address: billTo.address,
    },
    {
      regime,
      propertyGstin: settings.gstin,
      propertyStateCode: settings.gst_state_code,
      propertyState: settings.state,
      invoicePrefix: settings.invoice_prefix,
      grandTotal: draftTotals.grand,
    },
  );
  if ("error" in tax) return { error: tax.error };

  const lines = invoiceLines(entries, { regime, interstate: tax.fields.is_interstate });
  const totals = invoiceTotals(lines);
  if (totals.net < 0) return { error: "Allowances on this folio are larger than its charges.", overAllowed: true };
  const bands = taxBreakdown(lines);
  const split = gstTotals(lines);

  // The number is claimed inside the database so two people issuing at the
  // same moment cannot take the same sequence.
  const fy = financialYearOf(todayIn(settings.timezone));
  const { data: seq, error: seqError } = await supabase.rpc("next_invoice_number", {
    p_series: settings.invoice_prefix || "INV",
    p_fy: fy,
  });
  if (seqError || typeof seq !== "number") {
    return { error: friendlyDbError(seqError?.message ?? "Could not allocate an invoice number.") };
  }

  // If the guest settled any part of this folio in another currency, note
  // that currency and the rate used on the invoice, so a foreign-currency
  // copy of the document always reprints with the same numbers. The invoice
  // itself stays denominated in the property's own currency.
  const settledIn = entries.find((e) => !e.voided_at && e.kind === "payment" && e.fx_currency);

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      number: formatInvoiceNumber(settings.invoice_prefix || "INV", fy, seq),
      series: settings.invoice_prefix || "INV",
      financial_year: fy,
      seq,
      booking_id: folio.booking_id,
      folio_id: folioId,
      ...tax.fields,
      currency: settings.currency,
      net_total: totals.net,
      tax_total: totals.tax,
      grand_total: totals.grand,
      cgst_total: split.cgst,
      sgst_total: split.sgst,
      igst_total: split.igst,
      tax_breakdown: bands,
      lines,
      fx_currency: settledIn?.fx_currency ?? null,
      fx_rate: settledIn?.fx_rate ?? null,
      issued_by: staffId,
    })
    .select("id, number")
    .single();
  if (error) return { error: friendlyDbError(error.message) };

  return { id: invoice.id as string, number: invoice.number as string, bookingId: folio.booking_id as string };
}

/**
 * How a returning business guest was billed last time, so check-out and the
 * folio's invoice form start from their GSTIN and address rather than a
 * bare name (a B2C invoice to a company is a credit note later).
 */
export async function lastBillTo(
  supabase: SupabaseClient,
  booking: Pick<Booking, "guest_id" | "contact_name">,
): Promise<BillTo> {
  const billTo: BillTo = { name: booking.contact_name, gstin: "", address: "" };
  if (!booking.guest_id) return billTo;
  const { data: stays } = await supabase.from("bookings").select("id").eq("guest_id", booking.guest_id);
  const ids = (stays ?? []).map((b) => b.id as string);
  if (ids.length === 0) return billTo;
  const { data: last } = await supabase
    .from("invoices")
    .select("bill_to_name, bill_to_gstin, bill_to_address")
    .in("booking_id", ids)
    .neq("bill_to_gstin", "")
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return last ? { name: last.bill_to_name, gstin: last.bill_to_gstin, address: last.bill_to_address } : billTo;
}

/**
 * Checks a bill-to against what a tax invoice must carry, before anything is
 * posted, so check-out can refuse cleanly instead of half-way through.
 * `grandTotal` is the largest invoice the stay will produce.
 */
export function billToProblem(
  settings: PropertySettings,
  billTo: BillTo,
  contactName: string,
  grandTotal: number,
): string | null {
  const tax = invoiceTaxFields(
    { name: billTo.name || contactName, gstin: billTo.gstin, address: billTo.address },
    {
      regime: settings.tax_regime ?? "gst",
      propertyGstin: settings.gstin,
      propertyStateCode: settings.gst_state_code,
      propertyState: settings.state,
      invoicePrefix: settings.invoice_prefix,
      grandTotal,
    },
  );
  return "error" in tax ? tax.error : null;
}

/**
 * Issues an invoice for every folio of a stay that holds charges and has
 * none yet: at check-out, after a cancellation or no-show penalty, and when
 * a split stay hands over. Stops at the first refusal and says which.
 *
 * A folio whose allowances outweigh its charges has nothing to put on a tax
 * invoice, so it is skipped and named in `skipped` rather than refusing the
 * whole check-out (0043); the desk corrects it from the folio.
 */
export async function issueOutstandingInvoices(
  supabase: SupabaseClient,
  settings: PropertySettings,
  bookingId: string,
  billTo: BillTo,
  staffId: string,
): Promise<{ issued: string[]; skipped: string[]; error: string | null }> {
  const [{ data: entryRows }, { data: issuedRows }, { data: eventFolios }] = await Promise.all([
    supabase.from("folio_entries").select("folio_id, kind, voided_at, amount, tax_amount").eq("booking_id", bookingId),
    supabase.from("invoices").select("folio_id").eq("booking_id", bookingId).eq("status", "issued"),
    // An organiser folio is invoiced on its event's invoice, never to the guest (0042).
    supabase.from("folios").select("id").eq("booking_id", bookingId).not("event_id", "is", null),
  ]);
  const toInvoice = foliosToInvoice(
    (entryRows ?? []) as Pick<FolioEntry, "folio_id" | "kind" | "voided_at" | "amount" | "tax_amount">[],
    new Set([...(issuedRows ?? []).map((r) => r.folio_id as string), ...(eventFolios ?? []).map((f) => f.id as string)]),
  );
  const issued: string[] = [];
  const skipped: string[] = [];
  for (const folioId of toInvoice) {
    const r = await issueFolioInvoice(supabase, settings, folioId, billTo, staffId);
    if ("error" in r) {
      if (r.overAllowed) {
        skipped.push(folioId);
        continue;
      }
      return { issued, skipped, error: r.error };
    }
    issued.push(r.number);
  }
  return { issued, skipped, error: null };
}
