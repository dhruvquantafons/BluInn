import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { addDays, todayIn, zonedTime } from "../../../../lib/dates";
import type { Department, ShiftType } from "../../../../lib/types";
import { WEEKDAY_LABELS } from "../../../../lib/types";
import { Card, EmptyState, tableHeadClass, fmtDate, Pagination, pageParam, pageRange, pageHref, outOfRange } from "../../../components/ui";

type Person = {
  id: string;
  full_name: string;
  email: string;
  job_title: string;
  employee_code: string | null;
  department_id: string | null;
  default_shift_id: string | null;
  weekly_off: number | null;
  joining_date: string | null;
};

export default async function HrStaffPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAnyPermission(["hr.view", "hr.manage"]);
  const page = pageParam((await searchParams).page);
  const supabase = await createClient();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const from = addDays(today, -29);
  const since = zonedTime(from, "00:00", settings.timezone).toISOString();

  const [{ data: people, error, count }, { data: depts }, { data: types }] = await Promise.all([
    supabase
      .from("staff")
      .select("id, full_name, email, job_title, employee_code, department_id, default_shift_id, weekly_off, joining_date", { count: "exact" })
      .eq("is_active", true)
      .order("full_name")
      .order("id")
      .range(...pageRange(page)),
    supabase.from("departments").select("*").order("sort_order"),
    supabase.from("shift_types").select("*"),
  ]);
  if (outOfRange(error)) redirect(pageHref("/hr/staff", {}, 1));

  // The 30-day stats are loaded for the people on this page only.
  const ids = ((people ?? []) as Person[]).map((p) => p.id);
  const none = { data: [] as never[] };
  const [{ data: att }, { data: hk }, { data: mt }, { data: fb }] = ids.length
    ? await Promise.all([
        supabase.from("attendance").select("staff_id, work_date").in("staff_id", ids).gte("work_date", from),
        supabase.from("housekeeping_tasks").select("completed_by").in("completed_by", ids).gte("completed_at", since),
        supabase.from("maintenance_tickets").select("resolved_by").in("resolved_by", ids).eq("status", "resolved").gte("resolved_at", since),
        supabase.from("staff_feedback").select("staff_id, rating").in("staff_id", ids).gte("created_at", since),
      ])
    : [none, none, none, none];
  const staff = (people ?? []) as Person[];
  const deptName = new Map(((depts ?? []) as Department[]).map((d) => [d.id, d.name]));
  const shiftName = new Map(((types ?? []) as ShiftType[]).map((t) => [t.id, t.name]));
  const daysPresent = (id: string) => new Set((att ?? []).filter((a) => a.staff_id === id).map((a) => a.work_date)).size;
  const tasks = (id: string) =>
    (hk ?? []).filter((t) => t.completed_by === id).length + (mt ?? []).filter((t) => t.resolved_by === id).length;
  const rating = (id: string) => {
    const mine = (fb ?? []).filter((f) => f.staff_id === id);
    return mine.length ? `${(mine.reduce((s, f) => s + f.rating, 0) / mine.length).toFixed(1)} ★ (${mine.length})` : "—";
  };

  return (
    <Card>
      {staff.length === 0 ? (
        <EmptyState message="No active staff" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={tableHeadClass}>
                <th className="px-4 py-2.5 font-medium">Staff</th>
                <th className="px-4 py-2.5 font-medium">Department</th>
                <th className="px-4 py-2.5 font-medium">Shift pattern</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5 font-medium" title="Last 30 days">Days present</th>
                <th className="px-4 py-2.5 font-medium" title="Cleans completed and maintenance tickets resolved, last 30 days">Tasks done</th>
                <th className="px-4 py-2.5 font-medium" title="Last 30 days">Guest rating</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {staff.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5">
                    <Link href={`/hr/staff/${p.id}`} className="font-medium text-slate-900 hover:text-brand-800">
                      {p.full_name || p.email}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {[p.employee_code, p.job_title].filter(Boolean).join(" · ") || "No employee ID yet"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{p.department_id ? deptName.get(p.department_id) : "—"}</td>
                  <td className="px-4 py-2.5">
                    {p.default_shift_id ? shiftName.get(p.default_shift_id) : "—"}
                    {p.weekly_off !== null && <span className="block text-xs text-slate-500">Off {WEEKDAY_LABELS[p.weekly_off]}</span>}
                  </td>
                  <td className="px-4 py-2.5">{p.joining_date ? fmtDate(p.joining_date) : "—"}</td>
                  <td className="px-4 py-2.5">{daysPresent(p.id)}</td>
                  <td className="px-4 py-2.5">{tasks(p.id)}</td>
                  <td className="px-4 py-2.5">{rating(p.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={count ?? staff.length} path="/hr/staff" />
    </Card>
  );
}
