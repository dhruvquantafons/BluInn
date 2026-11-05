import type { PropertySettings, TaxBand } from "../../lib/types";
import { stateLabel } from "../../lib/gst";
import { fmtDate, fmtDateTime, fmtMoney } from "./ui";

export interface GstRow {
  date: string | null;
  description: string;
  sac: string;
  rate: number;
  net: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/**
 * A GST tax invoice or credit note as CGST Rule 46 / 53 want it printed
 * (0036): the supplier's and buyer's GSTIN and state code, the place of
 * supply, the SAC code, taxable value, rate and CGST/SGST/IGST of every line,
 * a SAC-wise summary, whether reverse charge applies, and a signature line.
 *
 * Everything shown comes from the frozen document row, never from live data,
 * except the hotel's name and address, which do not change what was taxed.
 */
export default function GstDocument({
  title,
  number,
  issuedAt,
  settings,
  supplierGstin,
  supplierStateCode,
  billTo,
  placeOfSupply,
  interstate,
  rows,
  breakdown,
  totals,
  aside,
  banner,
  footer,
}: {
  title: string;
  number: string;
  issuedAt: string;
  settings: PropertySettings;
  supplierGstin: string;
  supplierStateCode: string;
  billTo: { name: string; address: string; gstin: string; stateCode: string };
  placeOfSupply: string;
  interstate: boolean;
  rows: GstRow[];
  breakdown: TaxBand[];
  totals: { net: number; cgst: number; sgst: number; igst: number; tax: number; grand: number };
  /** The right-hand block under the header: the stay, the event, or the invoice credited. */
  aside?: React.ReactNode;
  banner?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  // A discount or credit reads "−₹1,000", not "₹-1,000".
  const money = (n: number) => (n < 0 ? `−${fmtMoney(-n)}` : fmtMoney(n));
  return (
    <div className="text-sm text-slate-900">
      {banner}

      <div className="flex justify-between gap-6 border-b border-slate-200 pb-5 mb-5">
        <div>
          <p className="text-xl font-semibold tracking-tight">{settings.legal_name || settings.name}</p>
          {settings.legal_name && settings.legal_name !== settings.name && (
            <p className="text-xs text-slate-600">{settings.name}</p>
          )}
          <p className="text-xs text-slate-700 mt-1 whitespace-pre-line">
            {[settings.address, [settings.city, settings.state, settings.postcode].filter(Boolean).join(", ")]
              .filter(Boolean)
              .join("\n")}
          </p>
          <p className="text-xs text-slate-700">{[settings.phone, settings.email].filter(Boolean).join(" · ")}</p>
          <p className="text-xs font-medium mt-1">
            GSTIN {supplierGstin} · State {stateLabel(supplierStateCode)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{title}</p>
          <p className="font-mono text-base">{number}</p>
          <p className="text-xs text-slate-700 mt-1">Date {fmtDateTime(issuedAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6 text-xs">
        <div>
          <p className="text-slate-500 uppercase tracking-wider text-[10px]">
            {billTo.gstin ? "Billed to (registered)" : "Billed to"}
          </p>
          <p className="text-sm">{billTo.name}</p>
          {billTo.address && <p className="whitespace-pre-line">{billTo.address}</p>}
          {billTo.gstin && (
            <p>
              GSTIN {billTo.gstin}
              {billTo.stateCode && ` · State ${stateLabel(billTo.stateCode)}`}
            </p>
          )}
          <p className="mt-1">Place of supply: {placeOfSupply}</p>
          <p>Tax payable on reverse charge: No</p>
        </div>
        <div>{aside}</div>
      </div>

      <div className="overflow-x-auto mb-6">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-slate-900 text-left">
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2">SAC</th>
              <th className="py-2 pr-2 text-right">Taxable value</th>
              <th className="py-2 pr-2 text-right">Rate</th>
              {interstate ? (
                <th className="py-2 pr-2 text-right">IGST</th>
              ) : (
                <>
                  <th className="py-2 pr-2 text-right">CGST</th>
                  <th className="py-2 pr-2 text-right">SGST</th>
                </>
              )}
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                <td className="py-1.5 pr-2 whitespace-nowrap">{r.date ? fmtDate(r.date) : "—"}</td>
                <td className="py-1.5 pr-2">{r.description}</td>
                <td className="py-1.5 pr-2 font-mono">{r.sac || "—"}</td>
                <td className="py-1.5 pr-2 text-right">{money(r.net)}</td>
                <td className="py-1.5 pr-2 text-right">{r.rate}%</td>
                {interstate ? (
                  <td className="py-1.5 pr-2 text-right">{money(r.igst)}</td>
                ) : (
                  <>
                    <td className="py-1.5 pr-2 text-right">{money(r.cgst)}</td>
                    <td className="py-1.5 pr-2 text-right">{money(r.sgst)}</td>
                  </>
                )}
                <td className="py-1.5 text-right">{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap justify-between gap-8">
        {breakdown.length > 0 && (
          <div className="text-xs overflow-x-auto">
            <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Tax summary by SAC</p>
            <table>
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pr-4 font-medium">SAC</th>
                  <th className="pr-4 font-medium">Rate</th>
                  <th className="pr-4 font-medium">Taxable</th>
                  {interstate ? (
                    <th className="pr-4 font-medium">IGST</th>
                  ) : (
                    <>
                      <th className="pr-4 font-medium">CGST</th>
                      <th className="pr-4 font-medium">SGST</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b) => (
                  <tr key={`${b.sac}|${b.rate}`}>
                    <td className="pr-4 py-0.5 font-mono">{b.sac || "—"}</td>
                    <td className="pr-4 py-0.5">{b.rate}%</td>
                    <td className="pr-4 py-0.5">{money(b.net)}</td>
                    {interstate ? (
                      <td className="pr-4 py-0.5">{money(b.igst ?? 0)}</td>
                    ) : (
                      <>
                        <td className="pr-4 py-0.5">{money(b.cgst ?? 0)}</td>
                        <td className="pr-4 py-0.5">{money(b.sgst ?? 0)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="ml-auto min-w-[14rem] space-y-1 text-sm">
          <p className="flex justify-between">
            <span className="text-slate-700">Taxable value</span>
            <span>{money(totals.net)}</span>
          </p>
          {interstate ? (
            <p className="flex justify-between">
              <span className="text-slate-700">IGST</span>
              <span>{money(totals.igst)}</span>
            </p>
          ) : (
            <>
              <p className="flex justify-between">
                <span className="text-slate-700">CGST</span>
                <span>{money(totals.cgst)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-700">SGST</span>
                <span>{money(totals.sgst)}</span>
              </p>
            </>
          )}
          <p className="flex justify-between border-t border-slate-900 pt-2 font-semibold">
            <span>Total</span>
            <span>{money(totals.grand)}</span>
          </p>
        </div>
      </div>

      {footer}

      <div className="mt-10 flex justify-end text-xs">
        <div className="text-center">
          <p>For {settings.legal_name || settings.name}</p>
          <p className="mt-10 border-t border-slate-400 pt-1 text-slate-600">Authorised signatory</p>
        </div>
      </div>
    </div>
  );
}

/** Invoice lines in the shape GstDocument prints. */
export function gstRows(
  lines: {
    date: string | null;
    description: string;
    sac?: string;
    tax_rate?: number;
    rate?: number;
    net: number;
    cgst?: number;
    sgst?: number;
    igst?: number;
    total: number;
  }[],
): GstRow[] {
  return lines.map((l) => ({
    date: l.date,
    description: l.description,
    sac: l.sac ?? "",
    rate: Number(l.tax_rate ?? l.rate ?? 0),
    net: Number(l.net),
    cgst: Number(l.cgst ?? 0),
    sgst: Number(l.sgst ?? 0),
    igst: Number(l.igst ?? 0),
    total: Number(l.total),
  }));
}
