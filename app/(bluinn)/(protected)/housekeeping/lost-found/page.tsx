import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { todayIn } from "../../../../lib/dates";
import type { LostFoundItem, Room } from "../../../../lib/types";
import { logLostItem, updateLostItem } from "../../../housekeeping-actions";
import {
  Card,
  Field,
  SectionTitle,
  Tag,
  EmptyState,
  inputClass,
  fmtDate,
  Pagination,
  pageParam,
  pageRange,
  pageHref,
  outOfRange,
} from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

export default async function LostFoundPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePermission("housekeeping.lost_found");
  const page = pageParam((await searchParams).page);
  const supabase = await createClient();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);

  const [{ data, error, count }, { data: rooms }] = await Promise.all([
    supabase
      .from("lost_found_items")
      .select("*, rooms(room_number), staff:found_by(full_name), bookings(reference, contact_name)", { count: "exact" })
      .order("found_on", { ascending: false })
      .order("created_at", { ascending: false })
      .range(...pageRange(page)),
    supabase.from("rooms").select("id, room_number").order("room_number"),
  ]);
  if (outOfRange(error)) redirect(pageHref("/housekeeping/lost-found", {}, 1));
  const items = (data ?? []) as (LostFoundItem & {
    staff: { full_name: string } | null;
    bookings: { reference: string; contact_name: string } | null;
  })[];

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <SectionTitle>Log a found item</SectionTitle>
        <ActionForm action={logLostItem} submitLabel="Log item" className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Room">
              <select name="room_id" defaultValue="" className={inputClass}>
                <option value="">Not in a room</option>
                {((rooms ?? []) as Pick<Room, "id" | "room_number">[]).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.room_number}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Or found at">
              <input name="location" placeholder="Lobby, restaurant…" className={inputClass} />
            </Field>
            <Field label="Found on">
              <input type="date" name="found_on" defaultValue={today} className={inputClass} />
            </Field>
          </div>
          <Field label="Description">
            <input name="description" required placeholder="Black phone charger, Samsung" className={inputClass} />
          </Field>
        </ActionForm>
      </Card>

      <Card>
        {items.length === 0 ? (
          <EmptyState message="Nothing here" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((i) => (
              <li key={i.id} className="px-4 py-3">
                <p className="text-sm font-medium text-slate-900">
                  <span className="font-mono text-xs text-slate-500 mr-2">{i.reference}</span>
                  {i.description}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {i.rooms?.room_number ? `Room ${i.rooms.room_number}` : i.location} · found {fmtDate(i.found_on)}
                  {i.staff?.full_name && ` by ${i.staff.full_name}`}
                  {i.storage_location && ` · kept in ${i.storage_location}`}
                  {i.bookings && ` · ${i.bookings.reference} ${i.bookings.contact_name}`}{" "}
                  <Tag tone={i.status === "stored" ? "amber" : i.status === "returned" ? "green" : "neutral"}>
                    {i.status === "stored" ? "Stored" : i.status === "returned" ? `Returned to ${i.returned_to}` : "Disposed"}
                  </Tag>
                </p>
                <details className="mt-2">
                  <summary className="text-[11px] text-brand-700 cursor-pointer">Update</summary>
                  <ActionForm action={updateLostItem} submitLabel="Save" className="mt-2 space-y-2">
                    <input type="hidden" name="id" value={i.id} />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Field label="Category">
                        <select name="category" defaultValue={i.category} className={inputClass}>
                          {["electronics", "documents", "jewellery", "clothing", "money", "other"].map((c) => (
                            <option key={c} value={c}>
                              {c[0].toUpperCase() + c.slice(1)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Kept in">
                        <input name="storage_location" defaultValue={i.storage_location} placeholder="HK office locker 2" className={inputClass} />
                      </Field>
                      <Field label="Guest's booking" hint="Reference, if you know whose it is">
                        <input name="booking_reference" defaultValue={i.bookings?.reference ?? ""} placeholder="BK-1234" className={inputClass} />
                      </Field>
                      <Field label="Status">
                        <select name="status" defaultValue={i.status} className={inputClass}>
                          <option value="stored">Stored</option>
                          <option value="returned">Returned</option>
                          <option value="disposed">Disposed</option>
                        </select>
                      </Field>
                      <Field label="Returned to">
                        <input name="returned_to" defaultValue={i.returned_to} placeholder="Name, and how (courier, in person)" className={inputClass} />
                      </Field>
                      <Field label="Notes">
                        <input name="notes" defaultValue={i.notes} className={inputClass} />
                      </Field>
                    </div>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} total={count ?? 0} path="/housekeeping/lost-found" />
      </Card>
    </div>
  );
}
