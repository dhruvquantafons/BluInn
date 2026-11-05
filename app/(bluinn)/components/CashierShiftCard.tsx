import Link from "next/link";
import { Wallet } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shiftBreakdown, type ShiftBreakdown } from "../../lib/cashier";
import type { CashierShift, CashMovement } from "../../lib/types";
import { openShift, recordCashMovement, closeShift } from "../cashier-actions";
import { Card, CardHeader, Field, fmtDateTime, fmtMoney, inputClass, secondaryButtonClass } from "./ui";
import ActionForm from "./ActionForm";

/** The caller's open shift at this property, with what the drawer should hold. */
export async function loadMyShift(
  supabase: SupabaseClient,
  staffId: string,
): Promise<{ shift: CashierShift; breakdown: ShiftBreakdown } | null> {
  const { data } = await supabase
    .from("cashier_shifts")
    .select("*")
    .eq("staff_id", staffId)
    .is("closed_at", null)
    .maybeSingle();
  if (!data) return null;
  const shift = data as CashierShift;
  return { shift, breakdown: await loadBreakdown(supabase, shift) };
}

export async function loadBreakdown(supabase: SupabaseClient, shift: CashierShift): Promise<ShiftBreakdown> {
  const [{ data: folio }, { data: pos }, { data: movements }] = await Promise.all([
    supabase.from("folio_entries").select("kind, method, amount, voided_at").eq("shift_id", shift.id),
    supabase.from("pos_payments").select("kind, amount, voided_at").eq("shift_id", shift.id),
    supabase.from("cash_movements").select("kind, amount").eq("shift_id", shift.id),
  ]);
  return shiftBreakdown({
    openingFloat: Number(shift.opening_float),
    folio: folio ?? [],
    pos: pos ?? [],
    movements: (movements ?? []) as Pick<CashMovement, "kind" | "amount">[],
  });
}

/**
 * The cashier's own shift, on the front desk and the outlet screens: open it
 * with a float, record cash in and out, close it by counting the drawer.
 */
export default function CashierShiftCard({
  mine,
  guests = [],
  required,
}: {
  mine: { shift: CashierShift; breakdown: ShiftBreakdown } | null;
  /** In-house guests a paid-out can be charged to. Empty hides the option. */
  guests?: { id: string; label: string }[];
  /** The property requires a shift for cash. */
  required: boolean;
}) {
  if (!mine) {
    return (
      <Card>
        <CardHeader
          icon={<Wallet />}
          title="Cash shift"
          description={required ? "Open a shift before you take or refund cash." : "No shift open."}
          action={
            <Link href="/front-desk/shifts" className="text-xs text-brand-700 hover:underline">
              Shifts
            </Link>
          }
        />
        <ActionForm
          action={openShift}
          submitLabel="Open shift"
          submitClassName={secondaryButtonClass}
          className="p-5 flex flex-wrap items-end gap-3"
        >
          <Field label="Opening float (₹)">
            <input type="number" name="opening_float" min={0} step="0.01" defaultValue={0} className={`${inputClass} w-40`} />
          </Field>
        </ActionForm>
      </Card>
    );
  }

  const { shift, breakdown } = mine;
  return (
    <Card>
      <CardHeader
        icon={<Wallet />}
        title="Cash shift"
        description={`Open since ${fmtDateTime(shift.opened_at)} · float ${fmtMoney(shift.opening_float)}`}
        action={
          <span className="text-sm font-semibold text-slate-900 tabular-nums">
            Drawer {fmtMoney(breakdown.expected)}
          </span>
        }
      />
      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-slate-600 content-start">
          <dt>Cash taken</dt>
          <dd className="text-right tabular-nums">{fmtMoney(breakdown.folioCash + breakdown.outletCash)}</dd>
          <dt>Cash refunded</dt>
          <dd className="text-right tabular-nums">−{fmtMoney(breakdown.folioCashRefunds)}</dd>
          <dt>Pay-ins</dt>
          <dd className="text-right tabular-nums">{fmtMoney(breakdown.payIns)}</dd>
          <dt>Paid-outs</dt>
          <dd className="text-right tabular-nums">−{fmtMoney(breakdown.paidOuts)}</dd>
          <dt>Safe drops</dt>
          <dd className="text-right tabular-nums">−{fmtMoney(breakdown.safeDrops)}</dd>
          <dt className="pt-1 border-t border-slate-100 font-medium text-slate-900">Should be in the drawer</dt>
          <dd className="pt-1 border-t border-slate-100 text-right tabular-nums font-medium text-slate-900">
            {fmtMoney(breakdown.expected)}
          </dd>
          <dd className="col-span-2 pt-2">
            <Link href={`/front-desk/shifts/${shift.id}`} className="text-brand-700 hover:underline">
              Shift report
            </Link>
          </dd>
        </dl>

        <ActionForm action={recordCashMovement} submitLabel="Record" submitClassName={secondaryButtonClass} className="space-y-3">
          <p className="text-xs font-medium text-brand-700">Cash in or out</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select name="kind" defaultValue="paid_out" className={inputClass}>
                <option value="paid_out">Paid-out</option>
                <option value="pay_in">Pay-in</option>
                <option value="safe_drop">Safe drop</option>
              </select>
            </Field>
            <Field label="Amount (₹)">
              <input type="number" name="amount" min={0.01} step="0.01" required className={inputClass} />
            </Field>
          </div>
          <Field label="Reason">
            <input name="reason" required placeholder="Taxi for 204, change from the bank…" className={inputClass} />
          </Field>
          {guests.length > 0 && (
            <Field label="Charge a paid-out to" hint="Optional. Posts the amount to the guest's folio, untaxed.">
              <select name="booking_id" defaultValue="" className={inputClass}>
                <option value="">Not charged to a guest</option>
                {guests.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </ActionForm>

        <ActionForm action={closeShift} submitLabel="Close shift" submitClassName={secondaryButtonClass} className="space-y-3">
          <p className="text-xs font-medium text-brand-700">Close and count</p>
          <input type="hidden" name="shift_id" value={shift.id} />
          <Field label="Cash counted (₹)" hint="Count the drawer without looking at the figure on the left.">
            <input type="number" name="counted_cash" min={0} step="0.01" required className={inputClass} />
          </Field>
          <Field label="Notes">
            <input name="notes" placeholder="Anything the manager should know" className={inputClass} />
          </Field>
        </ActionForm>
      </div>
    </Card>
  );
}
