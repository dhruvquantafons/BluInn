import type { createClient } from "./supabase/server";
import { addDays, isIsoDate, zonedTime } from "./dates";
import { isAuditModule } from "./audit";

type Client = Awaited<ReturnType<typeof createClient>>;

export interface AuditFilters {
  module?: string;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * The audit log query with the page's filters. Dates are the hotel's days:
 * "from 6 Nov" starts at midnight hotel time, not midnight UTC.
 */
export function auditQuery(supabase: Client, f: AuditFilters, timeZone: string) {
  let query = supabase.from("audit_log").select("*").order("occurred_at", { ascending: false });
  if (isAuditModule(f.module)) query = query.eq("module", f.module);
  if (f.q) {
    const term = `%${f.q.replace(/[%,()]/g, "")}%`;
    query = query.or(`actor_name.ilike.${term},record_id.ilike.${term},summary.ilike.${term},action.ilike.${term}`);
  }
  if (f.from && isIsoDate(f.from)) query = query.gte("occurred_at", zonedTime(f.from, "00:00", timeZone).toISOString());
  if (f.to && isIsoDate(f.to)) query = query.lt("occurred_at", zonedTime(addDays(f.to, 1), "00:00", timeZone).toISOString());
  return query;
}
