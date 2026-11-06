import { createClient } from "../../../../lib/supabase/server";
import { getSession } from "../../../../lib/auth";
import { can } from "../../../../lib/permissions";
import { getSettings } from "../../../../lib/settings";
import { toCsv } from "../../../../lib/hr";
import { auditCsvRows } from "../../../../lib/audit";
import { auditQuery } from "../../../../lib/audit-query";
import type { AuditEntry } from "../../../../lib/types";

const PAGE = 1000;
const MAX = 50000;

/**
 * The audit log as CSV, with the same filters as the page (0038). Read a
 * thousand rows at a time, up to 50,000; the download itself is logged.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Not signed in.", { status: 401 });
  if (!can(session, "audit.view")) return new Response("Your role does not allow this.", { status: 403 });

  const url = new URL(request.url);
  const filters = {
    module: url.searchParams.get("module") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  const settings = await getSettings();
  const supabase = await createClient();

  const rows: AuditEntry[] = [];
  for (let start = 0; start < MAX; start += PAGE) {
    const { data, error } = await auditQuery(supabase, filters, settings.timezone).range(start, start + PAGE - 1);
    if (error) return new Response(error.message, { status: 403 });
    rows.push(...((data ?? []) as AuditEntry[]));
    if (!data || data.length < PAGE) break;
  }

  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const csv = toCsv([
    [`Audit log — ${settings.name}`],
    [Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ") || "All entries"],
    rows.length >= MAX ? [`Limited to the newest ${MAX.toLocaleString("en-IN")} entries; narrow the dates for more.`] : [],
    [],
    ...auditCsvRows(rows, (iso) => fmt.format(new Date(iso))),
  ]);

  await supabase.rpc("log_event", {
    p_module: "admin",
    p_action: "audit_export",
    p_record_id: "",
    p_summary: `Audit log downloaded (${rows.length} entries) by ${session.staff.full_name || session.staff.email}`,
  });

  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
