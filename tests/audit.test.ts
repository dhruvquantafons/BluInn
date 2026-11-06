import { describe, it, expect } from "vitest";
import { auditCsvRows, isAuditModule, isSecurityEvent, securityLabel } from "../app/lib/audit";
import type { AuditEntry } from "../app/lib/types";

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  id: 1, occurred_at: "2026-11-06T04:30:00Z", actor_id: null, actor_name: "Asha", module: "bookings",
  table_name: "bookings", record_id: "r1", action: "update", summary: "", changed: [], before: null, after: null, ...e,
});

describe("audit log helpers", () => {
  it("knows every module, including the ones the old filter missed", () => {
    for (const m of ["pos", "events", "properties", "reports", "inventory", "admin"]) expect(isAuditModule(m)).toBe(true);
    expect(isAuditModule("nope")).toBe(false);
  });

  it("picks out security events", () => {
    expect(isSecurityEvent(entry({ module: "roles", table_name: "role_permissions", action: "insert" }))).toBe(true);
    expect(isSecurityEvent(entry({ module: "staff", table_name: "staff", changed: ["role"] }))).toBe(true);
    expect(isSecurityEvent(entry({ module: "staff", table_name: "staff", changed: ["last_seen_at"] }))).toBe(false);
    expect(isSecurityEvent(entry({ module: "staff", action: "2fa_reset", table_name: "" }))).toBe(true);
    expect(isSecurityEvent(entry({}))).toBe(false);
  });

  it("names them", () => {
    expect(securityLabel(entry({ table_name: "staff", changed: ["is_active"], after: { is_active: false } }))).toBe("Account suspended");
    expect(securityLabel(entry({ table_name: "staff", changed: ["role"], after: { role: "admin" } }))).toBe("Role changed to admin");
    expect(securityLabel(entry({ action: "data_export" }))).toBe("Property data downloaded");
  });

  it("flattens rows for CSV, keeping only changed fields on an update", () => {
    const [header, row] = auditCsvRows(
      [entry({ changed: ["status"], before: { status: "confirmed", x: 1 }, after: { status: "cancelled", x: 1 } })],
      () => "06 Nov 2026 10:00",
    );
    expect(header[0]).toBe("When");
    expect(row).toEqual(["06 Nov 2026 10:00", "Asha", "bookings", "bookings", "r1", "update", "", "status",
      '{"status":"confirmed"}', '{"status":"cancelled"}']);
  });
});
