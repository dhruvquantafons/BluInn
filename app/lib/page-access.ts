/**
 * Who may open each page, in one place. The sidebar, the section tabs and the
 * in-page links use it to show a link only to someone the page will admit;
 * before this, 13 links led people to "access denied".
 *
 * Each entry mirrors the page's own guard (requirePermission /
 * requireAnyPermission), which still does the enforcing. tests/
 * links-and-validations.test.ts reads every page and fails if the two drift.
 *
 * "any" means any signed-in staff member. A page missing from the map is
 * treated as open: guarded somewhere else, or not a page people link to.
 */
export const PAGE_ACCESS: Record<string, string[] | "any"> = {
  "/": "any",
  "/front-desk": ["frontdesk.view"],
  "/front-desk/shifts": ["folio.cashier", "folio.cashier_audit", "reports.financial"],
  "/front-desk/shifts/[id]": ["folio.cashier", "folio.cashier_audit", "reports.financial"],
  "/bookings": ["bookings.view"],
  "/bookings/new": ["bookings.create"],
  "/bookings/[id]": ["bookings.view", "frontdesk.view"],
  "/bookings/[id]/check-in": ["frontdesk.checkin"],
  "/bookings/[id]/check-out": ["frontdesk.checkout"],
  "/bookings/[id]/folio": ["folio.view", "bookings.view"],
  "/bookings/[id]/identity": ["guests.view_id"],
  "/bookings/[id]/invoice/[invoiceId]": ["folio.view", "bookings.view"],
  "/bookings/[id]/registration-card": ["frontdesk.view", "bookings.view"],
  "/guests": ["guests.view"],
  "/guests/[id]": ["guests.view"],
  "/guests/duplicates": ["guests.privacy"],
  "/guests/feedback": ["guests.view"],
  "/guests/loyalty": ["guests.view"],
  "/guests/occasions": ["guests.view"],
  "/groups": ["bookings.groups"],
  "/groups/new": ["bookings.groups"],
  "/groups/[id]": ["bookings.groups"],
  "/tape-chart": ["bookings.view", "frontdesk.view"],
  "/night-audit": ["frontdesk.night_audit", "folio.view"],
  "/night-audit/[date]": ["frontdesk.night_audit", "folio.view"],

  "/rooms": ["rooms.view"],
  "/housekeeping": ["housekeeping.assign", "housekeeping.inspect"],
  "/housekeeping/my-tasks": ["housekeeping.tasks"],
  "/housekeeping/lost-found": ["housekeeping.lost_found"],
  "/housekeeping/setup": ["housekeeping.assign"],
  "/maintenance": ["maintenance.report", "maintenance.work", "maintenance.manage"],
  "/maintenance/[id]": ["maintenance.report", "maintenance.work", "maintenance.manage"],
  "/maintenance/mine": ["maintenance.work"],
  "/maintenance/assets": ["maintenance.work", "maintenance.manage"],
  "/maintenance/assets/[id]": ["maintenance.work", "maintenance.manage"],
  "/maintenance/preventive": ["maintenance.work", "maintenance.manage"],
  "/maintenance/setup": ["maintenance.manage"],
  "/inventory": ["inventory.view", "inventory.manage"],
  "/inventory/movements": ["inventory.view", "inventory.manage"],
  "/inventory/setup": ["inventory.manage"],
  "/pos": ["pos.view", "pos.order", "pos.pay", "pos.manage"],
  "/pos/[outletId]": ["pos.view", "pos.order", "pos.pay"],
  "/pos/menu": ["pos.manage"],
  "/pos/orders/[id]": ["pos.view", "pos.order", "pos.pay"],
  "/pos/orders/[id]/bill": ["pos.view", "pos.order", "pos.pay"],
  "/pos/orders/[id]/kot": ["pos.view", "pos.order"],
  "/events": ["events.view", "events.book", "events.quote", "events.approve", "events.bill"],
  "/events/diary": ["events.view", "events.book", "events.quote", "events.approve", "events.bill"],
  "/events/setup": ["events.manage"],
  "/events/[id]": ["events.view", "events.book", "events.quote", "events.approve", "events.bill"],
  "/events/[id]/beo": ["events.view", "events.book"],
  "/events/[id]/contract": ["events.view", "events.book"],
  "/events/[id]/quotation": ["events.view", "events.quote", "events.book"],
  "/events/[id]/invoice/[invoiceId]": ["folio.view", "events.view", "events.bill"],

  "/rates": ["rates.view", "rates.manage"],
  "/rates/plans": ["rates.view", "rates.manage"],
  "/rates/seasons": ["rates.view", "rates.manage"],
  "/rates/restrictions": ["rates.view", "rates.manage"],
  "/rates/allocations": ["rates.view", "rates.manage"],
  "/revenue": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/revenue/rules": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/revenue/approvals": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/revenue/packages": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/revenue/promos": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/revenue/competitors": ["revenue.view", "revenue.manage", "revenue.approve"],
  "/billing/invoices": ["folio.view", "folio.invoice"],
  "/billing/credit-notes": ["folio.view", "folio.invoice", "folio.credit_note", "reports.financial"],
  "/billing/credit-notes/[id]": ["folio.view", "bookings.view", "reports.financial"],
  "/billing/gst-register": ["reports.financial"],
  "/billing/refunds": ["folio.view", "folio.refund_approve"],
  "/billing/currencies": ["folio.view", "folio.invoice", "settings.manage"],
  "/reports": ["reports.view", "reports.financial"],
  "/reports/flash": ["reports.financial"],
  "/reports/financial": ["reports.financial"],
  "/reports/operations": ["reports.view"],
  "/reports/guests": ["reports.view"],
  "/reports/builder": ["reports.view", "reports.financial"],
  "/reports/schedules": ["reports.schedule"],
  "/notifications": ["guests.view", "settings.manage", "audit.view"],

  "/hr": "any",
  "/hr/profile": "any",
  "/hr/roster": ["hr.view", "hr.manage"],
  "/hr/attendance": ["hr.view", "hr.manage", "hr.export"],
  "/hr/timesheets": ["hr.view", "hr.approve_time"],
  "/hr/leave": ["hr.approve_leave", "hr.view"],
  "/hr/staff": ["hr.view", "hr.manage"],
  "/hr/staff/[id]": ["hr.view", "hr.manage"],
  "/hr/setup": ["hr.manage"],
  "/staff": ["staff.manage"],
  "/staff/activity": ["staff.manage"],

  "/properties": ["properties.view", "properties.manage"],
  "/roles": ["roles.manage"],
  "/settings": ["settings.manage"],
  "/settings/status": ["settings.manage"],
  "/settings/templates": ["settings.manage"],
  "/settings/export": ["data.export"],
  "/audit": ["audit.view"],
  "/audit/security": ["audit.view"],
};

