import { createClient } from "../../../../lib/supabase/server";
import { requirePermission } from "../../../../lib/auth";
import { getSettings } from "../../../../lib/settings";
import { addDays, isIsoDate } from "../../../../lib/dates";
import { REVENUE_DEPT_LABELS } from "../../../../lib/gst";
import { FLASH_DEPARTMENTS, flashKpis, variancePct, type FlashPeriod, type FlashReport } from "../../../../lib/reports";
import { Card, Notice, SectionTitle, StatCard, fmtDate, fmtMoney, inputClass, secondaryButtonClass, tableHeadClass } from "../../../components/ui";
import PrintButton from "../../../components/PrintButton";

type Col = "day" | "mtd" | "ytd";
const COLUMNS: { key: Col; ly: "ly_day" | "ly_mtd" | "ly_ytd"; label: string }[] = [
  { key: "day", ly: "ly_day", label: "Day" },
  { key: "mtd", ly: "ly_mtd", label: "Month to date" },
  { key: "ytd", ly: "ly_ytd", label: "Year to date" },
];

type Row = { label: string; value: (p: FlashPeriod) => number; format: (n: number) => string };

const pct = (n: number) => `${n}%`;
const count = (n: number) => n.toLocaleString("en-IN");

const KEY_FIGURES: Row[] = [
  { label: "Occupancy", value: (p) => flashKpis(p).occupancy, format: pct },
  { label: "Rooms sold", value: (p) => Number(p.rooms_sold), format: count },
  { label: "Rooms available", value: (p) => Number(p.rooms_available), format: count },
  { label: "ADR", value: (p) => flashKpis(p).adr, format: fmtMoney },
  { label: "RevPAR", value: (p) => flashKpis(p).revpar, format: fmtMoney },
  { label: "Complimentary rooms", value: (p) => Number(p.comp_rooms), format: count },
  { label: "House-use rooms", value: (p) => Number(p.house_rooms), format: count },
];

function Variance({ current, previous }: { current: number; previous: number }) {
  const v = variancePct(current, previous);
  if (v === null) return <span className="text-slate-400">—</span>;
  return <span className={v > 0 ? "text-emerald-700" : v < 0 ? "text-rose-700" : "text-slate-500"}>{v > 0 ? `+${v}` : v}%</span>;
}

function FigureTable({ rows, report }: { rows: Row[]; report: FlashReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className={tableHeadClass}>
            <th className="py-2 px-4 font-semibold" />
            {COLUMNS.map((c) => (
              <th key={c.key} colSpan={3} className="py-2 pr-3 font-semibold text-center border-l border-slate-100">
                {c.label}
              </th>
            ))}
          </tr>
          <tr className="text-[12px] text-slate-500">
            <th />
            {COLUMNS.map((c) => (
              <th key={c.key} colSpan={3} className="border-l border-slate-100">
                <span className="grid grid-cols-3 gap-2 pr-3 text-right font-medium">
                  <span>Actual</span>
                  <span>Last year</span>
                  <span>Change</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-slate-700">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-2 px-4 font-medium text-slate-900 whitespace-nowrap">{r.label}</td>
              {COLUMNS.map((c) => {
                const cur = r.value(report.periods[c.key]);
                const prev = r.value(report.periods[c.ly]);
                return (
                  <td key={c.key} colSpan={3} className="py-2 border-l border-slate-100">
                    <span className="grid grid-cols-3 gap-2 pr-3 text-right whitespace-nowrap">
                      <span className="text-slate-900">{r.format(cur)}</span>
                      <span className="text-slate-500">{r.format(prev)}</span>
                      <Variance current={cur} previous={prev} />
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The manager's flash report (0037): one business date against the same date
 * last year, with the month and financial year to date. Read it after night
 * audit has closed the day; until then the day's figures are still live.
 */
export default async function FlashReportPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await requirePermission("reports.financial");
  const settings = await getSettings();
  const supabase = await createClient();
  const { date: dateParam } = await searchParams;
  // The last day night audit closed.
  const lastClosed = addDays(settings.business_date, -1);
  const date = dateParam && isIsoDate(dateParam) ? dateParam : lastClosed;

  const { data, error } = await supabase.rpc("report_flash", { p_date: date });
  const report = data as FlashReport | null;

  const revenueRows: Row[] = [
    ...FLASH_DEPARTMENTS.map((d) => ({
      label: REVENUE_DEPT_LABELS[d],
      value: (p: FlashPeriod) => Number(p.revenue?.[d] ?? 0),
      format: fmtMoney,
    })),
    { label: "Total revenue", value: (p) => flashKpis(p).totalRevenue, format: fmtMoney },
    { label: `${settings.tax_label} charged`, value: (p) => Number(p.tax), format: fmtMoney },
    { label: "Credit notes issued", value: (p) => Number(p.credit_notes), format: fmtMoney },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <form className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-[13px] font-medium text-slate-700 mb-1.5">Business date</span>
            <input type="date" name="date" defaultValue={date} max={settings.business_date} className={inputClass} />
          </label>
          <button className={secondaryButtonClass}>Show</button>
        </form>
        <PrintButton />
      </div>

      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Flash report — {fmtDate(date)}
        </h2>
        <p className="text-xs text-slate-500">
          {settings.name} · compared with {fmtDate(addDays(date, -365))} last year · revenue before tax
        </p>
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {report && report.periods.day.audited_days === 0 && (
        <Notice tone="warn">
          Night audit has not closed {fmtDate(date)} yet, so these figures can still change.
        </Notice>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="In house" value={report.today.in_house_rooms} hint={`${report.today.in_house_guests} guests`} />
            <StatCard
              label="Arrivals · departures"
              value={`${report.today.arrivals} · ${report.today.departures}`}
              hint={`${report.today.walk_ins} walk-in${report.today.walk_ins === 1 ? "" : "s"}`}
            />
            <StatCard
              label="No-shows · cancellations"
              value={`${report.today.no_shows} · ${report.today.cancellations}`}
              hint={`${report.today.rooms_off_sale} room${report.today.rooms_off_sale === 1 ? "" : "s"} off sale`}
            />
            <StatCard label="Owed by in-house guests" value={fmtMoney(report.in_house_balance)} hint="Folio balances now" />
          </div>

          <Card>
            <div className="px-4 pt-4">
              <SectionTitle>Rooms</SectionTitle>
            </div>
            <FigureTable rows={KEY_FIGURES} report={report} />
          </Card>

          <Card>
            <div className="px-4 pt-4">
              <SectionTitle>Revenue by department</SectionTitle>
            </div>
            <FigureTable rows={revenueRows} report={report} />
            <p className="px-4 py-3 text-[11px] text-slate-500">
              Folio charges by the night they belong to, outlet bills paid at the outlet, and events billed on their own —
              less allowances and credit notes. ADR and RevPAR use room-night revenue only.
            </p>
          </Card>

          <Card className="p-5">
            <SectionTitle>The week ahead, on the books</SectionTitle>
            <div className="grid grid-cols-7 gap-2 text-center text-xs">
              {report.ahead.map((d) => {
                const occ = d.rooms_available > 0 ? Math.round((d.rooms_sold / d.rooms_available) * 100) : 0;
                return (
                  <div key={d.day} className="rounded-lg border border-slate-200 p-2">
                    <p className="text-[10px] text-slate-500">
                      {new Date(`${d.day}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric" })}
                    </p>
                    <p className="text-sm font-semibold text-slate-900">{occ}%</p>
                    <p className="text-[10px] text-slate-500">
                      {d.rooms_sold}/{d.rooms_available}
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
