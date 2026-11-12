import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canOpen, firstOpenable, PAGE_ACCESS, BILLING_TABS, REPORT_TABS } from "../app/lib/page-access";
import { allowedGroups } from "../app/(bluinn)/components/nav";
import { friendlyDbError } from "../app/lib/db-errors";
import { depositReceived } from "../app/lib/policies";
import { earlyFeePosted } from "../app/lib/checkout";
import { modifierFloorProblem } from "../app/lib/pos";
import { planAdjustmentProblem, overlappingSeason } from "../app/lib/rate-rules";
import { leaveCancelProblem, attendanceProblem } from "../app/lib/hr";
import { scheduleNeedsFinancial } from "../app/lib/reports";

// Sections 1, 3 and 4 of docs/interconnection-audit-2026-11-12.md: the pieces
// that can be checked without a database.

const role = (...permissions: string[]) => ({ isSuperuser: false, permissions });

describe("page access — a link is shown only to someone the page admits (section 1)", () => {
  // The seeded F&B manager: financial reports and the cash drawer, no folio access.
  const fbManager = role("reports.financial", "reports.view", "folio.cashier", "pos.view", "pos.order", "pos.pay", "pos.manage");

  it("knows the F&B manager cannot open the invoice list but can open the GST register", () => {
    expect(canOpen(fbManager, "/billing/invoices")).toBe(false);
    expect(canOpen(fbManager, "/billing/gst-register")).toBe(true);
  });
  it("sends a section link to the first tab the person can open", () => {
    // Credit notes admit reports.financial, and come before the GST register.
    expect(firstOpenable(fbManager, BILLING_TABS)).toBe("/billing/credit-notes");
    expect(firstOpenable(role("reports.schedule"), REPORT_TABS)).toBe("/reports/schedules");
  });
  it("points the sidebar's Billing at that tab, and hides sections the person cannot open at all", () => {
    const billing = allowedGroups(fbManager)
      .flatMap((g) => g.items)
      .find((i) => i.label === "Billing");
    expect(billing?.href).toBe("/billing/credit-notes");
    const items = allowedGroups(role("events.quote")).flatMap((g) => g.items).map((i) => i.label);
    expect(items).not.toContain("Events & banquets");
  });
  it("matches a page with an id to its pattern", () => {
    expect(canOpen(role("maintenance.report"), "/maintenance/assets/0000")).toBe(false);
    expect(canOpen(role("maintenance.work"), "/maintenance/assets/0000")).toBe(true);
  });
  it("lets a superuser open everything", () => {
    expect(canOpen({ isSuperuser: true, permissions: [] }, "/billing/invoices")).toBe(true);
  });

  it("mirrors the guard on every page, so the map cannot drift from the pages", () => {
    const root = path.join(__dirname, "../app/(bluinn)/(protected)");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name === "page.tsx") pages.push(p);
      }
    };
    walk(root);
    const mismatches: string[] = [];
    for (const file of pages) {
      const route = "/" + path.relative(root, path.dirname(file)).split(path.sep).join("/");
      const key = route === "/." || route === "/" ? "/" : route;
      const src = fs.readFileSync(file, "utf8");
      const m = src.match(/require(Any)?Permission\(\s*(\[[^\]]*\]|"[^"]+")/);
      if (!m) continue; // pages open to any staff, or guarded another way
      const guard = JSON.parse(m[2].startsWith("[") ? m[2].replace(/,\s*\]/, "]") : `[${m[2]}]`) as string[];
      const mapped = PAGE_ACCESS[key];
      if (!mapped || mapped === "any" || [...mapped].sort().join() !== [...guard].sort().join()) {
        mismatches.push(`${key}: page ${guard.join("|")} vs map ${mapped === undefined ? "missing" : String(mapped)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});


describe("the new database checks read as sentences (section 3)", () => {
  it.each([
    ["BOOKING_CLOSED: this booking is cancelled, so nothing more can be charged to it", "This booking is cancelled, so nothing more can be charged to it."],
    ["POS_ORDER_SETTLED: this bill is settled; its tip and room can no longer change", "This bill is settled; its tip and room can no longer change."],
    ["PROMO_USED_UP: DIWALI has been used 50 time(s), its limit", "DIWALI has been used 50 time(s), its limit."],
    ["LEAVE_WORKED: 03 Nov 2026 was a working day (there is attendance for it)", "03 Nov 2026 was a working day (there is attendance for it)."],
    ["PROPERTY_CLOSED: that hotel is closed", "That hotel is closed."],
    ["TIMESHEET_HOURS: 50 hours claimed but attendance shows 45", "50 hours claimed but attendance shows 45."],
  ])("%s", (raw, sentence) => {
    expect(friendlyDbError(raw)).toBe(sentence);
  });
  it("explains a price below zero", () => {
    expect(friendlyDbError('new row for relation "pos_order_lines" violates check constraint "pos_order_lines_unit_price_check"')).toBe(
      "An item's price with its modifiers cannot be below ₹0.",
    );
  });
});

describe("check-in money (section 3)", () => {
  const line = (kind: string, amount: number, extra: Record<string, unknown> = {}) => ({
    kind,
    amount,
    tax_amount: 0,
    voided_at: null as string | null,
    is_deposit: false,
    description: "",
    stay_date: null as string | null,
    ...extra,
  });
  it("counts payments less refunds as the deposit, not allowances", () => {
    const entries = [line("payment", 5000), line("refund", 1000), line("adjustment", 2000), line("payment", 300, { voided_at: "x" })];
    expect(depositReceived(entries as never)).toBe(4000);
  });
  it("finds an early check-in fee already posted today, so a retry does not charge it twice", () => {
    const fee = line("fee", 500, { description: "Early check-in at 09:10", stay_date: "2026-11-12" });
    expect(earlyFeePosted([fee] as never, "2026-11-12")).toBe(true);
    expect(earlyFeePosted([{ ...fee, voided_at: "x" }] as never, "2026-11-12")).toBe(false);
    expect(earlyFeePosted([fee] as never, "2026-11-13")).toBe(false);
  });
});

describe("POS modifiers (section 3)", () => {
  const items = [
    { name: "Masala chai", price: 120 },
    { name: "Club sandwich", price: 450 },
  ];
  it("allows a modifier that takes money off", () => {
    expect(modifierFloorProblem(-100, items)).toBeNull();
    expect(modifierFloorProblem(-120, items)).toBeNull();
  });
  it("refuses one that would take an item below ₹0, naming it", () => {
    expect(modifierFloorProblem(-150, items)).toBe("Masala chai costs ₹120, so this modifier can take off at most ₹120.");
  });
});

describe("rates (section 3)", () => {
  it("refuses a plan that would price a room at ₹0 or less", () => {
    expect(planAdjustmentProblem("percent", -100)).toBe("A discount must be less than 100%.");
    expect(planAdjustmentProblem("percent", -99)).toBeNull();
    expect(planAdjustmentProblem("fixed", 0)).toBe("A fixed rate must be above ₹0.");
    expect(planAdjustmentProblem("amount", -500)).toBeNull();
  });

  const season = (o: Partial<{ id: string; name: string; start_date: string; end_date: string; room_type_id: string | null; priority: number; days_of_week: number[]; is_active: boolean }>) => ({
    id: "s1",
    name: "Diwali",
    start_date: "2026-11-01",
    end_date: "2026-11-10",
    room_type_id: null,
    priority: 0,
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    is_active: true,
    ...o,
  });
  it("finds a season at the same priority and scope that overlaps", () => {
    const candidate = season({ id: "new", name: "Wedding", start_date: "2026-11-08", end_date: "2026-11-20" });
    expect(overlappingSeason(candidate, [season({})])?.name).toBe("Diwali");
  });
  it("ignores seasons that cannot be confused: other priority, other room type, other days, inactive, itself", () => {
    const candidate = season({ id: "new", start_date: "2026-11-08", end_date: "2026-11-20", days_of_week: [5, 6] });
    expect(
      overlappingSeason(candidate, [
        season({ priority: 1 }),
        season({ room_type_id: "deluxe" }),
        season({ days_of_week: [1, 2] }),
        season({ is_active: false }),
        season({ id: "new" }),
        season({ start_date: "2026-12-01", end_date: "2026-12-05" }),
      ]),
    ).toBeNull();
  });
});

describe("HR (section 3)", () => {
  const req = (o: Partial<{ status: string; start_date: string; staff_id: string }> = {}) => ({
    status: "approved",
    start_date: "2026-11-20",
    staff_id: "me",
    ...o,
  });
  const today = "2026-11-12";
  it("lets the employee withdraw approved leave until its first day", () => {
    expect(leaveCancelProblem(req(), { staffId: "me", isHr: false, today, reason: "" })).toBeNull();
    expect(leaveCancelProblem(req({ start_date: today }), { staffId: "me", isHr: false, today, reason: "" })).toBe(
      "This leave has started. Ask HR to cancel it.",
    );
  });
  it("lets HR cancel it at any time, with a reason", () => {
    expect(leaveCancelProblem(req({ start_date: "2026-11-01", staff_id: "x" }), { staffId: "me", isHr: true, today, reason: "" })).toBe(
      "Give a reason for cancelling someone's approved leave.",
    );
    expect(
      leaveCancelProblem(req({ start_date: "2026-11-01", staff_id: "x" }), { staffId: "me", isHr: true, today, reason: "Came back early" }),
    ).toBeNull();
  });
  it("does not let anyone else cancel it, nor a decided request be cancelled twice", () => {
    expect(leaveCancelProblem(req({ staff_id: "x" }), { staffId: "me", isHr: false, today, reason: "" })).toBe("That leave is not yours.");
    expect(leaveCancelProblem(req({ status: "rejected" }), { staffId: "me", isHr: true, today, reason: "x" })).toBe(
      "Only pending or approved leave can be cancelled.",
    );
  });

  const at = (s: string) => new Date(s);
  const now = at("2026-11-12T12:00:00Z");
  it("refuses a manual attendance record that ends in the future, ends before it starts, or overlaps another", () => {
    expect(attendanceProblem(at("2026-11-12T03:00:00Z"), at("2026-11-12T13:00:00Z"), [], now)).toBe("Clock-out cannot be in the future.");
    expect(attendanceProblem(at("2026-11-12T03:00:00Z"), at("2026-11-12T03:00:00Z"), [], now)).toBe("Clock-out must be after clock-in.");
    const other = [{ clock_in: "2026-11-12T08:00:00Z", clock_out: "2026-11-12T10:00:00Z" }];
    expect(attendanceProblem(at("2026-11-12T03:00:00Z"), at("2026-11-12T09:00:00Z"), other, now)).toBe(
      "This overlaps another attendance record for the same person.",
    );
    expect(attendanceProblem(at("2026-11-12T03:00:00Z"), at("2026-11-12T08:00:00Z"), other, now)).toBeNull();
    // An open record (still clocked in) overlaps anything after it began.
    expect(attendanceProblem(at("2026-11-12T09:00:00Z"), null, [{ clock_in: "2026-11-12T08:00:00Z", clock_out: null }], now)).toBe(
      "This overlaps another attendance record for the same person.",
    );
  });
});

describe("report schedules (section 3)", () => {
  it("needs reports.financial for the revenue, KPI and flash reports, not the operational ones", () => {
    expect(scheduleNeedsFinancial("daily_revenue")).toBe(true);
    expect(scheduleNeedsFinancial("kpi_summary")).toBe(true);
    expect(scheduleNeedsFinancial("flash")).toBe(true);
    expect(scheduleNeedsFinancial("outstanding")).toBe(true);
    expect(scheduleNeedsFinancial("housekeeping")).toBe(false);
    expect(scheduleNeedsFinancial("maintenance")).toBe(false);
  });
});
