import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { CREDIT_NOTE_REASONS } from "../../../../lib/gst";
import { todayIn } from "../../../../lib/dates";
import type { CreditNote } from "../../../../lib/types";
import {
  Card,
  EmptyState,
  fmtDate,
  fmtMoney,
  tableHeadClass,
  Pagination,
  pageParam,
  pageRange,
  pageHref,
  outOfRange,
} from "../../../components/ui";

const REASON = Object.fromEntries(CREDIT_NOTE_REASONS.map((r) => [r.value, r.label]));

/**
 * Every credit note issued, newest first (0036). Like invoices they are never
 * removed or renumbered; each one names the invoice it corrects. They are
 * raised from the invoice on a booking's Folio tab, or on an event.
 */
export default async function CreditNotesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireAnyPermission(["folio.view", "folio.invoice", "folio.credit_note", "reports.financial"]);
  const page = pageParam((await searchParams).page);
  const supabase = await createClient();
  const settings = await getSettings();

  const { data, error, count } = await supabase
    .from("credit_notes")
    .select("*, invoices(number, booking_id, event_id)", { count: "exact" })
    .order("issued_at", { ascending: false })
    .range(...pageRange(page));
  if (outOfRange(error)) redirect(pageHref("/billing/credit-notes", {}, 1));
  const notes = (data ?? []) as (CreditNote & {
    invoices: { number: string; booking_id: string | null; event_id: string | null } | null;
  })[];

  return (
    <Card>
      {notes.length === 0 ? (
        <EmptyState message="No credit notes yet. Issue one against an invoice from a booking's Folio tab, or from an event." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={tableHeadClass}>
                <th className="py-2 px-4 font-semibold">Number</th>
                <th className="py-2 pr-3 font-semibold">Date</th>
                <th className="py-2 pr-3 font-semibold">Against invoice</th>
                <th className="py-2 pr-3 font-semibold">Billed to</th>
                <th className="py-2 pr-3 font-semibold">Reason</th>
                <th className="py-2 pr-3 font-semibold text-right">Taxable</th>
                <th className="py-2 pr-3 font-semibold text-right">{settings.tax_label}</th>
                <th className="py-2 pr-4 font-semibold text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {notes.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 px-4 whitespace-nowrap">
                    <Link href={`/billing/credit-notes/${c.id}`} className="font-mono text-brand-700 hover:underline">
                      {c.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(todayIn(settings.timezone, new Date(c.issued_at)))}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {c.invoices ? (
                      <Link
                        href={
                          c.invoices.event_id
                            ? `/events/${c.invoices.event_id}/invoice/${c.invoice_id}`
                            : `/bookings/${c.invoices.booking_id}/invoice/${c.invoice_id}`
                        }
                        className="font-mono text-brand-700 hover:underline"
                      >
                        {c.invoices.number}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {c.bill_to_name}
                    {c.bill_to_gstin && <span className="block text-[11px] text-slate-500">GSTIN {c.bill_to_gstin}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {REASON[c.reason_code] ?? c.reason_code}
                    {c.note && <span className="block text-[11px] text-slate-500">{c.note}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">{fmtMoney(c.net_total)}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">{fmtMoney(c.tax_total)}</td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap font-medium">{fmtMoney(c.grand_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} total={count ?? 0} path="/billing/credit-notes" />
    </Card>
  );
}
