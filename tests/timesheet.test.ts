import { describe, it, expect } from "vitest";
import { approvedHoursIn, weekTimesheet } from "../app/lib/hr";
import type { AttendanceRecord, LeaveRequest, ShiftType, StaffShift } from "../app/lib/types";

/** 0038 — a week's hours, overtime and days off. */

const TZ = "Asia/Kolkata";
const WEEK = "2026-11-02"; // a Monday
const day = (n: number) => `2026-11-0${2 + n}`;

const morning: ShiftType = {
  id: "m", name: "Morning", start_time: "07:00:00", end_time: "15:00:00",
  start_time_2: null, end_time_2: null, color: "yellow", sort_order: 1, is_active: true,
};
const split: ShiftType = {
  id: "s", name: "Split", start_time: "07:00:00", end_time: "11:00:00",
  start_time_2: "17:00:00", end_time_2: "23:00:00", color: "emerald", sort_order: 2, is_active: true,
};

let n = 0;
const punch = (date: string, from: string, to: string): AttendanceRecord => ({
  id: `a${n++}`, staff_id: "p", work_date: date,
  clock_in: new Date(`${date}T${from}:00+05:30`).toISOString(),
  clock_out: new Date(`${date}T${to}:00+05:30`).toISOString(),
  method: "manual", in_distance_m: null, out_distance_m: null, notes: "", recorded_by: null, created_at: "",
});
const shift = (date: string, type: string | null): StaffShift => ({ id: `s${date}`, staff_id: "p", shift_date: date, shift_type_id: type, notes: "" });

const rules = { dailyHours: 9, weeklyHours: 48, minMinutes: 30 };
const run = (attendance: AttendanceRecord[], shifts: StaffShift[], leave: LeaveRequest[] = [], weekly_off: number | null = 0) =>
  weekTimesheet({
    weekStart: WEEK, staff: { id: "p", weekly_off }, attendance, shifts, shiftTypes: [morning, split], leave,
    rules, timeZone: TZ, graceMinutes: 10,
  });

describe("weekly timesheet", () => {
  it("counts time past the daily limit as overtime, in quarter hours", () => {
    const t = run([punch(day(0), "07:00", "17:40")], [shift(day(0), "m")]);
    // 10h40 worked against a 9h limit (the 8h shift is shorter): 1h40 → 1.5h.
    expect(t.days[0]).toMatchObject({ worked: 10.67, overtime: 1.5, regular: 9.17, shift: "Morning" });
  });

  it("ignores overtime below the minimum", () => {
    const t = run([punch(day(0), "07:00", "16:20")], [shift(day(0), "m")]);
    expect(t.days[0].overtime).toBe(0);
  });

  it("uses the shift's length when it is longer than the daily limit", () => {
    const t = run([punch(day(1), "07:00", "23:00")], [shift(day(1), "s")]);
    // Split shift is 10h; 16h worked → 6h overtime.
    expect(t.days[1]).toMatchObject({ scheduled: 10, overtime: 6, regular: 10 });
  });

  it("treats work on a rostered day off, or the weekly off, as off-day time", () => {
    const t = run([punch(day(2), "09:00", "13:00"), punch(day(6), "09:00", "12:00")], [shift(day(2), null)], [], 0);
    expect(t.days[2]).toMatchObject({ shift: "Off", off_day: 4, regular: 0 });
    // 8 Nov 2026 is a Sunday, the weekly off.
    expect(t.days[6]).toMatchObject({ shift: "Off", off_day: 3 });
    expect(t.offDay).toBe(7);
  });

  it("moves regular time past the weekly limit to overtime, from the end of the week", () => {
    const att = [0, 1, 2, 3, 4, 5].map((i) => punch(day(i), "07:00", "16:00")); // 9h × 6 = 54h
    const t = run(att, [0, 1, 2, 3, 4, 5].map((i) => shift(day(i), "m")), [], null);
    expect(t.regular).toBe(48);
    expect(t.overtime).toBe(6);
    expect(t.days[5]).toMatchObject({ regular: 3, overtime: 6 });
    expect(t.days.reduce((s, d) => s + d.regular + d.overtime, 0)).toBe(54);
  });

  it("marks late days and approved leave", () => {
    const leave: LeaveRequest = {
      id: "l", staff_id: "p", kind: "sick", start_date: day(3), end_date: day(4), reason: "", status: "approved",
      decided_by: null, decided_at: null, decision_note: "", created_at: "",
    };
    const t = run([punch(day(0), "07:30", "15:00")], [shift(day(0), "m")], [leave]);
    expect(t.days[0].late).toBe(true);
    expect(t.lateDays).toBe(1);
    expect(t.days[3].leave).toBe("sick");
    expect(t.days[4].leave).toBe("sick");
  });
});

describe("approved hours in a period", () => {
  it("sums only approved days inside the period", () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      date: day(i), shift: "", scheduled: 8, worked: 9, regular: 8, overtime: 1, off_day: 0, leave: null, late: false,
    }));
    const sheets = [
      { staff_id: "p", status: "approved" as const, days },
      { staff_id: "p", status: "submitted" as const, days },
    ];
    expect(approvedHoursIn(sheets, "p", day(3), "2026-11-30")).toEqual({ regular: 32, overtime: 4, offDay: 0, weeks: 1 });
  });
});
