import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "../../../../../lib/supabase/server";
import { requireAnyPermission } from "../../../../../lib/auth";
import { getSettings } from "../../../../../lib/settings";
import { CREDIT_NOTE_REASONS } from "../../../../../lib/gst";
import { todayIn } from "../../../../../lib/dates";
import type { CreditNote } from "../../../../../lib/types";
import { fmtDate, fmtDateTime, fmtMoney } from "../../../../components/ui";
import GstDocument, { gstRows } from "../../../../components/GstDocument";
import PrintFooter from "../../../../components/PrintFooter";
import PrintButton from "../../../../components/PrintButton";

/**
 * A credit note as issued (CGST Rule 53): its own number, the invoice it
 * corrects, the reason, and the value and tax being credited line by line.
 * Read entirely from the frozen credit-note row.
 */
export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyPermission(["folio.view", "bookings.view", "reports.financial"]);
  const { id } = await params;
  const supabase = await createClient();
  const settings = await getSettings();

  const { data } = await supabase
    .from("credit_notes")
    .select("*, invoices(number, issued_at, supplier_gstin, supplier_state_code, booking_id, event_id)")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const note = data as CreditNote & {
    invoices: {
      number: string;
      issued_at: string;
      supplier_gstin: string;
      supplier_state_code: string;
      booking_id: string | null;
      event_id: string | null;
    } | null;
  };
  const inv = note.invoices;
  const reason = CREDIT_NOTE_REASONS.find((r) => r.value === note.reason_code)?.label ?? note.reason_code;
  const back = note.event_id ? `/events/${note.event_id}` : note.booking_id ? `/bookings/${note.booking_id}?tab=folio` : "/billing/credit-notes";
  const invoiceHref = inv
    ? inv.event_id
      ? `/events/${inv.event_id}/invoice/${note.invoice_id}`
      : `/bookings/${inv.booking_id}/invoice/${note.invoice_id}`
    : null;

  const aside = (
    <>
      <p className="text-slate-500 uppercase tracking-wider text-[10px]">Against invoice</p>
      {inv && invoiceHref ? (
        <p className="text-sm">
          <Link href={invoiceHref} className="font-mono text-brand-700 hover:underline print:no-underline">
            {inv.number}
          </Link>{" "}
          of {fmtDate(todayIn(settings.timezone, new Date(inv.issued_at)))}
        </p>
      ) : (
        <p className="text-sm">—</p>
      )}
      <p className="mt-1">Reason: {reason}</p>
      {note.note && <p className="whitespace-pre-line">{note.note}</p>}
    </>
  );

  return (
    <div className="max-w-3xl mx-auto bg-white print:shadow-none">
      <div className="flex justify-between items-center mb-6 print:hidden">
        <Link href={back} className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>
        <PrintButton />
      </div>

      <div className="border border-amber-300 rounded-xl p-8 print:border-0 print:p-0 text-sm text-slate-900">
        {note.tax_regime === "gst" ? (
          <GstDocument
            title="Credit note"
            number={note.number}
            issuedAt={note.issued_at}
            settings={settings}
            supplierGstin={inv?.supplier_gstin ?? settings.gstin}
            supplierStateCode={inv?.supplier_state_code ?? settings.gst_state_code}
            billTo={{
              name: note.bill_to_name,
              address: note.bill_to_address,
              gstin: note.bill_to_gstin,
              stateCode: note.bill_to_state_code,
            }}
            placeOfSupply={note.place_of_supply}
            interstate={note.is_interstate}
            rows={gstRows(note.lines)}
            breakdown={note.tax_breakdown}
            totals={{
              net: Number(note.net_total),
              cgst: Number(note.cgst_total),
              sgst: Number(note.sgst_total),
              igst: Number(note.igst_total),
              tax: Number(note.tax_total),
              grand: Number(note.grand_total),
            }}
            aside={aside}
          />
        ) : (
          <>
            <div className="flex justify-between gap-6 border-b border-slate-200 pb-5 mb-5">
              <div>
                <p className="text-xl font-semibold tracking-tight">{settings.name}</p>
                <p className="text-xs text-slate-700 mt-1">{[settings.address, settings.city].filter(Boolean).join(", ")}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Credit note</p>
                <p className="font-mono text-base">{note.number}</p>
                <p className="text-xs text-slate-700 mt-1">Issued {fmtDateTime(note.issued_at)}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-6 mb-6 text-xs">
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-[10px]">Credited to</p>
                <p className="text-sm">{note.bill_to_name}</p>
              </div>
              <div>{aside}</div>
            </div>
            <table className="w-full text-xs mb-6">
              <thead>
                <tr className="border-b border-slate-900 text-left">
                  <th className="py-2">Description</th>
                  <th className="py-2 text-right">Value</th>
                  <th className="py-2 text-right">{settings.tax_label}</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {note.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-1.5">{l.description}</td>
                    <td className="py-1.5 text-right">{fmtMoney(l.net)}</td>
                    <td className="py-1.5 text-right">{fmtMoney(l.tax)}</td>
                    <td className="py-1.5 text-right">{fmtMoney(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="flex justify-end gap-8 font-semibold">
              <span>Credited</span>
              <span>{fmtMoney(note.grand_total)}</span>
            </p>
          </>
        )}
        <p className="mt-6 text-[11px] text-slate-500">
          This credit note reduces the amount due under the invoice above. It is computer-generated.
        </p>
        <PrintFooter />
      </div>
    </div>
  );
}
