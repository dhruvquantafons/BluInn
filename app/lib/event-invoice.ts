import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "./db-errors";
import { financialYearOf, formatInvoiceNumber, gstTotals, invoiceLines as folioInvoiceLines, invoiceTotals, taxBreakdown } from "./invoices";
import { invoiceTaxFields, splitGst } from "./gst";
import { clientName } from "./events";
import { todayIn } from "./dates";
import type { EventBooking, FolioEntry, InvoiceLine, PropertySettings, TaxBand } from "./types";

/**
 * Issues an event's own GST invoice: from the event's invoice form, when the
 * event is closed off (0041), and when the last of its organiser-paid rooms
 * checks out (0042). Refuses an event already invoiced or billed to a room.
 *
 * An event whose organiser pays for its guests' rooms (0042) carries those
 * rooms' nights too: the lines of its "Organiser" folios, as accommodation
 * with their own SAC, next to the hall and catering. It waits until every one
 * of those rooms has checked out, so no night is left off.
 */
export async function invoiceEvent(
  supabase: SupabaseClient,
  settings: PropertySettings,
  staffId: string,
  id: string,
  billTo: { name: string; gstin: string; address: string },
): Promise<{ error: string } | { number: string }> {

  const { data: row } = await supabase
    .from("event_bookings")
    .select("*, guests(full_name), event_spaces(name)")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { error: "Event not found." };
  const event = row as EventBooking & { event_spaces: { name: string } | null };

  if (event.status !== "confirmed" && event.status !== "completed") {
    return { error: "Confirm the event before invoicing it." };
  }

  const { data: existing } = await supabase
    .from("invoices")
    .select("number")
    .eq("event_id", id)
    .eq("status", "issued")
    .maybeSingle();
  if (existing) {
    return { error: `This event already has invoice ${existing.number}. Cancel it before issuing another.` };
  }

  // An event billed to a guest's room is invoiced on their folio (0041).
  const { data: onFolio } = await supabase
    .from("event_payments")
    .select("id")
    .eq("event_id", id)
    .eq("kind", "room_charge")
    .is("voided_at", null)
    .limit(1);
  if ((onFolio ?? []).length > 0) {
    return { error: "This event is billed to a guest's room, so it is invoiced on their folio, not on its own." };
  }

  // The bands come from the database, so the invoice cannot disagree with the
  // event or with the tax summary report.
  const { data: bandRows, error: bandError } = await supabase.rpc("event_tax_bands", { p_event: id });
  if (bandError) return { error: friendlyDbError(bandError.message) };
  const bands = ((bandRows ?? []) as TaxBand[]).map((b) => ({
    rate: Number(b.rate),
    net: Number(b.net),
    tax: Number(b.tax),
  }));

  // Rooms the organiser pays for (0042): wait for every one of them to leave,
  // then bill their nights on this invoice.
  const { data: organiserGroup } = await supabase
    .from("booking_groups")
    .select("id")
    .eq("event_id", id)
    .eq("room_billing", "organiser")
    .maybeSingle();
  let roomEntries: FolioEntry[] = [];
  if (organiserGroup) {
    const { data: stillHere } = await supabase
      .from("bookings")
      .select("reference")
      .eq("group_id", organiserGroup.id)
      .in("status", ["tentative", "confirmed", "checked_in"]);
    if ((stillHere ?? []).length > 0) {
      return {
        error: `The organiser pays for this event's rooms, so the invoice waits until they have all checked out (${(stillHere ?? []).map((b) => b.reference).join(", ")} still to go). It is issued automatically when the last one leaves.`,
      };
    }
    const { data: folios } = await supabase.from("folios").select("id").eq("event_id", id);
    const folioIds = (folios ?? []).map((f) => f.id as string);
    if (folioIds.length > 0) {
      const { data: rows } = await supabase.from("folio_entries").select("*").in("folio_id", folioIds).order("stay_date");
      roomEntries = (rows ?? []) as FolioEntry[];
    }
  }

  const regime = settings.tax_regime ?? "gst";
  const roomDraft = folioInvoiceLines(roomEntries, { regime });
  if (bands.length === 0 && roomDraft.length === 0) return { error: "There is nothing to invoice on this event yet." };
  const grand =
    Math.round((bands.reduce((s, b) => s + b.net + b.tax, 0) + invoiceTotals(roomDraft).grand) * 100) / 100;
  const tax = invoiceTaxFields(
    {
      name: billTo.name || clientName(event),
      gstin: billTo.gstin,
      address: billTo.address,
    },
    {
      regime,
      propertyGstin: settings.gstin,
      propertyStateCode: settings.gst_state_code,
      propertyState: settings.state,
      invoicePrefix: settings.invoice_prefix,
      grandTotal: grand,
    },
  );
  if ("error" in tax) return { error: tax.error };

  const invoiceLines: InvoiceLine[] = bands.map((b) => {
    const line: InvoiceLine = {
      date: event.event_date,
      description:
        `${event.title} — ${event.event_spaces?.name ?? "Event"} on ${event.event_date}` +
        (b.rate ? ` (taxed at ${b.rate}%)` : ""),
      kind: "event",
      net: b.net,
      tax_rate: b.rate,
      tax: b.tax,
      total: Math.round((b.net + b.tax) * 100) / 100,
      dept: "events",
    };
    return regime === "gst"
      ? { ...line, sac: settings.sac_event, ...splitGst(b.tax, tax.fields.is_interstate) }
      : line;
  });
  // The rooms' nights, as accommodation lines with their own SAC.
  invoiceLines.push(...folioInvoiceLines(roomEntries, { regime, interstate: tax.fields.is_interstate }));
  const totals = invoiceTotals(invoiceLines);
  const split = gstTotals(invoiceLines);

  const fy = financialYearOf(todayIn(settings.timezone));
  const { data: seq, error: seqError } = await supabase.rpc("next_invoice_number", {
    p_series: settings.invoice_prefix || "INV",
    p_fy: fy,
  });
  if (seqError || typeof seq !== "number") {
    return { error: friendlyDbError(seqError?.message ?? "Could not allocate an invoice number.") };
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      number: formatInvoiceNumber(settings.invoice_prefix || "INV", fy, seq),
      series: settings.invoice_prefix || "INV",
      financial_year: fy,
      seq,
      event_id: id,
      ...tax.fields,
      currency: settings.currency,
      net_total: totals.net,
      tax_total: totals.tax,
      grand_total: totals.grand,
      cgst_total: split.cgst,
      sgst_total: split.sgst,
      igst_total: split.igst,
      tax_breakdown: taxBreakdown(invoiceLines),
      lines: invoiceLines,
      issued_by: staffId,
    })
    .select("number")
    .single();
  if (error) return { error: friendlyDbError(error.message) };
  return { number: invoice.number as string };
}
