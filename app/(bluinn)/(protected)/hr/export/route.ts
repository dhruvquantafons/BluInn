import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { addDays, daysBetween, isIsoDate, mondayOf, todayIn } from "../../../../lib/dates";
import { approvedHoursIn, payrollSummary, toCsv } from "../../../../lib/hr";
import type { AttendanceRecord, Department, LeaveRequest, ShiftType, StaffShift, Timesheet } from "../../../../lib/types";

/**
 * Payroll export (Module 12: "export-ready data for payroll systems").
 * GET /hr/export?from=yyyy-mm-dd&to=yyyy-mm-dd → CSV.
 */
export async function GET(request: Request) {
  const session = await requirePermission("hr.export");
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isIsoDate(from) || !isIsoDate(to) || to < from || daysBetween(from, to) > 92) {
    return new Response("Choose a period of up to three months.", { status: 400 });
  }

  const supabase = await createClient();
  const settings = await getSettings();
  const [{ data: staffRows }, { data: depts }, { data: attendance }, { data: shifts }, { data: types }, { data: leave }, { data: sheetRows }] =
    await Promise.all([
      supabase.from("staff").select("id, full_name, employee_code, job_title, department_id, is_active").order("full_name"),
      supabase.from("departments").select("*"),
      supabase.from("attendance").select("*").gte("work_date", from).lte("work_date", to),
      supabase.from("staff_shifts").select("*").gte("shift_date", from).lte("shift_date", to),
      supabase.from("shift_types").select("*"),
      supabase.from("leave_requests").select("*").eq("status", "approved").lte("start_date", to).gte("end_date", from),
      // Weeks that overlap the period; only the days inside it are counted.
      supabase.from("timesheets").select("staff_id, status, days, week_start").gte("week_start", mondayOf(from)).lte("week_start", to),
    ]);
  const deptName = new Map(((depts ?? []) as Department[]).map((d) => [d.id, d.name]));
  const sheets = (sheetRows ?? []) as Pick<Timesheet, "staff_id" | "status" | "days" | "week_start">[];
  // Everyone still here, and anyone who left during the period but worked or
  // was rostered in it: they are still owed for those days.
  const worked = new Set([
    ...((attendance ?? []) as AttendanceRecord[]).map((a) => a.staff_id),
    ...((shifts ?? []) as StaffShift[]).map((s) => s.staff_id),
  ]);
  const staff = (staffRows ?? []).filter((s) => s.is_active || worked.has(s.id));
  const weeksInPeriod = (() => {
    let n = 0;
    for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) n += 1;
    return n;
  })();

  const rows = payrollSummary({
    staff: (staff ?? []).map((s) => ({ ...s, department: s.department_id ? deptName.get(s.department_id) : "" })),
    from,
    to,
    today: todayIn(settings.timezone),
    timeZone: settings.timezone,
    graceMinutes: settings.hr_late_grace_minutes,
    attendance: (attendance ?? []) as AttendanceRecord[],
    shifts: (shifts ?? []) as StaffShift[],
    shiftTypes: (types ?? []) as ShiftType[],
    leave: (leave ?? []) as LeaveRequest[],
  });

  const csv = toCsv([
    ["Employee ID", "Name", "Department", "Designation", "Period from", "Period to", "Shifts rostered", "Days present",
      "Hours worked", "Late arrivals", "Absent days", "Casual leave", "Sick leave", "Earned leave", "Unpaid leave", "Other leave",
      "Approved regular hours", "Approved overtime hours", "Approved day-off hours", "Overtime rate", "Weeks approved"],
    ...rows.map((r) => {
      const ok = approvedHoursIn(sheets, r.staff_id, from, to);
      return [
        r.employee_code, r.name, r.department, r.designation, from, to, r.scheduled_shifts, r.days_present, r.hours_worked,
        r.late_arrivals, r.absent_days, r.leave.casual, r.leave.sick, r.leave.earned, r.leave.unpaid, r.leave.other,
        ok.regular, ok.overtime, ok.offDay, Number(settings.hr_ot_rate), `${ok.weeks} of ${weeksInPeriod}`,
      ];
    }),
  ]);

  await supabase.rpc("log_event", {
    p_module: "hr",
    p_action: "payroll_export",
    p_record_id: `${from}..${to}`,
    p_summary: `Payroll data exported for ${from} to ${to} (${rows.length} staff) by ${session.staff.full_name || session.staff.email}`,
  });

  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
