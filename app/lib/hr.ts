/**
 * Module 12 calculations: shift lengths, lateness, hours worked and the
 * payroll summary. Pure functions, shared by the HR pages and the export.
 */
import { addDays, eachNight, zonedTime } from "./dates";
import type { AttendanceRecord, LeaveKind, LeaveRequest, ShiftType, StaffShift, Timesheet, TimesheetDay } from "./types";

type ShiftTimes = Pick<ShiftType, "start_time" | "end_time" | "start_time_2" | "end_time_2">;

const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes from start to end, across midnight when the end is earlier. */
const span = (start: string, end: string) => {
  const d = minutesOf(end) - minutesOf(start);
  return d > 0 ? d : d + 24 * 60;
};

export function shiftHours(s: ShiftTimes): number {
  let minutes = span(s.start_time, s.end_time);
  if (s.start_time_2 && s.end_time_2) minutes += span(s.start_time_2, s.end_time_2);
  return minutes / 60;
}

export function shiftLabel(s: ShiftTimes): string {
  const part = (a: string, b: string) => `${a.slice(0, 5)}–${b.slice(0, 5)}`;
  return s.start_time_2 && s.end_time_2
    ? `${part(s.start_time, s.end_time)}, ${part(s.start_time_2, s.end_time_2)}`
    : part(s.start_time, s.end_time);
}

/** Minutes after the shift's start that someone clocked in (negative if early). */
export function lateMinutes(clockIn: string, workDate: string, shift: ShiftTimes, timeZone: string): number {
  const start = zonedTime(workDate, shift.start_time.slice(0, 5), timeZone).getTime();
  return Math.round((new Date(clockIn).getTime() - start) / 60000);
}

/** Hours between clock-in and clock-out; open records count for nothing. */
export function workedHours(records: Pick<AttendanceRecord, "clock_in" | "clock_out">[]): number {
  const ms = records.reduce(
    (sum, r) => sum + (r.clock_out ? Math.max(0, new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) : 0),
    0,
  );
  return Math.round((ms / 3600000) * 100) / 100;
}

/** Days of a leave request that fall between from and to, inclusive. */
export function leaveDaysIn(leave: Pick<LeaveRequest, "start_date" | "end_date">, from: string, to: string): string[] {
  const start = leave.start_date > from ? leave.start_date : from;
  const end = leave.end_date < to ? leave.end_date : to;
  return start > end ? [] : eachNight(start, addDays(end, 1));
}

export type DayStatus = "present" | "leave" | "off" | "absent" | "scheduled" | "none";

export interface PayrollStaff {
  id: string;
  full_name: string;
  employee_code?: string | null;
  job_title: string;
  department?: string;
}

export interface PayrollRow {
  staff_id: string;
  employee_code: string;
  name: string;
  department: string;
  designation: string;
  scheduled_shifts: number;
  days_present: number;
  hours_worked: number;
  late_arrivals: number;
  absent_days: number;
  leave: Record<LeaveKind, number>;
}

/**
 * One row per person for a period: what was rostered, attended and taken as
 * approved leave. A rostered day with no attendance and no leave, up to
 * today, is absent.
 */
export function payrollSummary(input: {
  staff: PayrollStaff[];
  from: string;
  to: string;
  today: string;
  timeZone: string;
  graceMinutes: number;
  attendance: AttendanceRecord[];
  shifts: StaffShift[];
  shiftTypes: ShiftType[];
  leave: LeaveRequest[];
}): PayrollRow[] {
  const days = eachNight(input.from, addDays(input.to, 1));
  const typeById = new Map(input.shiftTypes.map((t) => [t.id, t]));

  return input.staff.map((person) => {
    const mine = input.attendance.filter((a) => a.staff_id === person.id && a.work_date >= input.from && a.work_date <= input.to);
    const presentDays = new Set(mine.map((a) => a.work_date));
    const leaveByDay = new Map<string, LeaveKind>();
    for (const l of input.leave) {
      if (l.staff_id !== person.id || l.status !== "approved") continue;
      for (const d of leaveDaysIn(l, input.from, input.to)) leaveByDay.set(d, l.kind);
    }
    const rostered = input.shifts.filter((s) => s.staff_id === person.id && s.shift_type_id && s.shift_date >= input.from && s.shift_date <= input.to);

    let late = 0;
    for (const s of rostered) {
      const type = typeById.get(s.shift_type_id!);
      const first = mine
        .filter((a) => a.work_date === s.shift_date)
        .sort((a, b) => a.clock_in.localeCompare(b.clock_in))[0];
      if (type && first && lateMinutes(first.clock_in, s.shift_date, type, input.timeZone) > input.graceMinutes) late += 1;
    }

    const leave: Record<LeaveKind, number> = { casual: 0, sick: 0, earned: 0, unpaid: 0, other: 0 };
    for (const d of days) {
      const kind = leaveByDay.get(d);
      if (kind) leave[kind] += 1;
    }

    const absent = rostered.filter(
      (s) => s.shift_date <= input.today && !presentDays.has(s.shift_date) && !leaveByDay.has(s.shift_date),
    ).length;

    return {
      staff_id: person.id,
      employee_code: person.employee_code ?? "",
      name: person.full_name,
      department: person.department ?? "",
      designation: person.job_title,
      scheduled_shifts: rostered.length,
      days_present: presentDays.size,
      hours_worked: workedHours(mine),
      late_arrivals: late,
      absent_days: absent,
      leave,
    };
  });
}

/**
 * Comma-separated values, quoted, with spreadsheet formulas neutralised.
 * Numbers cannot carry a formula, so a negative amount stays a number.
 */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    if (typeof v === "number") return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) || s !== String(v) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

