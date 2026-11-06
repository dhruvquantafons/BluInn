import Link from "next/link";
import { redirect } from "next/navigation";
import { Wallet } from "lucide-react";
import { createClient } from "../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../lib/auth";
import { can } from "../../../../lib/permissions";
import { varianceLabel } from "../../../../lib/cashier";
import type { CashierShift } from "../../../../lib/types";
import {
  PageHeader,
  Card,
  EmptyState,
  Tag,
  fmtDateTime,
  fmtMoney,
  tableHeadClass,
  tableRowClass,
  Pagination,
  pageParam,
  pageRange,
  pageHref,
  outOfRange,
} from "../../../components/ui";

const PAGE = 25;

type Row = CashierShift & {
  staff: { full_name: string; email: string } | null;
};

/**
 * Every cash shift at this property: a cashier sees their own; anyone who
 * audits shifts (folio.cashier_audit) or reads the financial reports sees all
 * of them, with the variances to follow up.
 */
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ page?: string; open?: string }> }) {
  const session = await requireAnyPermission(["folio.cashier", "folio.cashier_audit", "reports.financial"]);
  const sp = await searchParams;
  const page = pageParam(sp.page);
  const onlyOpen = sp.open === "1";
  const supabase = await createClient();
  const seesAll = can(session, "folio.cashier_audit") || can(session, "reports.financial");

  let query = supabase
    .from("cashier_shifts")
    .select("*, staff:staff_id(full_name, email)", { count: "exact" })
    .order("opened_at", { ascending: false })
    .range(...pageRange(page, PAGE));
  if (!seesAll) query = query.eq("staff_id", session.staff.id);
  if (onlyOpen) query = query.is("closed_at", null);
  const { data, error, count } = await query;
  if (outOfRange(error)) redirect(pageHref("/front-desk/shifts", onlyOpen ? { open: "1" } : {}, 1));
  const shifts = (data ?? []) as Row[];

  return (
    <>
      <PageHeader
        title="Cash shifts"
        description={
          seesAll
            ? "Every cashier's shift at this property, with the cash they counted against what the system expected."
            : "Your cash shifts, with the cash you counted against what the system expected."
        }
      />
      <div className="mb-4 flex gap-2 text-xs">
        <Link
          href="/front-desk/shifts"
          className={`px-2.5 py-1 rounded-md border ${!onlyOpen ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 text-slate-600"}`}
        >
          All
        </Link>
        <Link
          href="/front-desk/shifts?open=1"
          className={`px-2.5 py-1 rounded-md border ${onlyOpen ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 text-slate-600"}`}
        >
          Open now
        </Link>
      </div>
      <Card>
        {shifts.length === 0 ? (
          <EmptyState icon={<Wallet />} message={onlyOpen ? "No shift is open." : "No shifts yet."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="py-2.5 px-4 font-semibold">Cashier</th>
                  <th className="py-2.5 px-4 font-semibold">Opened</th>
                  <th className="py-2.5 px-4 font-semibold">Closed</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Float</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Expected</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Counted</th>
                  <th className="py-2.5 px-4 font-semibold">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shifts.map((s) => {
                  const v = varianceLabel(s.variance === null ? null : Number(s.variance));
                  return (
                    <tr key={s.id} className={tableRowClass}>
                      <td className="py-2.5 px-4">
                        <Link href={`/front-desk/shifts/${s.id}`} className="text-brand-700 hover:underline">
                          {s.staff?.full_name || s.staff?.email || "—"}
                        </Link>
                      </td>
                      <td className="py-2.5 px-4 text-slate-600">{fmtDateTime(s.opened_at)}</td>
                      <td className="py-2.5 px-4 text-slate-600">{s.closed_at ? fmtDateTime(s.closed_at) : "—"}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums">{fmtMoney(s.opening_float)}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums">{fmtMoney(s.expected_cash)}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums">{fmtMoney(s.counted_cash)}</td>
                      <td className="py-2.5 px-4">
                        <Tag tone={v.tone}>{v.text}</Tag>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={page}
          total={count ?? 0}
          pageSize={PAGE}
          path="/front-desk/shifts"
          params={onlyOpen ? { open: "1" } : {}}
          className="px-5 py-3 border-t border-slate-100"
        />
      </Card>
    </>
  );
}
