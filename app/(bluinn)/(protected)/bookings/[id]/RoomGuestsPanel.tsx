import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_TYPE_LABELS, type Guest } from "../../../../lib/types";
import { addRoomGuest, removeRoomGuest } from "../../../frontdesk-actions";
import { Card, Field, SectionTitle, Tag, inputClass, secondaryButtonClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

type RoomGuest = {
  guest_id: string;
  is_primary: boolean;
  guests: Pick<Guest, "id" | "full_name" | "nationality" | "gender" | "date_of_birth"> | null;
};

/**
 * Everyone staying in the room, each with their own profile and ID (0030).
 */
export default async function RoomGuestsPanel({
  supabase,
  bookingId,
  canEdit,
}: {
  supabase: SupabaseClient;
  bookingId: string;
  canEdit: boolean;
}) {
  const { data: rows } = await supabase
    .from("booking_guests")
    .select("guest_id, is_primary, guests(id, full_name, nationality, gender, date_of_birth)")
    .eq("booking_id", bookingId)
    .order("added_at");
  const guests = (rows ?? []) as unknown as RoomGuest[];

  return (
    <Card className="p-5">
      <SectionTitle>Guests in the room</SectionTitle>

      {guests.length === 0 ? (
        <p className="text-sm text-slate-500 mb-4">No guest profile yet. One is created at check-in.</p>
      ) : (
        <ul className="divide-y divide-slate-100 mb-4">
          {guests.map((g) => (
            <li key={g.guest_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Link href={`/guests/${g.guest_id}`} className="font-medium text-slate-900 hover:text-brand-700">
                {g.guests?.full_name ?? "Guest"}
              </Link>
              {g.is_primary && <Tag tone="blue">Main guest</Tag>}
              <span className="text-xs text-slate-500">
                {g.guests?.nationality}
                {g.guests?.gender ? ` · ${g.guests.gender}` : ""}
              </span>
              {canEdit && !g.is_primary && (
                <ActionForm
                  action={removeRoomGuest}
                  submitLabel="Remove"
                  submitClassName="text-[11px] text-slate-500 hover:text-rose-700 cursor-pointer"
                  className="ml-auto"
                  confirmMessage={`Remove ${g.guests?.full_name ?? "this guest"} from the stay?`}
                >
                  <input type="hidden" name="booking_id" value={bookingId} />
                  <input type="hidden" name="guest_id" value={g.guest_id} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <details>
          <summary className="text-xs font-medium text-brand-700 cursor-pointer">Add a guest sharing the room</summary>
          <ActionForm action={addRoomGuest} submitLabel="Add guest" submitClassName={secondaryButtonClass} className="space-y-3 mt-3">
            <input type="hidden" name="booking_id" value={bookingId} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Name as on ID">
                <input name="full_name" required className={inputClass} />
              </Field>
              <Field label="Nationality">
                <input name="nationality" required className={inputClass} />
              </Field>
              <Field label="Gender">
                <select name="gender" defaultValue="" className={inputClass}>
                  <option value="">—</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Field label="ID type">
                <select name="id_type" required defaultValue="" className={inputClass}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {Object.entries(ID_TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ID number">
                <input name="id_number" required autoComplete="off" className={inputClass} />
              </Field>
              <Field label="Issuing country">
                <input name="issuing_country" className={inputClass} />
              </Field>
              <Field label="Date of birth">
                <input type="date" name="date_of_birth" className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Passport expiry" hint="Foreign nationals.">
                <input type="date" name="id_expiry" className={inputClass} />
              </Field>
              <Field label="Visa number" hint="Foreign nationals.">
                <input name="visa_number" className={inputClass} />
              </Field>
            </div>
          </ActionForm>
        </details>
      )}
    </Card>
  );
}
