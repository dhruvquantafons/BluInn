import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "../../../../../lib/supabase/server";
import { requirePermission } from "../../../../../lib/auth";
import { can } from "../../../../../lib/permissions";
import { getSettings, hhmm, taxSlabsOf } from "../../../../../lib/settings";
import { ancillaryCharge, loadGuestFolio } from "../../../../../lib/folio";
import { timingFee, isLate } from "../../../../../lib/policies";
import { rateForNight } from "../../../../../lib/pricing";
import { splitRoomTax } from "../../../../../lib/tax";
import { todayIn, nowTimeIn, eachNight } from "../../../../../lib/dates";
import { checkoutDeparture, lateFeePosted, propertyInvoiceProblem, suggestedPayment } from "../../../../../lib/checkout";
import { lastBillTo } from "../../../../../lib/invoice-issue";
import type { Booking } from "../../../../../lib/types";
import { PAYMENT_METHOD_CHOICES } from "../../../../../lib/types";
import { checkOut } from "../../../../frontdesk-actions";
import { Card, Field, Check, Notice, fmtDate, fmtMoney, inputClass } from "../../../../components/ui";
import ActionForm from "../../../../components/ActionForm";
import { BillToFields } from "../../../../components/InvoiceCorrections";

export default async function CheckOutPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("frontdesk.checkout");
  const { id } = await params;
  const supabase = await createClient();
  const settings = await getSettings();

  const { data } = await supabase
    .from("bookings")
    .select("*, rooms(id, room_number), room_types(id, name)")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const booking = data as Booking;
  if (booking.status !== "checked_in") redirect(`/bookings/${id}`);

  const today = todayIn(settings.timezone);
  const now = nowTimeIn(settings.timezone);
  // The guest settles their own part; nights the event's organiser pays are
  // billed on the event's invoice (0042).
  const folio = await loadGuestFolio(supabase, id);

  // Preview what check-out will add, so the balance shown is the final one.
  // The same rules as the checkOut action (app/lib/checkout.ts).
  const { data: nextPart } = await supabase
    .from("bookings")
    .select("reference, check_in")
    .eq("split_from_id", id)
    .in("status", ["tentative", "confirmed"])
    .order("check_in")
    .limit(1)
    .maybeSingle();
  let departure = checkoutDeparture(booking, today, settings.business_date);
  if (nextPart && departure > nextPart.check_in) departure = nextPart.check_in;
  const handedOver = Boolean(nextPart && departure === nextPart.check_in);
  const posted = new Set(
    [...folio.entries, ...folio.organiser].filter((e) => e.kind === "room" && !e.voided_at).map((e) => e.stay_date),
  );
  const unposted = eachNight(booking.check_in, departure).filter((n) => !posted.has(n));
  const slabs = taxSlabsOf(settings);
  const unpostedTotal = unposted.reduce((s, n) => {
    const split = splitRoomTax(rateForNight(booking.rate_breakdown, n, booking.quoted_rate), slabs, settings.tax_inclusive);
    return s + (split.net + split.tax) * booking.rooms_count;
  }, 0);

  const late =
    !handedOver && departure >= booking.check_out && departure <= today && isLate(now, settings.check_out_time);
  // A retried check-out has already posted it.
  const feeDone = lateFeePosted(folio.entries, today);
  const lastNight = eachNight(booking.check_in, departure).at(-1) ?? booking.check_in;
  const lateFee = late
    ? timingFee(
        settings.late_checkout_fee_type,
        Number(settings.late_checkout_fee_value),
        rateForNight(booking.rate_breakdown, lastNight, booking.quoted_rate),
      )
    : 0;
  // The fee carries the room's GST, as check-out posts it.
  const lateFeeCharge = ancillaryCharge(lateFee, booking, settings, lastNight);
  const lateFeeTotal = Math.round((lateFeeCharge.amount + lateFeeCharge.tax_amount) * 100) / 100;

  // Nights still to post for an organiser-paid room go to the event, not the guest.
  const { data: group } = booking.group_id
    ? await supabase.from("booking_groups").select("event_id, room_billing").eq("id", booking.group_id).maybeSingle()
    : { data: null };
  const organiserPays = Boolean(group?.event_id && group.room_billing === "organiser");
  const projected = Math.round((folio.totals.balance + (organiserPays ? 0 : unpostedTotal)) * 100) / 100;
  const chargeFee = late && lateFee > 0 && !feeDone;
  const invoiceProblem = can(session, "folio.invoice") ? propertyInvoiceProblem(settings) : null;
  const billTo = await lastBillTo(supabase, booking);

  return (
    <>
      <Link
        href={`/bookings/${id}`}
        className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700 mb-4 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> {booking.reference}
      </Link>

      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Check out {booking.contact_name}</h1>
      <p className="text-sm text-slate-600 mt-1 mb-6">
        Room {booking.rooms?.room_number} · due out {fmtDate(booking.check_out)} by {hhmm(settings.check_out_time)} · now {now}
      </p>

      <div className="space-y-4 max-w-3xl">
        {(folio.organiser.length > 0 || organiserPays) && (
          <Notice tone="info">
            The event&apos;s organiser pays for this room
            {folio.organiser.length > 0 ? ` (${fmtMoney(folio.organiserTotals.charges + folio.organiserTotals.tax)} so far)` : ""}. Its
            nights are billed on the event&apos;s invoice, not settled here; the guest settles only their own extras.
          </Notice>
        )}
        {handedOver && nextPart && (
          <Notice tone="info">
            This stay was split. Checking out ends this part on {fmtDate(departure)} and checks the guest in to{" "}
            {nextPart.reference} in the same room. Their keys keep working and the room is not sent for cleaning.
          </Notice>
        )}
        {departure > booking.check_out && (
          <Notice tone="warn">
            Stayed past the due-out date of {fmtDate(booking.check_out)}: the nights up to {fmtDate(departure)} are charged.
          </Notice>
        )}
        {invoiceProblem && (
          <Notice tone="warn">
            No tax invoice can be issued yet: {invoiceProblem} The guest can still check out; issue the invoice from the
            folio once that is set.
          </Notice>
        )}
        {booking.check_out > today && (
          <Notice tone="warn">
            Early departure: the stay will end today, {fmtDate(departure)}. Nights after that are released and not charged.
          </Notice>
        )}

        <Card className="p-5">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-xs text-slate-500 font-semibold">Posted so far</dt>
              <dd>{fmtMoney(folio.totals.charges + folio.totals.tax)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 font-semibold">Nights still to post</dt>
              <dd>
                {unposted.length} · {fmtMoney(Math.round(unpostedTotal * 100) / 100)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 font-semibold">Paid</dt>
              <dd>{fmtMoney(folio.totals.payments)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 font-semibold">Balance to settle</dt>
              <dd className={projected > 0 ? "text-rose-700 font-medium" : "text-emerald-700 font-medium"}>
                {fmtMoney(projected)}
                {chargeFee ? ` + late fee ${fmtMoney(lateFeeTotal)}` : ""}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-slate-500">
            <Link href={`/bookings/${id}/folio`} className="text-brand-700">
              View the itemised bill
            </Link>
          </p>
        </Card>

        <Card className="p-5">
          <ActionForm action={checkOut} submitLabel="Check out" pendingLabel="Checking out…">
            <input type="hidden" name="booking_id" value={id} />

            {chargeFee && (
              <Check
                name="apply_late_fee"
                defaultChecked
                label={`Charge late check-out (${now}, after ${hhmm(settings.check_out_time)}): ${fmtMoney(lateFeeTotal)} incl. tax`}
              />
            )}

            {can(session, "folio.payment") && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Payment now (₹)">
                  <input
                    type="number"
                    name="payment_amount"
                    min={0}
                    step="0.01"
                    defaultValue={suggestedPayment(projected, lateFeeTotal, chargeFee) || undefined}
                    className={inputClass}
                  />
                </Field>
                <Field label="Method">
                  <select name="payment_method" defaultValue="" className={inputClass}>
                    <option value="">—</option>
                    {PAYMENT_METHOD_CHOICES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reference">
                  <input name="payment_reference" className={inputClass} />
                </Field>
              </div>
            )}

            {can(session, "folio.adjust") && (
              <Field label="Allow departure with a balance — reason" hint="Only if the balance cannot be settled now. Recorded in the audit log.">
                <input name="balance_reason" className={inputClass} />
              </Field>
            )}

            {can(session, "folio.invoice") && (
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <p className="text-xs text-slate-600">
                  A tax invoice is issued for each folio as the guest checks out. For a business guest, add the GSTIN and address.
                </p>
                <BillToFields defaults={billTo} taxRegime={settings.tax_regime ?? "gst"} />
              </div>
            )}

            <Check
              name="email_bill"
              defaultChecked={Boolean(booking.contact_email)}
              label={`Express check-out: email the final bill${booking.contact_email ? ` to ${booking.contact_email}` : " (no email on file)"}`}
            />
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
