import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../lib/auth";
import { can } from "../../../../lib/permissions";
import { getSettings } from "../../../../lib/settings";
import { addDays, isIsoDate, mondayOf, todayIn } from "../../../../lib/dates";
import { loadWeek, WEEK_PERSON_COLUMNS, type WeekPerson } from "../../../../lib/timesheet-data";
import { LEAVE_KIND_LABELS, type TimesheetStatus } from "../../../../lib/types";
import { decideTimesheet, reopenTimesheet } from "../../../hr-actions";
import { Card, EmptyState, Notice, SectionTitle, StatCard, Tag, fmtDate, inputClass, secondaryButtonClass, tableHeadClass } from "../../../components/ui";
import ActionForm from "../../../components/ActionForm";

const STATUS: Record<TimesheetStatus | "none", { label: string; tone: "neutral" | "amber" | "green" | "red" }> = {
  none: { label: "Not submitted", tone: "neutral" },
  submitted: { label: "Submitted", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Sent back", tone: "red" },
};

const h = (n: number) => (n ? `${n} h` : "—");

/**
 * Weekly timesheets (0038). Hours come from attendance against the roster;
 * the manager approves each person's week, which freezes the figures for
 * payroll and locks that week's attendance.
 */
export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<{ week?: string; staff?: string }> }) {
  const session = await requireAnyPermission(["hr.view", "hr.approve_time"]);
  const canDecide = can(session, "hr.approve_time");
  const canReopen = can(session, "hr.manage");
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const params = await searchParams;
  const lastWeek = addDays(mondayOf(today), -7);
  const week = params.week && isIsoDate(params.week) ? mondayOf(params.week) : lastWeek;
  const weekEnd = addDays(week, 6);
  const finished = weekEnd < today;
  const supabase = await createClient();

  const { data: staffRows } = await supabase.from("staff").select(WEEK_PERSON_COLUMNS).eq("is_active", true).order("full_name");
  const people = (staffRows ?? []) as WeekPerson[];
  const { computed, sheets } = await loadWeek(supabase, settings, week, people);

  const rows = people.map((p) => ({ p, t: computed.get(p.id)!, sheet: sheets.get(p.id) ?? null }));
  const approved = rows.filter((r) => r.sheet?.status === "approved");
  const totalOt = rows.reduce((s, r) => s + (r.sheet?.status === "approved" ? Number(r.sheet.overtime_hours) : r.t.overtime), 0);
  const selected = rows.find((r) => r.p.id === params.staff) ?? null;
  const nav = (w: string) => `/hr/timesheets?week=${w}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={nav(addDays(week, -7))} className={secondaryButtonClass} aria-label="Previous week">
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <p className="text-sm font-medium text-slate-900">
          {fmtDate(week)} – {fmtDate(weekEnd)}
        </p>
        <Link href={nav(addDays(week, 7))} className={secondaryButtonClass} aria-label="Next week">
          <ChevronRight className="w-4 h-4" />
        </Link>
        {week !== lastWeek && (
          <Link href={nav(lastWeek)} className="text-xs text-brand-700 hover:underline">
            Last week
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Approved" value={`${approved.length} of ${rows.length}`} hint="Staff with this week approved" />
        <StatCard label="Waiting" value={rows.filter((r) => r.sheet?.status === "submitted").length} hint="Submitted, not yet decided" />
        <StatCard label="Overtime" value={`${Math.round(totalOt * 100) / 100} h`} hint={`Over ${settings.hr_ot_daily_hours} h a day or ${settings.hr_ot_weekly_hours} h a week`} />
        <StatCard label="Worked on days off" value={`${Math.round(rows.reduce((s, r) => s + r.t.offDay, 0) * 100) / 100} h`} hint="Rostered off or weekly off" />
      </div>

      {!finished && (
        <Notice tone="info">This week is not over yet, so these are running figures. Timesheets are decided once the week ends.</Notice>
      )}

      <Card>
        {rows.length === 0 ? (
          <EmptyState message="No active staff." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="py-2 px-4 font-semibold">Staff</th>
                  <th className="py-2 pr-3 font-semibold text-right">Rostered</th>
                  <th className="py-2 pr-3 font-semibold text-right">Worked</th>
                  <th className="py-2 pr-3 font-semibold text-right">Regular</th>
                  <th className="py-2 pr-3 font-semibold text-right">Overtime</th>
                  <th className="py-2 pr-3 font-semibold text-right">Days off worked</th>
                  <th className="py-2 pr-3 font-semibold text-right">Late</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-4 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {rows.map(({ p, t, sheet }) => {
                  const frozen = sheet?.status === "approved";
                  const shown = frozen
                    ? { regular: Number(sheet.regular_hours), overtime: Number(sheet.overtime_hours), offDay: Number(sheet.off_day_hours) }
                    : t;
                  const st = STATUS[sheet?.status ?? "none"];
                  return (
                    <tr key={p.id} className={selected?.p.id === p.id ? "bg-brand-50/60" : ""}>
                      <td className="py-2 px-4">
                        <Link href={`/hr/timesheets?week=${week}&staff=${p.id}`} className="text-slate-900 hover:text-brand-700">
                          {p.full_name}
                        </Link>
                        {p.employee_code && <span className="block text-[11px] text-slate-500">{p.employee_code}</span>}
                      </td>
                      <td className="py-2 pr-3 text-right">{h(t.scheduled)}</td>
                      <td className="py-2 pr-3 text-right">{h(t.worked)}</td>
                      <td className="py-2 pr-3 text-right">{h(shown.regular)}</td>
                      <td className="py-2 pr-3 text-right font-medium">{h(shown.overtime)}</td>
                      <td className="py-2 pr-3 text-right">{h(shown.offDay)}</td>
                      <td className="py-2 pr-3 text-right">{t.lateDays || "—"}</td>
                      <td className="py-2 pr-3">
                        <Tag tone={st.tone}>{st.label}</Tag>
                        {sheet?.decision_note && <span className="block text-[11px] text-slate-500">{sheet.decision_note}</span>}
                        {sheet?.note && <span className="block text-[11px] text-slate-500">“{sheet.note}”</span>}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {canDecide && finished && !frozen && p.id !== session.staff.id && (
                            <>
                              <ActionForm action={decideTimesheet} submitLabel="Approve" submitClassName={secondaryButtonClass}>
                                <input type="hidden" name="staff_id" value={p.id} />
                                <input type="hidden" name="week" value={week} />
                                <input type="hidden" name="decision" value="approve" />
                              </ActionForm>
                              <details className="relative">
                                <summary className="text-[11px] text-slate-500 hover:text-rose-700 cursor-pointer list-none">Send back</summary>
                                <div className="absolute right-0 z-10 mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-md p-3">
                                  <ActionForm action={decideTimesheet} submitLabel="Send back" submitClassName={secondaryButtonClass} className="space-y-2">
                                    <input type="hidden" name="staff_id" value={p.id} />
                                    <input type="hidden" name="week" value={week} />
                                    <input type="hidden" name="decision" value="reject" />
                                    <input name="note" required placeholder="What needs correcting" className={inputClass} />
                                  </ActionForm>
                                </div>
                              </details>
                            </>
                          )}
                          {canReopen && frozen && (
                            <ActionForm action={reopenTimesheet} submitLabel="Reopen" submitClassName="text-[11px] text-slate-500 hover:text-brand-700 cursor-pointer">
                              <input type="hidden" name="id" value={sheet.id} />
                            </ActionForm>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <Card>
          <div className="px-4 pt-4">
            <SectionTitle>
              {selected.p.full_name} · day by day
              {selected.sheet?.status === "approved" && " (as approved)"}
            </SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="py-2 px-4 font-semibold">Day</th>
                  <th className="py-2 pr-3 font-semibold">Shift</th>
                  <th className="py-2 pr-3 font-semibold text-right">Rostered</th>
                  <th className="py-2 pr-3 font-semibold text-right">Worked</th>
                  <th className="py-2 pr-3 font-semibold text-right">Regular</th>
                  <th className="py-2 pr-3 font-semibold text-right">Overtime</th>
                  <th className="py-2 pr-4 font-semibold text-right">Day off worked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {(selected.sheet?.status === "approved" ? selected.sheet.days : selected.t.days).map((d) => (
                  <tr key={d.date}>
                    <td className="py-2 px-4 whitespace-nowrap">
                      {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                    </td>
                    <td className="py-2 pr-3">
                      {d.leave ? <Tag tone="blue">{LEAVE_KIND_LABELS[d.leave]}</Tag> : d.shift || "—"}
                      {d.late && <Tag tone="amber">Late</Tag>}
                    </td>
                    <td className="py-2 pr-3 text-right">{h(d.scheduled)}</td>
                    <td className="py-2 pr-3 text-right">{h(d.worked)}</td>
                    <td className="py-2 pr-3 text-right">{h(d.regular)}</td>
                    <td className="py-2 pr-3 text-right font-medium">{h(d.overtime)}</td>
                    <td className="py-2 pr-4 text-right">{h(d.off_day)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-[11px] text-slate-500">
            Overtime: time past the longer of the shift and {settings.hr_ot_daily_hours} h a day, in quarter hours once it reaches{" "}
            {settings.hr_ot_min_minutes} minutes, plus regular time past {settings.hr_ot_weekly_hours} h in the week. Change the
            limits under HR → Setup.
          </p>
        </Card>
      )}
    </div>
  );
}
