import type { Booking } from "../../../../lib/types";
import { STAY_TYPE_LABELS } from "../../../../lib/types";
import { updateArrangements } from "../../../booking-actions";
import { Card, Check, Field, SectionTitle, fmtDateTime, inputClass, secondaryButtonClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

/** An instant as the hotel's wall clock, for a datetime-local input. */
function localInput(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * The parts of a stay that are arrangements rather than the booking itself
 * (0031): transfers, when the deposit is due, and whether the stay is paid,
 * complimentary or house use.
 */
export default function ArrangementsForm({
  booking,
  timeZone,
  canComp,
}: {
  booking: Booking;
  timeZone: string;
  canComp: boolean;
}) {
  const stayType = booking.stay_type ?? "paid";
  return (
    <Card className="p-5">
      <SectionTitle>Arrangements</SectionTitle>
      <ActionForm action={updateArrangements} submitLabel="Save arrangements" submitClassName={secondaryButtonClass} className="space-y-4">
        <input type="hidden" name="id" value={booking.id} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Check name="pickup_required" defaultChecked={booking.pickup_required} label="Pick-up on arrival" />
          <Field label="Pick-up at">
            <input type="datetime-local" name="pickup_at" defaultValue={localInput(booking.pickup_at, timeZone)} className={inputClass} />
          </Field>
          <Field label="Flight, train or address">
            <input name="pickup_details" defaultValue={booking.pickup_details ?? ""} placeholder="AI 865, Terminal 2" className={inputClass} />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Check name="drop_required" defaultChecked={booking.drop_required} label="Drop on departure" />
          <Field label="Drop at">
            <input type="datetime-local" name="drop_at" defaultValue={localInput(booking.drop_at, timeZone)} className={inputClass} />
          </Field>
          <Field label="Flight, train or address">
            <input name="drop_details" defaultValue={booking.drop_details ?? ""} className={inputClass} />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Deposit due by" hint="Listed on the front desk from three days before.">
            <input type="date" name="deposit_due_on" defaultValue={booking.deposit_due_on ?? ""} className={inputClass} />
          </Field>
          {canComp ? (
            <>
              <Field label="Stay type" hint="Complimentary and house-use nights are charged at zero.">
                <select name="stay_type" defaultValue={stayType} className={inputClass}>
                  {Object.entries(STAY_TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason">
                <input name="comp_reason" defaultValue={booking.comp_reason ?? ""} placeholder="Owner's guest, travel writer…" className={inputClass} />
              </Field>
            </>
          ) : (
            stayType !== "paid" && (
              <p className="text-sm text-slate-700 sm:col-span-2 pt-6">
                {STAY_TYPE_LABELS[stayType]}: {booking.comp_reason}
              </p>
            )
          )}
        </div>
        {stayType !== "paid" && booking.comp_approved_at && (
          <p className="text-[11px] text-slate-500">Approved {fmtDateTime(booking.comp_approved_at)}.</p>
        )}
      </ActionForm>
    </Card>
  );
}
