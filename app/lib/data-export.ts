/**
 * What the property data export contains (0038), in the order a person
 * reading the ZIP would want it. Each is read through the downloader's own
 * client, filtered to the current property, so nothing they could not
 * already see is in it.
 *
 * Deliberately left out: identity-document numbers and scans
 * (guest_identities, guest_documents), photos and other files, sign-in
 * history and anything in the auth schema.
 */
/** `order` is the column to page by, for tables without an `id`. */
export const EXPORT_TABLES: { table: string; file: string; label: string; order?: string }[] = [
  { table: "room_types", file: "rooms/room_types.csv", label: "Room types" },
  { table: "rooms", file: "rooms/rooms.csv", label: "Rooms" },
  { table: "room_blocks", file: "rooms/room_blocks.csv", label: "Rooms off sale" },
  { table: "rate_plans", file: "rates/rate_plans.csv", label: "Rate plans" },
  { table: "rate_seasons", file: "rates/rate_seasons.csv", label: "Seasons" },
  { table: "rate_restrictions", file: "rates/rate_restrictions.csv", label: "Restrictions" },
  { table: "promo_codes", file: "rates/promo_codes.csv", label: "Promo codes" },
  { table: "guests", file: "guests/guests.csv", label: "Guests" },
  { table: "guest_feedback", file: "guests/guest_feedback.csv", label: "Guest feedback" },
  { table: "loyalty_transactions", file: "guests/loyalty_transactions.csv", label: "Loyalty points" },
  { table: "bookings", file: "bookings/bookings.csv", label: "Bookings" },
  { table: "booking_guests", file: "bookings/booking_guests.csv", label: "Guests in each room", order: "added_at" },
  { table: "booking_groups", file: "bookings/booking_groups.csv", label: "Groups" },
  { table: "room_moves", file: "bookings/room_moves.csv", label: "Room moves" },
  { table: "guest_requests", file: "bookings/guest_requests.csv", label: "Requests and traces" },
  { table: "folios", file: "billing/folios.csv", label: "Folios" },
  { table: "folio_entries", file: "billing/folio_entries.csv", label: "Folio lines" },
  { table: "invoices", file: "billing/invoices.csv", label: "Invoices" },
  { table: "credit_notes", file: "billing/credit_notes.csv", label: "Credit notes" },
  { table: "payment_transactions", file: "billing/online_payments.csv", label: "Online payments" },
  { table: "refund_requests", file: "billing/refund_requests.csv", label: "Refunds" },
  { table: "cashier_shifts", file: "billing/cashier_shifts.csv", label: "Cash shifts" },
  { table: "cash_movements", file: "billing/cash_movements.csv", label: "Pay-ins and paid-outs" },
  { table: "night_audits", file: "billing/night_audits.csv", label: "Night audits", order: "business_date" },
  { table: "pos_outlets", file: "pos/outlets.csv", label: "Outlets" },
  { table: "pos_items", file: "pos/items.csv", label: "Menu items" },
  { table: "pos_orders", file: "pos/orders.csv", label: "Outlet bills" },
  { table: "pos_order_lines", file: "pos/order_lines.csv", label: "Outlet bill lines" },
  { table: "pos_payments", file: "pos/payments.csv", label: "Outlet payments" },
  { table: "event_spaces", file: "events/spaces.csv", label: "Event spaces" },
  { table: "event_bookings", file: "events/events.csv", label: "Events" },
  { table: "event_lines", file: "events/event_lines.csv", label: "Event lines" },
  { table: "event_payments", file: "events/event_payments.csv", label: "Event payments" },
  { table: "housekeeping_tasks", file: "operations/housekeeping_tasks.csv", label: "Housekeeping tasks" },
  { table: "maintenance_tickets", file: "operations/maintenance_tickets.csv", label: "Maintenance tickets" },
  { table: "lost_found_items", file: "operations/lost_and_found.csv", label: "Lost and found" },
  { table: "inventory_items", file: "operations/inventory_items.csv", label: "Stock items" },
  { table: "inventory_movements", file: "operations/inventory_movements.csv", label: "Stock movements" },
  { table: "staff", file: "people/staff.csv", label: "Staff" },
  { table: "departments", file: "people/departments.csv", label: "Departments" },
  { table: "shift_types", file: "people/shift_types.csv", label: "Shift types" },
  { table: "staff_shifts", file: "people/roster.csv", label: "Roster" },
  { table: "attendance", file: "people/attendance.csv", label: "Attendance" },
  { table: "leave_requests", file: "people/leave.csv", label: "Leave" },
  { table: "timesheets", file: "people/timesheets.csv", label: "Timesheets" },
];

/** Large free-form columns that are not data a hotel would move: signatures and the like. */
export const EXPORT_SKIP_COLUMNS = new Set(["signature", "signature_data", "photo_data", "secret"]);

/** Rows as CSV with a header made of every column seen. Objects become JSON. */
export function rowsToCsvGrid(rows: Record<string, unknown>[]): (string | number)[][] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) if (!columns.includes(k) && !EXPORT_SKIP_COLUMNS.has(k)) columns.push(k);
  }
  const cell = (v: unknown): string | number =>
    v === null || v === undefined ? "" : typeof v === "number" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return [columns, ...rows.map((r) => columns.map((c) => cell(r[c])))];
}
