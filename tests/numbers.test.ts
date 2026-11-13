import { describe, expect, it } from "vitest";
import { invoiceLines, invoiceTotals, taxBreakdown, isReimbursement } from "../app/lib/invoices";
import { eventBalance } from "../app/lib/events";
import { chargeWithTax } from "../app/lib/folio";
import { folioCredits, depositReceived } from "../app/lib/policies";
import { isToArrive, isToDepart } from "../app/lib/front-desk";
import { flashKpis, periodHasData } from "../app/lib/reports";
import { NAV_GROUPS, allowedGroups } from "../app/(bluinn)/components/nav";
import type { FolioEntry } from "../app/lib/types";

// Sections 5 and 6 of docs/interconnection-audit-2026-11-12.md: orphan pages
// and figures that read differently from screen to screen (0044).

const entry = (over: Partial<FolioEntry>): FolioEntry =>
  ({
    id: Math.random().toString(36).slice(2),
    kind: "extra",
    description: "",
    amount: 0,
    tax_amount: 0,
    tax_rate: 0,
    voided_at: null,
    stay_date: "2026-11-12",
    created_at: "2026-11-12T10:00:00Z",
    sac_code: "",
    revenue_dept: "other",
    applies_to: null,
    ...over,
  }) as FolioEntry;

describe("invoices — paid-outs and tips are on the bill but are not supplies", () => {
  const entries = [
    entry({ kind: "room", description: "Room 101", amount: 5000, tax_amount: 600, tax_rate: 12, sac_code: "996311", revenue_dept: "rooms" }),
    entry({ kind: "extra", description: "Paid out: taxi", amount: 300, revenue_dept: "paid_out" }),
    entry({ kind: "extra", description: "Restaurant — R-12 — tip", amount: 50, revenue_dept: "tip" }),
  ];
  const lines = invoiceLines(entries, { regime: "gst" });

  it("knows a paid-out and a tip are reimbursements", () => {
    expect(isReimbursement("paid_out")).toBe(true);
    expect(isReimbursement("tip")).toBe(true);
    expect(isReimbursement("fnb")).toBe(false);
    expect(isReimbursement(null)).toBe(false);
  });
  it("keeps them on the invoice, marked", () => {
    expect(lines.filter((l) => l.reimbursement).map((l) => l.description)).toEqual(["Paid out: taxi", "Restaurant — R-12 — tip"]);
  });
  it("leaves them out of the taxable value and tax, but the guest still pays them", () => {
    expect(invoiceTotals(lines)).toEqual({ net: 5000, tax: 600, reimbursements: 350, grand: 5950 });
  });
  it("leaves them out of the tax bands, so the GST register never sees them", () => {
    expect(taxBreakdown(lines).map((b) => b.sac)).toEqual(["996311"]);
  });
});

describe("event balance — credit notes lower what is owed, as the database counts it", () => {
  it("takes credit notes off", () => {
    const payments = [{ kind: "payment", amount: 4000, voided_at: null }] as never;
    expect(eventBalance({ grand_total: 10000 }, payments, 0, 1500)).toBe(4500);
  });
});

describe("penalty previews — show what the folio will post, tax included", () => {
  const SLABS = [
    { up_to: 7500, rate: 5 },
    { up_to: null, rate: 18 },
  ];
  const stay = { check_in: "2026-11-10", quoted_rate: 9000, rate_breakdown: [] } as never;
  it("adds GST when prices are before tax", () => {
    expect(chargeWithTax(1000, stay, { tax_inclusive: false, tax_slabs: SLABS } as never)).toBe(1180);
  });
  it("is the amount itself when prices include tax", () => {
    expect(chargeWithTax(1000, stay, { tax_inclusive: true, tax_slabs: SLABS } as never)).toBe(1000);
  });
});

