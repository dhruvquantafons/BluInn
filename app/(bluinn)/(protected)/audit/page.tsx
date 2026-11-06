import { } from "lucide-react";
import Link from "next/link";
import { createClient } from "../../../lib/supabase/server";
import { requirePermission } from "../../../lib/auth";
import { getSettings } from "../../../lib/settings";
import { AUDIT_MODULES } from "../../../lib/audit";
import { auditQuery } from "../../../lib/audit-query";
import type { AuditEntry } from "../../../lib/types";
import { PageHeader, Card, EmptyState, Tag, fmtDateTime, inputClass, buttonClass, secondaryButtonClass, tableHeadClass } from "../../components/ui";
import SectionTabs from "../../components/SectionTabs";

const PAGE = 100;

function show(v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string; q?: string; from?: string; to?: string; page?: string }>;
}) {
  await requirePermission("audit.view");
  const p = await searchParams;
  const page = Math.max(0, Number(p.page) || 0);
  const supabase = await createClient();
  const settings = await getSettings();

  const { data, error } = await auditQuery(supabase, p, settings.timezone).range(page * PAGE, page * PAGE + PAGE - 1);
  const rows = (data ?? []) as AuditEntry[];
  const qs = (n: number) => {
    const u = new URLSearchParams(Object.entries({ ...p, page: String(n) }).filter(([, v]) => v) as [string, string][]);
    return `/audit?${u}`;
  };
  const exportQs = new URLSearchParams(
    Object.entries({ module: p.module, q: p.q, from: p.from, to: p.to }).filter(([, v]) => v) as [string, string][],
  );

  return (
    <>
      <PageHeader title="Audit log" description="Every change and important action: who, what, when, and the values before and after. Entries cannot be edited or deleted." />
      <SectionTabs
        tabs={[
          { href: "/audit", label: "All changes" },
          { href: "/audit/security", label: "Security events" },
        ]}
        label="Audit sections"
      />
      <form className="flex flex-wrap gap-2 mb-5" action="/audit">
        <select name="module" defaultValue={p.module ?? ""} className={`${inputClass} max-w-[160px]`}>
          <option value="">All modules</option>
          {AUDIT_MODULES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input name="q" defaultValue={p.q} placeholder="Person, record id, action" className={`${inputClass} max-w-xs`} />
        <input type="date" name="from" defaultValue={p.from} className={`${inputClass} max-w-[160px]`} />
        <input type="date" name="to" defaultValue={p.to} className={`${inputClass} max-w-[160px]`} />
        <button className={buttonClass}>Filter</button>
        <a href={`/audit/export?${exportQs}`} className={secondaryButtonClass}>
          Download CSV
        </a>
      </form>

      <Card>
        {error ? (
          <EmptyState message={error.message} />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing matches" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold">Who</th>
                  <th className="px-4 py-3 font-semibold">What</th>
                  <th className="px-4 py-3 font-semibold">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-700">{fmtDateTime(e.occurred_at)}</td>
                    <td className="px-4 py-2">{e.actor_name}</td>
                    <td className="px-4 py-2">
                      <Tag tone="gold">{e.module}</Tag> {e.action} {e.table_name}
                      {e.table_name === "bookings" && e.record_id ? (
                        <Link href={`/bookings/${e.record_id}`} className="block text-brand-700">
                          open booking
                        </Link>
                      ) : (
                        e.record_id && <span className="block font-mono text-[10px] text-slate-500">{e.record_id}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-700">
                      {e.summary && <p>{e.summary}</p>}
                      {e.action === "update" &&
                        e.changed.map((k) => (
                          <p key={k}>
                            <span className="text-slate-500">{k}:</span> {show(e.before?.[k])} → <strong className="font-medium">{show(e.after?.[k])}</strong>
                          </p>
                        ))}
                      {e.action === "insert" && !e.summary && <p className="text-slate-500">created</p>}
                      {e.action === "delete" && <p className="text-rose-700">deleted</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="flex justify-between mt-4 text-sm">
        {page > 0 ? <Link href={qs(page - 1)} className="text-brand-700">← Newer</Link> : <span />}
        {rows.length === PAGE && <Link href={qs(page + 1)} className="text-brand-700">Older →</Link>}
      </div>
    </>
  );
}
