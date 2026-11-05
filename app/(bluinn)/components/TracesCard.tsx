import { ListChecks } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { completeTrace } from "../frontdesk-actions";
import { Card, CardHeader, fmtDateTime, secondaryButtonClass } from "./ui";

type Trace = {
  id: string;
  description: string;
  due_at: string | null;
  rooms: { room_number: string } | null;
  bookings: { contact_name: string } | null;
  departments: { name: string } | null;
};

/**
 * Open traces for a department (0031): the front desk's follow-ups ("extra
 * bed in 204 on the 12th") on the board of the team that does them. Due
 * within the next day, or overdue. Renders nothing when there are none.
 */
export default async function TracesCard({
  supabase,
  departmentMatch,
  untilIso,
}: {
  supabase: SupabaseClient;
  /** Department names to match, case-insensitively ("housekeeping"). */
  departmentMatch: string[];
  /** Show traces due before this moment. */
  untilIso: string;
}) {
  const { data: departments } = await supabase.from("departments").select("id, name");
  const ids = (departments ?? [])
    .filter((d) => departmentMatch.some((m) => String(d.name).toLowerCase().includes(m)))
    .map((d) => d.id as string);
  if (ids.length === 0) return null;

  const { data } = await supabase
    .from("guest_requests")
    .select("id, description, due_at, rooms(room_number), bookings(contact_name), departments(name)")
    .eq("kind", "trace")
    .eq("status", "open")
    .in("department_id", ids)
    .lt("due_at", untilIso)
    .order("due_at");
  const traces = (data ?? []) as unknown as Trace[];
  if (traces.length === 0) return null;

  return (
    <Card>
      <CardHeader icon={<ListChecks />} title="Traces from the front desk" count={traces.length} />
      <ul className="divide-y divide-slate-100">
        {traces.map((t) => {
          const overdue = t.due_at && new Date(t.due_at) < new Date();
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
              <div className="flex-1 min-w-[180px]">
                <p className="text-sm text-slate-900">{t.description}</p>
                <p className="text-[11px] text-slate-500">
                  {t.rooms?.room_number ? `Room ${t.rooms.room_number} · ` : ""}
                  {t.bookings?.contact_name ?? ""}
                  {t.due_at && <span className={overdue ? "text-rose-700 font-medium" : ""}> · {fmtDateTime(t.due_at)}</span>}
                </p>
              </div>
              <form action={completeTrace}>
                <input type="hidden" name="id" value={t.id} />
                <button type="submit" className={`${secondaryButtonClass} !py-1.5`}>
                  Done
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
