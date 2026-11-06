/**
 * Every permission a role can hold, grouped by module (Module 15:
 * "configurable at the module and action level").
 *
 * The keys are also referenced by row level security policies in
 * neon/migrations, so renaming one means changing it there too.
 */

export const PERMISSION_GROUPS = [
  {
    module: "Dashboard",
    permissions: [{ key: "dashboard.view", label: "View the dashboard" }],
  },
  {
    module: "Reservations",
    permissions: [
      { key: "bookings.view", label: "View bookings" },
      { key: "bookings.create", label: "Create bookings" },
      { key: "bookings.edit", label: "Change dates, rooms and rates" },
      { key: "bookings.cancel", label: "Cancel and mark no-show" },
      { key: "bookings.waive_penalty", label: "Waive cancellation penalties" },
      { key: "bookings.overbook", label: "Override overbooking" },
      { key: "bookings.complimentary", label: "Approve complimentary and house-use stays" },
      { key: "bookings.groups", label: "Group bookings" },
    ],
  },
  {
    module: "Front desk",
    permissions: [
      { key: "frontdesk.view", label: "View arrivals, departures and in-house" },
      { key: "frontdesk.checkin", label: "Check guests in" },
      { key: "frontdesk.checkout", label: "Check guests out" },
      { key: "frontdesk.requests", label: "Log and complete guest requests" },
      { key: "frontdesk.night_audit", label: "Run night audit and close the business day" },
      { key: "frontdesk.checkin_override", label: "Check a guest into a room not yet inspected (with a reason)" },
    ],
  },
  {
    module: "Guests",
    permissions: [
      { key: "guests.view", label: "View guest profiles" },
      { key: "guests.edit", label: "Edit guest profiles" },
      { key: "guests.view_id", label: "View identity documents" },
      { key: "guests.privacy", label: "Merge duplicates, export and erase guest data" },
      { key: "loyalty.manage", label: "Loyalty programme: tiers, enrolment and corrections" },
      { key: "loyalty.redeem", label: "Redeem loyalty points against a bill" },
    ],
  },
  {
    module: "Folio & payments",
    permissions: [
      { key: "folio.view", label: "View folios" },
      { key: "folio.post", label: "Post charges" },
      { key: "folio.payment", label: "Take payments and refunds" },
      { key: "folio.adjust", label: "Adjustments and voids" },
      { key: "folio.invoice", label: "Issue and cancel tax invoices" },
      { key: "folio.refund_approve", label: "Approve refunds" },
      { key: "folio.credit_note", label: "Issue GST credit notes against invoices" },
      { key: "folio.cashier", label: "Open and close my cash shift; pay-ins, paid-outs and safe drops" },
      { key: "folio.cashier_audit", label: "See every cash shift, close anyone's and review variances" },
    ],
  },
  {
    module: "Point of sale",
    permissions: [
      { key: "pos.view", label: "View outlets, bills and takings" },
      { key: "pos.order", label: "Open bills and take orders" },
      { key: "pos.pay", label: "Settle bills and charge to a room" },
      { key: "pos.manage", label: "Manage outlets, menus, prices and void bills" },
    ],
  },
  {
    module: "Events & banquets",
    permissions: [
      { key: "events.view", label: "View the events diary and event orders" },
      { key: "events.book", label: "Take enquiries, confirm and cancel events" },
      { key: "events.quote", label: "Prepare and send quotations" },
      { key: "events.approve", label: "Approve quotations above the threshold" },
      { key: "events.bill", label: "Take deposits and bill events" },
      { key: "events.manage", label: "Manage spaces, layouts, catering packages and equipment" },
    ],
  },
  {
    module: "Rooms",
    permissions: [
      { key: "rooms.view", label: "View the room board" },
      { key: "rooms.status", label: "Change room and housekeeping status" },
      { key: "rooms.block", label: "Block rooms (out of order / service)" },
      { key: "rooms.manage", label: "Add, edit and remove rooms" },
    ],
  },
  {
    module: "Housekeeping",
    permissions: [
      { key: "housekeeping.tasks", label: "Work cleaning tasks" },
      { key: "housekeeping.inspect", label: "Inspect and approve rooms" },
      { key: "housekeeping.assign", label: "Assign tasks, zones and checklists" },
      { key: "housekeeping.lost_found", label: "Lost & found" },
      { key: "housekeeping.post_charges", label: "Post minibar and laundry to a guest's room" },
    ],
  },
  {
    module: "Maintenance",
    permissions: [
      { key: "maintenance.report", label: "Report problems (raise tickets)" },
      { key: "maintenance.work", label: "Work maintenance tickets" },
      { key: "maintenance.manage", label: "Assign tickets, assets, preventive schedules and targets" },
    ],
  },
  {
    module: "Inventory",
    permissions: [
      { key: "inventory.view", label: "View stock levels and movements" },
      { key: "inventory.manage", label: "Receive, issue, count and write off stock; set up items and locations" },
    ],
  },
  {
    module: "HR",
    permissions: [
      { key: "hr.view", label: "View rosters, attendance and staff profiles" },
      { key: "hr.manage", label: "Edit profiles, rosters, attendance and shift setup" },
      { key: "hr.approve_leave", label: "Approve leave requests" },
      { key: "hr.approve_time", label: "Approve weekly timesheets and overtime" },
      { key: "hr.export", label: "Export payroll data" },
    ],
  },
  {
    module: "Rates",
    permissions: [
      { key: "rates.view", label: "View rates and plans" },
      { key: "rates.manage", label: "Change rates, plans, seasons, restrictions and packages" },
    ],
  },
  {
    module: "Revenue",
    permissions: [
      { key: "revenue.view", label: "View the forecast, pricing rules and competitor rates" },
      { key: "revenue.manage", label: "Set pricing rules, promo codes and competitor rates" },
      { key: "revenue.approve", label: "Approve rate changes above the automatic threshold" },
    ],
  },
  {
    module: "Reports",
    permissions: [
      { key: "reports.view", label: "Operational and guest reports" },
      { key: "reports.financial", label: "Financial reports: revenue, tax, outlet sales, money owed" },
      { key: "reports.schedule", label: "Set up scheduled email reports" },
    ],
  },
  {
    module: "Properties",
    permissions: [
      { key: "properties.view", label: "Compare properties across the group" },
      { key: "properties.manage", label: "Add properties and push group standards" },
    ],
  },
  {
    module: "Administration",
    permissions: [
      { key: "staff.manage", label: "Manage staff accounts" },
      { key: "roles.manage", label: "Manage roles and permissions" },
      { key: "settings.manage", label: "Change property settings" },
      { key: "audit.view", label: "View the audit log" },
      { key: "data.export", label: "Download a property's data (bookings, guests, billing, staff)" },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["permissions"][number]["key"];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/**
 * Keys that row level security still checks but that no screen offers any
 * more (the corporate accounts and city ledger were removed in November 2026;
 * their tables and data remain). They are not shown on the Roles page, and
 * saving a role must leave them as they are rather than delete them.
 */
export const HIDDEN_PERMISSIONS = ["companies.manage", "folio.city_ledger"] as const;

/** What the app needs to decide access for the signed-in person. */
export interface Access {
  isSuperuser: boolean;
  permissions: ReadonlySet<string>;
}

export function can(access: Access, permission: Permission) {
  return access.isSuperuser || access.permissions.has(permission);
}

export function canAny(access: Access, permissions: Permission[]) {
  return permissions.some((p) => can(access, p));
}
