import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { todayIn } from "../../../../lib/dates";
import { buildRegister, registerTotals, REGISTER_LABELS, REGISTER_SECTIONS } from "../../../../lib/gst-register";
import { loadRegister, registerMonth } from "../../../../lib/gst-register-data";
import { Card, Notice, SectionTitle, StatCard, fmtMoney, inputClass, secondaryButtonClass, tableHeadClass } from "../../../components/ui";

/**
 * The month's GST register (0036): what goes into GSTR-1, built from the
 * invoices and credit notes exactly as issued, plus outlet bills settled at
 * the outlet. Each section downloads as a CSV laid out like the GSTR-1 table
 * it feeds; the accountant files the return.
 */
export default async function GstRegisterPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requirePermission("reports.financial");
  const settings = await getSettings();
  const supabase = await createClient();
  const month = registerMonth((await searchParams).month, todayIn(settings.timezone));
  const { input, error } = await loadRegister(supabase, settings, month);
  const register = buildRegister(input);
  const totals = registerTotals(input);
  const monthValue = month.slice(0, 7);
  const label = new Date(`${month}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <form className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-[13px] font-medium text-slate-700 mb-1.5">Month</span>
          <input type="month" name="month" defaultValue={monthValue} className={inputClass} />
        </label>
        <button className={secondaryButtonClass}>Show</button>
      </form>

      {settings.tax_regime !== "gst" && (
        <Notice tone="warn">
          This property issues plain invoices (Settings → Tax). The register below lists them, but they carry no GST split.
        </Notice>
      )}
      {error && <Notice tone="warn">{error}</Notice>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="B2B invoices" value={totals.b2bCount} hint={fmtMoney(totals.b2bValue)} />
        <StatCard label="B2C invoices" value={fmtMoney(totals.b2cValue)} hint={`Outlet bills ${fmtMoney(totals.outletValue)}`} />
        <StatCard label="Credit notes" value={fmtMoney(totals.creditValue)} hint="Issued this month" />
        <StatCard label="Taxable value" value={fmtMoney(totals.taxableNet)} hint={`Tax ${fmtMoney(totals.taxNet)}, net of credit notes`} />
      </div>

      <Card className="p-5">
        <SectionTitle>Download for GSTR-1 — {label}</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {REGISTER_SECTIONS.map((s) => (
            <a
              key={s}
              href={`/billing/gst-register/export?month=${monthValue}&section=${s}`}
              className={secondaryButtonClass}
            >
              {REGISTER_LABELS[s]} ({register[s].body.length})
            </a>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 mt-3">
          Invoices count in the month they were issued; credit notes in the month they were raised. Check the figures with
          your accountant before filing.
        </p>
      </Card>

      {(["hsn", "docs"] as const).map((s) => (
        <Card key={s}>
          <div className="px-4 pt-4">
            <SectionTitle>{REGISTER_LABELS[s]}</SectionTitle>
          </div>
          {register[s].body.length === 0 ? (
            <p className="px-4 pb-4 text-xs text-slate-500">Nothing this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={tableHeadClass}>
                    {register[s].header.map((h, i) => (
                      <th key={h} className={`py-2 ${i === 0 ? "px-4" : "pr-3"} font-semibold ${i > 1 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {register[s].body.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, i) => (
                        <td
                          key={i}
                          className={`py-2 ${i === 0 ? "px-4 font-mono" : "pr-3"} ${i > 1 ? "text-right whitespace-nowrap" : ""}`}
                        >
                          {typeof cell === "number" && s === "hsn" && i > 2 ? fmtMoney(cell) : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