// ── Weekly timesheets and overtime (0038) ───────────────────────────────────

export interface OvertimeRules {
  /** Hours a day beyond which time is overtime, unless the shift is longer. */
  dailyHours: number;
  /** Hours a week beyond which regular time also becomes overtime. */
  weeklyHours: number;
  /** Overtime shorter than this on a day is not counted. */
  minMinutes: number;
}

export interface WeekTimesheet {
  weekStart: string;
  days: TimesheetDay[];
  regular: number;
  overtime: number;
  offDay: number;
  worked: number;
  scheduled: number;
  lateDays: number;
}

const round2h = (n: number) => Math.round(n * 100) / 100;
/** Down to the quarter hour: overtime is paid in whole blocks. */
const quarterDown = (hours: number) => Math.floor(hours * 4 + 1e-9) / 4;

/**
 * One person's week, Monday to Sunday, worked out from attendance against
 * the roster.
 *
 * - On a working day, time beyond the longer of the shift and the daily limit
 *   is overtime, counted in quarter hours once it reaches the minimum.
 * - Time worked on a rostered day off, or on the weekly day off when nothing
 *   was rostered, is off-day time.
 * - If regular time for the week still exceeds the weekly limit, the excess
 *   moves to overtime too.
 */
export function weekTimesheet(input: {
  weekStart: string;
  staff: { id: string; weekly_off?: number | null };
  attendance: AttendanceRecord[];
  shifts: StaffShift[];
  shiftTypes: ShiftType[];
  leave: LeaveRequest[];
  rules: OvertimeRules;
  timeZone: string;
  graceMinutes: number;
}): WeekTimesheet {
  const typeById = new Map(input.shiftTypes.map((t) => [t.id, t]));
  const dates = eachNight(input.weekStart, addDays(input.weekStart, 7));
  const weekEnd = dates[dates.length - 1];

  const leaveOn = new Map<string, LeaveKind>();
  for (const l of input.leave) {
    if (l.staff_id !== input.staff.id || l.status !== "approved") continue;
    for (const d of leaveDaysIn(l, input.weekStart, weekEnd)) leaveOn.set(d, l.kind);
  }

  const days: TimesheetDay[] = dates.map((date) => {
    const records = input.attendance.filter((a) => a.staff_id === input.staff.id && a.work_date === date);
    const rostered = input.shifts.find((s) => s.staff_id === input.staff.id && s.shift_date === date);
    const type = rostered?.shift_type_id ? typeById.get(rostered.shift_type_id) : undefined;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isOff = rostered ? !rostered.shift_type_id : input.staff.weekly_off === weekday;

    const worked = workedHours(records);
    const scheduled = type ? round2h(shiftHours(type)) : 0;
    const first = [...records].sort((a, b) => a.clock_in.localeCompare(b.clock_in))[0];
    const late = !!(type && first && lateMinutes(first.clock_in, date, type, input.timeZone) > input.graceMinutes);

    let regular = worked;
    let overtime = 0;
    let offDay = 0;
    if (isOff) {
      offDay = worked;
      regular = 0;
    } else {
      const limit = Math.max(scheduled, input.rules.dailyHours);
      const extra = worked - limit;
      if (extra * 60 >= input.rules.minMinutes && extra > 0) {
        overtime = quarterDown(extra);
        regular = worked - overtime;
      }
    }

    return {
      date,
      shift: type ? type.name : isOff ? "Off" : "",
      scheduled,
      worked,
      regular: round2h(regular),
      overtime: round2h(overtime),
      off_day: round2h(offDay),
      leave: leaveOn.get(date) ?? null,
      late,
    };
  });

  // Past the weekly limit, the hours that tipped it over (the last ones
  // worked) become overtime, so each day's figures still add up to the week.
  const excess = days.reduce((s, d) => s + d.regular, 0) - input.rules.weeklyHours;
  let toMove = excess > 0 ? quarterDown(excess) : 0;
  for (let i = days.length - 1; i >= 0 && toMove > 0; i--) {
    const take = Math.min(days[i].regular, toMove);
    days[i].regular = round2h(days[i].regular - take);
    days[i].overtime = round2h(days[i].overtime + take);
    toMove = round2h(toMove - take);
  }

  return {
    weekStart: input.weekStart,
    days,
    regular: round2h(days.reduce((s, d) => s + d.regular, 0)),
    overtime: round2h(days.reduce((s, d) => s + d.overtime, 0)),
    offDay: round2h(days.reduce((s, d) => s + d.off_day, 0)),
    worked: round2h(days.reduce((s, d) => s + d.worked, 0)),
    scheduled: round2h(days.reduce((s, d) => s + d.scheduled, 0)),
    lateDays: days.filter((d) => d.late).length,
  };
}

/** Approved hours inside a period, from the timesheets' daily snapshots. */
export function approvedHoursIn(
  sheets: Pick<Timesheet, "staff_id" | "status" | "days">[],
  staffId: string,
  from: string,
  to: string,
): { regular: number; overtime: number; offDay: number; weeks: number } {
  let regular = 0;
  let overtime = 0;
  let offDay = 0;
  let weeks = 0;
  for (const t of sheets) {
    if (t.staff_id !== staffId || t.status !== "approved") continue;
    const inside = (t.days ?? []).filter((d) => d.date >= from && d.date <= to);
    if (inside.length === 0) continue;
    weeks += 1;
    for (const d of inside) {
      regular += Number(d.regular);
      overtime += Number(d.overtime);
      offDay += Number(d.off_day);
    }
  }
  return { regular: round2h(regular), overtime: round2h(overtime), offDay: round2h(offDay), weeks };
}