/** The Billing tabs, in the order the section's link tries them. */
export const BILLING_TABS = [
  "/billing/invoices",
  "/billing/credit-notes",
  "/billing/gst-register",
  "/billing/refunds",
  "/billing/currencies",
];
export const REPORT_TABS = [
  "/reports",
  "/reports/flash",
  "/reports/financial",
  "/reports/operations",
  "/reports/guests",
  "/reports/builder",
  "/reports/schedules",
];
export const EVENT_TABS = ["/events", "/events/diary", "/events/setup"];

export type PageAccess = { isSuperuser: boolean; permissions: ReadonlySet<string> | readonly string[] };

const PATTERNS = Object.keys(PAGE_ACCESS)
  .filter((k) => k.includes("["))
  .map((k) => ({ key: k, re: new RegExp("^" + k.replace(/\[[^\]]+\]/g, "[^/]+") + "$") }));

/** The map's key for a URL: itself, or the pattern it matches ("/maintenance/assets/[id]"). */
function keyFor(href: string): string | null {
  const pathname = href.split(/[?#]/)[0].replace(/\/$/, "") || "/";
  if (pathname in PAGE_ACCESS) return pathname;
  return PATTERNS.find((p) => p.re.test(pathname))?.key ?? null;
}

/** Whether this person may open a page. */
export function canOpen(access: PageAccess, href: string): boolean {
  if (access.isSuperuser) return true;
  const key = keyFor(href);
  if (!key) return true;
  const needed = PAGE_ACCESS[key];
  if (needed === "any") return true;
  const has = (p: string) =>
    Array.isArray(access.permissions) ? access.permissions.includes(p) : (access.permissions as ReadonlySet<string>).has(p);
  return needed.some(has);
}

/** The first of these pages the person may open, or null. */
export function firstOpenable(access: PageAccess, hrefs: string[]): string | null {
  return hrefs.find((h) => canOpen(access, h)) ?? null;
}

/** Section tabs trimmed to the ones the person may open. */
export function openableTabs<T extends { href: string }>(access: PageAccess, tabs: T[]): T[] {
  return tabs.filter((t) => canOpen(access, t.href));
}
