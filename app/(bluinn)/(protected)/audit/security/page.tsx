import { } from "lucide-react";
import { createClient, createServiceClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { hasServiceAccess } from "../../../../lib/supabase/config";
import { addDays, isIsoDate, todayIn, zonedTime } from "../../../../lib/dates";
import { SECURITY_ACTIONS, isSecurityEvent, securityLabel } from "../../../../lib/audit";
import type { AuditEntry } from "../../../../lib/types";
import {
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Pagination,
  SectionTitle,
  StatCard,
  Tag,
  buttonClass,
  clampPage,
  fmtDateTime,
  inputClass,
  pageParam,
  pageRange,
  tableHeadClass,
} from "../../../components/ui";
import SectionTabs from "../../../components/SectionTabs";

type Attempt = { email: string; succeeded: boolean; ip: string; attempted_at: string };

/**
 * Security events (0038): sign-ins and failures, and every change to who can
 * do what — roles and permissions, staff roles, suspensions, hotel access,
 * passwords, two-step sign-in, ended sessions — plus data downloads.
 */
export default async function SecurityEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; who?: string; page?: string; spage?: string }>;
}) {
  await requirePermission("audit.view");
  const p = await searchParams;
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const from = p.from && isIsoDate(p.from) ? p.from : addDays(today, -6);
  const to = p.to && isIsoDate(p.to) ? p.to : today;
  const start = zonedTime(from, "00:00", tz).toISOString();
  const end = zonedTime(addDays(to, 1), "00:00", tz).toISOString();
  const who = (p.who ?? "").trim().toLowerCase();
  const supabase = await createClient();

  const [{ data: logged }, { data: staffRows }] = await Promise.all([
    supabase
      .from("audit_log")
      .select("*")
      .gte("occurred_at", start)
      .lt("occurred_at", end)
      .or(`module.eq.roles,table_name.eq.staff,action.in.(${SECURITY_ACTIONS.join(",")})`)
      .order("occurred_at", { ascending: false })
      .limit(1000),
    supabase.from("staff").select("id, full_name, email"),
  ]);
  const events = ((logged ?? []) as AuditEntry[])
    .filter(isSecurityEvent)
    .filter((e) => !who || e.actor_name.toLowerCase().includes(who) || (e.summary ?? "").toLowerCase().includes(who));

  // Sign-in attempts are readable only with the service key.
  let attempts: Attempt[] = [];
  if (hasServiceAccess()) {
    const { data } = await createServiceClient()
      .from("login_attempts")
      .select("email, succeeded, ip, attempted_at")
      .gte("attempted_at", start)
      .lt("attempted_at", end)
      .order("attempted_at", { ascending: false })
      .limit(1000);
    attempts = ((data ?? []) as Attempt[]).filter((a) => !who || a.email.toLowerCase().includes(who));
  }
  const known = new Set((staffRows ?? []).map((s) => s.email.toLowerCase()));
  const nameOf = new Map((staffRows ?? []).map((s) => [s.id, s.full_name || s.email]));
  const failed = attempts.filter((a) => !a.succeeded);

  // Both lists are filtered in JS (and the headline figures count all of
  // them), so each is sliced here: ?page= for access changes, ?spage= for
  // sign-in attempts.
  const page = clampPage(pageParam(p.page), events.length);
  const spage = clampPage(pageParam(p.spage), attempts.length);
  const pageOf = <T,>(list: T[], n: number) => {
    const [first, last] = pageRange(n);
    return list.slice(first, last + 1);
  };
  const eventRows = pageOf(events, page);
  const attemptRows = pageOf(attempts, spage);
  const filterParams = { who: p.who, from: p.from, to: p.to };

  return (
    <>
      <PageHeader title="Audit log" description="Sign-ins, and every change to who can do what." />
      <SectionTabs
        tabs={[
          { href: "/audit", label: "All changes" },
          { href: "/audit/security", label: "Security events" },
        ]}
        label="Audit sections"
      />

      <form className="flex flex-wrap gap-2 mb-5" action="/audit/security">
        <input name="who" defaultValue={p.who} placeholder="Person or email" className={`${inputClass} max-w-xs`} />
        <input type="date" name="from" defaultValue={from} className={`${inputClass} max-w-[160px]`} />
        <input type="date" name="to" defaultValue={to} className={`${inputClass} max-w-[160px]`} />
        <button className={buttonClass}>Filter</button>
      </form>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Sign-ins" value={hasServiceAccess() ? attempts.length - failed.length : "—"} />
        <StatCard label="Failed sign-ins" value={hasServiceAccess() ? failed.length : "—"} />
        <StatCard
          label="Unknown emails tried"
          value={hasServiceAccess() ? new Set(failed.filter((a) => !known.has(a.email.toLowerCase())).map((a) => a.email.toLowerCase())).size : "—"}
        />
        <StatCard label="Access changes" value={events.length} hint="Roles, permissions, accounts, exports" />
      </div>

      <Card className="mb-6">
        <div className="px-4 pt-4">
          <SectionTitle>Access changes and downloads</SectionTitle>
        </div>
        {events.length === 0 ? (
          <EmptyState message="None in this period" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Who</th>
                  <th className="px-4 py-2 font-semibold">What</th>
                  <th className="px-4 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {eventRows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-700">{fmtDateTime(e.occurred_at)}</td>
                    <td className="px-4 py-2">{e.actor_name || "System"}</td>
                    <td className="px-4 py-2">
                      <Tag tone={e.module === "roles" ? "violet" : "gold"}>{securityLabel(e)}</Tag>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {e.summary ||
                        (e.table_name === "staff" && e.record_id
                          ? (nameOf.get(e.record_id) ?? String(e.after?.full_name ?? e.before?.full_name ?? e.record_id))
                          : e.table_name === "role_permissions"
                            ? `${String((e.after ?? e.before)?.role_key ?? "")}: ${String((e.after ?? e.before)?.permission ?? "")}`
                            : String((e.after ?? e.before)?.name ?? e.record_id ?? ""))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={page}
          total={events.length}
          path="/audit/security"
          params={{ ...filterParams, spage: spage > 1 ? String(spage) : null }}
        />
      </Card>

      <Card>
        <div className="px-4 pt-4">
          <SectionTitle>Sign-in attempts</SectionTitle>
        </div>
        {!hasServiceAccess() ? (
          <div className="px-4 pb-4">
            <Notice tone="warn">Sign-in attempts are kept where only the server can read them. Set the service key to see them here.</Notice>
          </div>
        ) : attempts.length === 0 ? (
          <EmptyState message="None in this period" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Result</th>
                  <th className="px-4 py-2 font-semibold">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attemptRows.map((a, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-700">{fmtDateTime(a.attempted_at)}</td>
                    <td className="px-4 py-2">
                      {a.email}
                      {!known.has(a.email.toLowerCase()) && <span className="ml-1 text-[10px] text-rose-700">not a staff account</span>}
                    </td>
                    <td className="px-4 py-2">
                      <Tag tone={a.succeeded ? "green" : "red"}>{a.succeeded ? "Signed in" : "Failed"}</Tag>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{a.ip || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasServiceAccess() && (
          <Pagination
            page={spage}
            total={attempts.length}
            path="/audit/security"
            param="spage"
            params={{ ...filterParams, page: page > 1 ? String(page) : null }}
          />
        )}
      </Card>
    </>
  );
}
