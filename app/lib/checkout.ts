/**
 * Check-out and overstay rules shared by the check-out page (which previews
 * them) and the check-out and night-audit actions (which apply them), so the
 * figure the desk is shown is the figure that gets posted. Kept free of the
 * database so it can be tested on its own.
 */
import { addDays, eachNight } from "./dates";
import { invoiceTaxFields } from "./gst";
import type { FolioEntry, NightRate, PropertySettings } from "./types";

/** Every late check-out fee is posted with this description prefix. */
export const LATE_FEE_PREFIX = "Late check-out";
export const EARLY_FEE_PREFIX = "Early check-in";

/**
 * The date the stay ends on (the first night not charged).
 *
 * - Early departure: today, but a same-day departure still pays one night.
 * - On time: the due-out date.
 * - Stayed past due-out: the open business date, so every night the guest
 *   actually stayed is charged. The business date, not the calendar date, so
 *   a guest leaving after midnight but before night audit is not charged a
 *   night the business day has not reached.
 */
export function checkoutDeparture(
  stay: { check_in: string; check_out: string },
  today: string,
  businessDate: string,
): string {
  if (stay.check_out > today) return today > stay.check_in ? today : addDays(stay.check_in, 1);
  return businessDate > stay.check_out ? businessDate : stay.check_out;
}

/**
 * Night audit's answer to a guest still in house on or after their due-out
 * date: the stay runs on through the audited night, at the last night's rate,
 * so the night is charged and the room stays held. Null if not overdue.
 */
export function overstayExtension(
  booking: { check_in: string; check_out: string; quoted_rate: number | null; rate_breakdown: NightRate[] | null },
  day: string,
): { check_out: string; rate_breakdown: NightRate[] } | null {
  if (booking.check_out > day) return null;
  const breakdown = booking.rate_breakdown ?? [];
  const lastRate = breakdown.length ? Number(breakdown[breakdown.length - 1].rate) : Number(booking.quoted_rate ?? 0);
  const have = new Set(breakdown.map((n) => n.date));
  const added = eachNight(booking.check_out, addDays(day, 1))
    .filter((d) => !have.has(d))
    .map((date) => ({ date, rate: lastRate }));
  return { check_out: addDays(day, 1), rate_breakdown: [...breakdown, ...added] };
}

/** Whether today's late check-out fee is already on the folio (a retried check-out). */
export function lateFeePosted(entries: FolioEntry[], today: string): boolean {
  return entries.some(
    (e) => !e.voided_at && e.kind === "fee" && e.stay_date === today && e.description.startsWith(LATE_FEE_PREFIX),
  );
}

/** Whether today's early check-in fee is already on the folio, so a retried check-in does not charge it twice. */
export function earlyFeePosted(entries: FolioEntry[], today: string): boolean {
  return entries.some(
    (e) => !e.voided_at && e.kind === "fee" && e.stay_date === today && e.description.startsWith(EARLY_FEE_PREFIX),
  );
}

/** What the check-out form offers to take: the final balance, with the late fee if it will be charged. */
export function suggestedPayment(projectedBalance: number, lateFeeTotal: number, chargeLateFee: boolean): number {
  const due = projectedBalance + (chargeLateFee ? lateFeeTotal : 0);
  return due > 0 ? Math.round(due * 100) / 100 : 0;
}

/**
 * What stops this hotel issuing any GST invoice at all (no GSTIN, an invoice
 * prefix too long for a GST number), or null. These are settings to fix, not
 * a reason to keep a guest from leaving: check-out completes and says so.
 */
export function propertyInvoiceProblem(settings: PropertySettings): string | null {
  const check = invoiceTaxFields(
    { name: "-", gstin: "", address: "-" },
    {
      regime: settings.tax_regime ?? "gst",
      propertyGstin: settings.gstin,
      propertyStateCode: settings.gst_state_code,
      propertyState: settings.state,
      invoicePrefix: settings.invoice_prefix,
      grandTotal: 0,
    },
  );
  return "error" in check ? check.error : null;
}
