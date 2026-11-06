import type { createClient } from "./supabase/server";
import type { AttendanceRecord, LeaveRequest, PropertySettings, ShiftType, StaffShift, Timesheet } from "./types";
import { addDays } from "./dates";
import { weekTimesheet, type WeekTimesheet } from "./hr";

type Client = Awaited<ReturnType<typeof createClient>>;

export interface WeekPerson {
  id: string;
  full_name: string;
  employee_code: string | null;
  department_id: string | null;
  weekly_off: number | null;
}

/**
 * Everything needed to work out a week's timesheets for some people, and the
 * timesheets already on file. Reads go through the caller's own client, so
 * someone without HR access only ever sees their own figures.
 */
export async function loadWeek(
  supabase: Client,
  settings: PropertySettings,
  weekStart: string,
  people: WeekPerson[],
): Promise<{ computed: Map<string, WeekTimesheet>; sheets: Map<string, Timesheet> }> {
  const ids = people.map((p) => p.id);
  const weekEnd = addDays(weekStart, 6);
  if (ids.length === 0) return { computed: new Map(), sheets: new Map() };

  const [{ data: att }, { data: shifts }, { data: types }, { data: leave }, { data: sheets }] = await Promise.all([
    supabase.from("attendance").select("*").in("staff_id", ids).gte("work_date", weekStart).lte("work_date", weekEnd),
    supabase.from("staff_shifts").select("*").in("staff_id", ids).gte("shift_date", weekStart).lte("shift_date", weekEnd),
    supabase.from("shift_types").select("*"),
    supabase
      .from("leave_requests")
      .select("*")
      .in("staff_id", ids)
      .eq("status", "approved")
      .lte("start_date", weekEnd)
      .gte("end_date", weekStart),
    supabase.from("timesheets").select("*").in("staff_id", ids).eq("week_start", weekStart),
  ]);

  const rules = {
    dailyHours: Number(settings.hr_ot_daily_hours ?? 9),
    weeklyHours: Number(settings.hr_ot_weekly_hours ?? 48),
    minMinutes: Number(settings.hr_ot_min_minutes ?? 30),
  };
  const computed = new Map<string, WeekTimesheet>();
  for (const person of people) {
    computed.set(
      person.id,
      weekTimesheet({
        weekStart,
        staff: person,
        attendance: (att ?? []) as AttendanceRecord[],
        shifts: (shifts ?? []) as StaffShift[],
        shiftTypes: (types ?? []) as ShiftType[],
        leave: (leave ?? []) as LeaveRequest[],
        rules,
        timeZone: settings.timezone,
        graceMinutes: settings.hr_late_grace_minutes,
      }),
    );
  }
  return {
    computed,
    sheets: new Map(((sheets ?? []) as Timesheet[]).map((t) => [t.staff_id, t])),
  };
}

export const WEEK_PERSON_COLUMNS = "id, full_name, employee_code, department_id, weekly_off";
