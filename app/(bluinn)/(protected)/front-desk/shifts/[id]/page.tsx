import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "../../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../../lib/auth";
import { can } from "../../../../../lib/permissions";
import { getSettings } from "../../../../../lib/settings";
import { varianceLabel } from "../../../../../lib/cashier";
import {
  CASH_MOVEMENT_LABELS,
  PAYMENT_METHOD_LABELS,
  type CashMovement,
  type CashierShift,
  type PaymentMethod,
} from "../../../../../lib/types";
import { closeShift } from "../../../../cashier-actions";
import { loadBreakdown } from "../../../../components/CashierShiftCard";
import {
  Card,
  Field,
  SectionTitle,
  StatCard,
  Tag,
  fmtDateTime,
  fmtMoney,
  inputClass,
  secondaryButtonClass,
  tableHeadClass,
} from "../../../../components/ui";
import ActionForm from "../../../../components/ActionForm";
import PrintButton from "../../../../components/PrintButton";
import PrintFooter from "../../../../components/PrintFooter";

type Person = { full_name: string; email: string } | null;

/** The shift report a cashier hands in with the drawer: printable. */
export default async function ShiftReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAnyPermission(["folio.cashier", "folio.cashier_audit", "reports.financial"]);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const settings = await getSettings();

  // RLS shows a cashier only their own shifts, so an id from someone else's
  // simply is not found.
  const { data } = await supabase
    .from("cashier_shifts")
    .select("*, staff:staff_id(full_name, email), closer:closed_by(full_name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const shift = data as CashierShift & { staff: Person; closer: Person };

  const [breakdown, { data: payments }, { data: outlet }, { data: movements }] = await Promise.all([
    loadBreakdown(supabase, shift),
    supabase
      .from("folio_entries")
      .select("id, kind, method, amount, reference, voided_at, created_at, bookings(reference, contact_name)")
      .eq("shift_id", id)
      .order("created_at"),
    supabase
      .from("pos_payments")
      .select("id, kind, amount, voided_at, created_at, pos_orders(number, pos_outlets(name))")
      .eq("shift_id", id)
      .order("created_at"),
    supabase
      .from("cash_movements")
      .select("*, bookings(reference, contact_name)")
      .eq("shift_id", id)
      .order("created_at"),
  ]);

  const v = varianceLabel(shift.variance === null ? null : Number(shift.variance));
  const name = (p: Person) => p?.full_name || p?.email || "—";
  const canClose =
    !shift.closed_at &&
    ((shift.staff_id === session.staff.id && can(session, "folio.cashier")) || can(session, "folio.cashier_audit"));

  return (
    <>
      <div className="flex justify-between items-center mb-4 print:hidden">
        <Link href="/front-desk/shifts" className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700">
          <ArrowLeft className="w-3.5 h-3.5" /> Cash shifts
        </Link>
        <PrintButton />
      </div>

      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Cash shift · {name(shift.staff)}</h1>
      <p className="text-xs text-slate-500 mt-1 mb-6">
        {settings.name} · opened {fmtDateTime(shift.opened_at)}
        {shift.closed_at ? ` · closed ${fmtDateTime(shift.closed_at)} by ${name(shift.closer)}` : ""} ·{" "}
        <Tag tone={v.tone}>{v.text}</Tag>
      </p>

      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Float" value={fmtMoney(shift.opening_float)} />
          <StatCard
            label="Expected in drawer"
            value={fmtMoney(shift.closed_at ? shift.expected_cash : breakdown.expected)}
            hint={shift.closed_at ? "At close" : "So far"}
          />
          <StatCard label="Counted" value={fmtMoney(shift.counted_cash)} />
          <StatCard label="Variance" value={shift.variance === null ? "—" : fmtMoney(shift.variance)} hint={shift.notes || undefined} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-5">
            <SectionTitle>Cash</SectionTitle>
            <dl className="text-sm space-y-1.5">
              {(
                [
                  ["Opening float", breakdown.openingFloat],
                  ["Cash taken at the desk", breakdown.folioCash],
                  ["Cash refunded at the desk", -breakdown.folioCashRefunds],
                  ["Cash taken at outlets", breakdown.outletCash],
                  ["Pay-ins", breakdown.payIns],
                  ["Paid-outs", -breakdown.paidOuts],
                  ["Safe drops", -breakdown.safeDrops],
                ] as [string, number][]
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="tabular-nums">{fmtMoney(value)}</dd>
                </div>
              ))}
              <div className="flex justify-between pt-2 border-t border-slate-100 font-medium">
                <dt>Should be in the drawer</dt>
                <dd className="tabular-nums">{fmtMoney(breakdown.expected)}</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <SectionTitle>Other takings on this shift</SectionTitle>
            {Object.keys(breakdown.otherByMethod).length === 0 ? (
              <p className="text-sm text-slate-500">None.</p>
            ) : (
              <dl className="text-sm space-y-1.5">
                {Object.entries(breakdown.otherByMethod).map(([method, amount]) => (
                  <div key={method} className="flex justify-between">
                    <dt className="text-slate-600">
                      {method.startsWith("outlet_")
                        ? `Outlet · ${method.slice(7)}`
                        : (PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method)}
                    </dt>
                    <dd className="tabular-nums">{fmtMoney(amount)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-3 text-[11px] text-slate-500">Card, UPI and other takings are settled by the bank, not counted in the drawer.</p>
          </Card>
        </div>

        <Card className="p-5">
          <SectionTitle>Transactions</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={tableHeadClass}>
                  <th className="py-2 pr-3 font-semibold">Time</th>
                  <th className="py-2 pr-3 font-semibold">What</th>
                  <th className="py-2 pr-3 font-semibold">Method</th>
                  <th className="py-2 font-semibold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(payments ?? []).map((p) => {
                  const b = p.bookings as unknown as { reference: string; contact_name: string } | null;
                  return (
                    <tr key={p.id} className={p.voided_at ? "text-slate-400 line-through" : "text-slate-700"}>
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(p.created_at)}</td>
                      <td className="py-2 pr-3">
                        {p.kind === "refund" ? "Refund" : "Payment"} · {b ? `${b.reference} ${b.contact_name}` : ""}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </td>
                      <td className="py-2 pr-3">{p.method ? PAYMENT_METHOD_LABELS[p.method as PaymentMethod] : "—"}</td>
                      <td className="py-2 text-right tabular-nums">
                        {p.kind === "refund" ? "−" : ""}
                        {fmtMoney(p.amount)}
                      </td>
                    </tr>
                  );
                })}
                {(outlet ?? []).map((p) => {
                  const o = p.pos_orders as unknown as { number: string; pos_outlets: { name: string } | null } | null;
                  return (
                    <tr key={p.id} className={p.voided_at ? "text-slate-400 line-through" : "text-slate-700"}>
                      <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(p.created_at)}</td>
                      <td className="py-2 pr-3">
                        {o?.pos_outlets?.name ?? "Outlet"} · {o?.number}
                      </td>
                      <td className="py-2 pr-3 capitalize">{String(p.kind).replace("_", " ")}</td>
                      <td className="py-2 text-right tabular-nums">{fmtMoney(p.amount)}</td>
                    </tr>
                  );
                })}
                {((movements ?? []) as (CashMovement & { bookings: { reference: string; contact_name: string } | null })[]).map((m) => (
                  <tr key={m.id} className="text-slate-700">
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(m.created_at)}</td>
                    <td className="py-2 pr-3">
                      {CASH_MOVEMENT_LABELS[m.kind]} · {m.reason}
                      {m.bookings ? ` · charged to ${m.bookings.reference} ${m.bookings.contact_name}` : ""}
                    </td>
                    <td className="py-2 pr-3">Cash</td>
                    <td className="py-2 text-right tabular-nums">
                      {m.kind === "pay_in" ? "" : "−"}
                      {fmtMoney(m.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(payments ?? []).length + (outlet ?? []).length + (movements ?? []).length === 0 && (
              <p className="text-sm text-slate-500 pt-2">Nothing on this shift yet.</p>
            )}
          </div>
        </Card>

        {canClose && (
          <Card className="p-5 print:hidden">
            <SectionTitle>Close this shift</SectionTitle>
            <ActionForm action={closeShift} submitLabel="Close shift" submitClassName={secondaryButtonClass} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <input type="hidden" name="shift_id" value={shift.id} />
              <Field label="Cash counted (₹)">
                <input type="number" name="counted_cash" min={0} step="0.01" required className={inputClass} />
              </Field>
              <Field label="Notes">
                <input name="notes" className={inputClass} />
              </Field>
            </ActionForm>
          </Card>
        )}

        <div className="hidden print:grid grid-cols-2 gap-12 pt-12 text-xs text-slate-600">
          <p className="border-t border-slate-400 pt-1">Cashier</p>
          <p className="border-t border-slate-400 pt-1">Received by</p>
        </div>
        <PrintFooter />
      </div>
    </>
  );
}
