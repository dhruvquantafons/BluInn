import type { AuditEntry } from "./types";

/**
 * The audit log's filters and its security view (0038). Pure helpers, unit
 * tested in tests/audit.test.ts; the queries live with the pages.
 */

/** Every module that writes to the audit log, for the filter. */
export const AUDIT_MODULES = [
  "admin",
  "bookings",
  "companies",
  "events",
  "folio",
  "frontdesk",
  "guests",
  "housekeeping",
  "hr",
  "inventory",
  "maintenance",
  "pos",
  "properties",
  "rates",
  "reports",
  "roles",
  "rooms",
  "settings",
  "staff",
] as const;

export function isAuditModule(value: string | undefined): value is (typeof AUDIT_MODULES)[number] {
  return !!value && (AUDIT_MODULES as readonly string[]).includes(value);
}

/** Actions written by log_event() that matter for security. */
export const SECURITY_ACTIONS = [
  "2fa_enrolled",
  "2fa_reset",
  "end_sessions",
  "payroll_export",
  "data_export",
  "audit_export",
  "export",
  "view_id",
] as const;

/** Changes to these columns of a staff record are security events. */
export const SECURITY_STAFF_FIELDS = [
  "role",
  "is_active",
  "all_properties",
  "property_id",
  "password_changed_at",
  "must_change_password",
  "sessions_revoked_at",
] as const;

export function isSecurityEvent(e: Pick<AuditEntry, "module" | "table_name" | "action" | "changed">): boolean {
  if (e.module === "roles") return true;
  if ((SECURITY_ACTIONS as readonly string[]).includes(e.action)) return true;
  if (e.table_name === "staff") {
    if (e.action === "insert" || e.action === "delete") return true;
    return (e.changed ?? []).some((c) => (SECURITY_STAFF_FIELDS as readonly string[]).includes(c));
  }
  return false;
}

const LABELS: Record<string, string> = {
  "2fa_enrolled": "Two-step sign-in set up",
  "2fa_reset": "Two-step sign-in reset",
  end_sessions: "Sessions ended",
  payroll_export: "Payroll exported",
  data_export: "Property data downloaded",
  audit_export: "Audit log downloaded",
  export: "Guest data exported",
  view_id: "Identity document viewed",
};

/** A short name for a security event. */
export function securityLabel(e: Pick<AuditEntry, "module" | "table_name" | "action" | "changed" | "before" | "after">): string {
  if (LABELS[e.action]) return LABELS[e.action];
  if (e.table_name === "role_permissions") return e.action === "delete" ? "Permission removed from a role" : "Permission added to a role";
  if (e.table_name === "roles") {
    return e.action === "insert" ? "Role created" : e.action === "delete" ? "Role deleted" : "Role changed";
  }
  if (e.table_name === "staff") {
    if (e.action === "insert") return "Staff account created";
    if (e.action === "delete") return "Staff account removed";
    const changed = e.changed ?? [];
    if (changed.includes("role")) return `Role changed to ${String(e.after?.role ?? "")}`;
    if (changed.includes("is_active")) return e.after?.is_active ? "Account reactivated" : "Account suspended";
    if (changed.includes("all_properties") || changed.includes("property_id")) return "Hotel access changed";
    if (changed.includes("sessions_revoked_at")) return "Sessions ended";
    if (changed.includes("password_changed_at") || changed.includes("must_change_password")) return "Password changed";
  }
  return `${e.module} ${e.action}`;
}

/** Audit rows as CSV rows: one line each, values flattened. */
export function auditCsvRows(rows: AuditEntry[], dayTime: (iso: string) => string): (string | number)[][] {
  const flat = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return [
    ["When", "Who", "Module", "Table", "Record", "Action", "Summary", "Changed fields", "Before", "After"],
    ...rows.map((e) => [
      dayTime(e.occurred_at),
      e.actor_name,
      e.module,
      e.table_name ?? "",
      e.record_id ?? "",
      e.action,
      e.summary ?? "",
      (e.changed ?? []).join(" "),
      e.action === "update" ? flat(pick(e.before, e.changed)) : flat(e.before),
      e.action === "update" ? flat(pick(e.after, e.changed)) : flat(e.after),
    ]),
  ];
}

function pick(obj: Record<string, unknown> | null, keys: string[] | null) {
  if (!obj) return null;
  if (!keys?.length) return obj;
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