describe("check-out — Paid is money received; allowances are shown apart", () => {
  const entries = [
    entry({ kind: "payment", amount: 3000 }),
    entry({ kind: "refund", amount: 500 }),
    entry({ kind: "adjustment", amount: 200, applies_to: "x" }),
    entry({ kind: "adjustment", amount: 100, voided_at: "2026-11-12T11:00:00Z" }),
  ];
  it("counts payments less refunds as paid", () => {
    expect(depositReceived(entries)).toBe(2500);
  });
  it("counts allowances and credits on their own", () => {
    expect(folioCredits(entries)).toBe(200);
  });
});

describe("arrivals and departures — one definition for the dashboard and the front desk", () => {
  const today = "2026-11-13";
  it("still to arrive: due today or late, not yet checked in", () => {
    expect(isToArrive({ status: "confirmed", check_in: today, check_out: "2026-11-15" }, today)).toBe(true);
    expect(isToArrive({ status: "tentative", check_in: "2026-11-12", check_out: "2026-11-15" }, today)).toBe(true);
    expect(isToArrive({ status: "checked_in", check_in: today, check_out: "2026-11-15" }, today)).toBe(false);
    expect(isToArrive({ status: "confirmed", check_in: "2026-11-14", check_out: "2026-11-15" }, today)).toBe(false);
  });
  it("still to depart: due today or overstaying, still checked in", () => {
    expect(isToDepart({ status: "checked_in", check_in: "2026-11-10", check_out: today }, today)).toBe(true);
    expect(isToDepart({ status: "checked_in", check_in: "2026-11-10", check_out: "2026-11-12" }, today)).toBe(true);
    expect(isToDepart({ status: "checked_out", check_in: "2026-11-10", check_out: today }, today)).toBe(false);
    expect(isToDepart({ status: "checked_in", check_in: "2026-11-10", check_out: "2026-11-14" }, today)).toBe(false);
  });
});

describe("flash report — the total is the departments it lists", () => {
  it("ignores anything that is not a department", () => {
    const p = { rooms_available: 10, rooms_sold: 5, room_revenue: 5000, revenue: { rooms: 5000, fnb: 1000, paid_out: 300 } } as never;
    expect(flashKpis(p).totalRevenue).toBe(6000);
  });
});

describe("menus — every permission on a menu item opens one of its pages (section 5)", () => {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      for (const p of item.any) {
        it(`${item.label} is reachable with ${p} alone`, () => {
          const shown = allowedGroups({ isSuperuser: false, permissions: [p] }).flatMap((g) => g.items.map((i) => i.label));
          expect(shown).toContain(item.label);
        });
      }
    }
  }
  it("shows Cash shifts to someone with only financial reports", () => {
    const shown = allowedGroups({ isSuperuser: false, permissions: ["reports.financial"] }).flatMap((g) => g.items.map((i) => i.label));
    expect(shown).toContain("Cash shifts");
  });
  it("shows Night audit to someone who can only view folios, such as the POS cashier", () => {
    const shown = allowedGroups({ isSuperuser: false, permissions: ["folio.view"] }).flatMap((g) => g.items.map((i) => i.label));
    expect(shown).toContain("Night audit");
  });
});

describe("flash report — a last-year period with no trade says so (section 9)", () => {
  const empty = { rooms_available: 30, rooms_sold: 0, room_revenue: 0, comp_rooms: 0, house_rooms: 0, revenue: {} } as never;
  const zeroDepts = { rooms_available: 30, rooms_sold: 0, room_revenue: 0, comp_rooms: 0, house_rooms: 0, revenue: { rooms: 0 } } as never;
  const traded = { rooms_available: 30, rooms_sold: 4, room_revenue: 20000, comp_rooms: 0, house_rooms: 0, revenue: { rooms: 20000 } } as never;
  const outletOnly = { rooms_available: 30, rooms_sold: 0, room_revenue: 0, comp_rooms: 0, house_rooms: 0, revenue: { fnb: 900 } } as never;
  it("treats rooms available alone as no data", () => {
    expect(periodHasData(empty)).toBe(false);
    expect(periodHasData(zeroDepts)).toBe(false);
    expect(periodHasData(undefined)).toBe(false);
  });
  it("counts rooms sold or any revenue as data", () => {
    expect(periodHasData(traded)).toBe(true);
    expect(periodHasData(outletOnly)).toBe(true);
  });
});
