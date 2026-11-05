import Link from "next/link";
import type { CreditNote, Invoice, TaxRegime } from "../../lib/types";
import { CREDIT_NOTE_REASONS, cancelDeadline, creditNoteDeadline } from "../../lib/gst";
import { todayIn } from "../../lib/dates";
import { cancelInvoice, issueCreditNote } from "../billing-actions";
import { Field, Tag, fmtDate, fmtMoney, inputClass, secondaryButtonClass } from "./ui";
import ActionForm from "./ActionForm";

export interface BillToDefaults {
  name: string;
  gstin: string;
  address: string;
}

/**
 * Who an invoice is made out to. Under GST a business guest gives their
 * GSTIN, which makes it a B2B invoice they can claim credit on; the state is
 * read from the GSTIN.
 */
export function BillToFields({ defaults, taxRegime }: { defaults: BillToDefaults; taxRegime: TaxRegime }) {
  return (
    <>
      <Field label="Bill to">
        <input name="bill_to_name" required maxLength={200} defaultValue={defaults.name} className={inputClass} />
      </Field>
      {taxRegime === "gst" && (
        <Field label="Buyer's GSTIN" hint="Only for a business guest. Leave blank for a personal bill.">
          <input
            name="bill_to_gstin"
            maxLength={20}
            defaultValue={defaults.gstin}
            placeholder="27AAPFU0939F1ZV"
            className={`${inputClass} font-mono uppercase`}
          />
        </Field>
      )}
      <Field
        label="Address"
        hint={taxRegime === "gst" ? "Needed for a business bill, and for any bill of ₹50,000 or more." : undefined}
      >
        <textarea name="bill_to_address" rows={2} maxLength={500} defaultValue={defaults.address} className={inputClass} />
      </Field>
    </>
  );
}

/**
 * Under an issued invoice: the credit notes raised against it, and the two
 * ways to correct it. A GST invoice can be cancelled only until its month is
 * reported (the 11th of the next month) and only while no credit note stands
 * against it; after that a credit note is the correction (0036).
 */
export function InvoiceCorrections({
  invoice,
  creditNotes,
  canCancel,
  canCreditNote,
  timeZone,
}: {
  invoice: Invoice;
  creditNotes: CreditNote[];
  canCancel: boolean;
  canCreditNote: boolean;
  timeZone: string;
}) {
  if (invoice.status !== "issued") return null;

  const today = todayIn(timeZone);
  const issuedOn = todayIn(timeZone, new Date(invoice.issued_at));
  const cancelBy = cancelDeadline(issuedOn);
  const cancellable =
    canCancel && creditNotes.length === 0 && (invoice.tax_regime !== "gst" || today <= cancelBy);
  const creditBy = creditNoteDeadline(issuedOn);

  // What is still open on each line, after earlier credit notes.
  const open = invoice.lines
    .map((line, index) => {
      const done = creditNotes
        .flatMap((c) => c.lines)
        .filter((l) => l.line === index)
        .reduce((s, l) => s + Number(l.total), 0);
      return { index, line, left: Math.round((Number(line.total) - done) * 100) / 100 };
    })
    .filter((l) => l.left > 0);
  const creditable = canCreditNote && open.length > 0 && today <= creditBy;

  if (creditNotes.length === 0 && !cancellable && !creditable && !canCancel) return null;

  return (
    <div className="w-full space-y-2 pt-1">
      {creditNotes.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 pl-3 border-l-2 border-amber-300">
          <span>
            <Tag tone="amber">Credit note</Tag>{" "}
            <Link href={`/billing/credit-notes/${c.id}`} className="font-mono text-brand-700 hover:underline">
              {c.number}
            </Link>{" "}
            · {fmtDate(todayIn(timeZone, new Date(c.issued_at)))} · {c.note}
          </span>
          <span className="font-medium text-rose-700">−{fmtMoney(c.grand_total)}</span>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-4">
        {creditable && (
          <details className="relative inline-block text-left">
            <summary className="text-[11px] text-brand-700 hover:underline cursor-pointer list-none">Issue credit note</summary>
            <div className="absolute left-0 z-10 mt-1 w-96 max-w-[90vw] bg-white border border-slate-200 rounded-lg shadow-md p-3">
              <ActionForm action={issueCreditNote} submitLabel="Issue credit note" submitClassName={secondaryButtonClass} className="space-y-2">
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <Field label="Reason">
                  <select name="reason_code" required defaultValue="" className={inputClass}>
                    <option value="" disabled>
                      Choose…
                    </option>
                    {CREDIT_NOTE_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="What and why">
                  <input name="note" required maxLength={300} placeholder="AC not working on 12 Nov, 50% off that night" className={inputClass} />
                </Field>
                <label className="flex items-center gap-2 text-xs">
                  <input type="radio" name="scope" value="all" /> Credit everything still open (
                  {fmtMoney(open.reduce((s, l) => s + l.left, 0))})
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="radio" name="scope" value="lines" defaultChecked /> Credit these amounts, tax included:
                </label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {open.map(({ index, line, left }) => (
                    <div key={index} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate" title={line.description}>
                        {line.description} <span className="text-slate-500">· up to {fmtMoney(left)}</span>
                      </span>
                      <input
                        type="number"
                        name={`amount_${index}`}
                        min={0}
                        max={left}
                        step="0.01"
                        aria-label={`Credit against ${line.description}`}
                        className={`${inputClass} w-24 shrink-0`}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500">
                  The folio is credited at once; refund any overpayment with a refund request. Credit notes against this
                  invoice are allowed until {fmtDate(creditBy)}.
                </p>
              </ActionForm>
            </div>
          </details>
        )}

        {cancellable ? (
          <details className="relative inline-block text-left">
            <summary className="text-[11px] text-slate-500 hover:text-rose-700 cursor-pointer list-none">Cancel</summary>
            <div className="absolute left-0 z-10 mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-md p-3">
              <ActionForm action={cancelInvoice} submitLabel="Cancel invoice" submitClassName={secondaryButtonClass} className="space-y-2">
                <input type="hidden" name="id" value={invoice.id} />
                <input name="reason" required placeholder="Reason" className={inputClass} />
                <p className="text-[10px] text-slate-500">
                  The number stays used and is never given to another invoice.
                  {invoice.tax_regime === "gst" && ` Cancelling is possible until ${fmtDate(cancelBy)}.`}
                </p>
              </ActionForm>
            </div>
          </details>
        ) : (
          canCancel &&
          invoice.tax_regime === "gst" && (
            <span className="text-[10px] text-slate-500">
              {creditNotes.length > 0
                ? "Has a credit note, so it can no longer be cancelled."
                : `Reported for its month (cancel window closed ${fmtDate(cancelBy)}) — correct it with a credit note.`}
            </span>
          )
        )}
      </div>
    </div>
  );
}
