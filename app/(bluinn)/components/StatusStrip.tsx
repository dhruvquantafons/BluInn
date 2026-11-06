import Link from "next/link";
import { Building2, CalendarDays, MoonStar } from "lucide-react";
import { fmtDate } from "./ui";

/**
 * The slim bar under the top bar: which business date the hotel is trading
 * on, and which property the person is working in. It turns amber, with a way
 * into night audit, when the business date has fallen behind the calendar
 * (the hotel's own timezone) and the person can close it.
 */
export default function StatusStrip({
  businessDate,
  today,
  propertyName,
  canAudit,
}: {
  businessDate: string;
  today: string;
  propertyName: string | null;
  canAudit: boolean;
}) {
  const behind = businessDate < today && canAudit;
  return (
    <div
      role="status"
      className={`flex items-center gap-2.5 sm:gap-3 px-4 sm:px-6 lg:px-8 h-11 text-[13px] border-b backdrop-blur-sm print:hidden ${
        behind ? "bg-amber-50/90 border-amber-200 text-amber-900" : "bg-white/70 border-slate-200 text-slate-600"
      }`}
    >
      {behind ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] font-semibold bg-amber-100 text-amber-800 ring-1 ring-amber-200/80">
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-amber-500" />
          Day open
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80">
          <span aria-hidden="true" className="relative flex w-2 h-2">
            <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-60 animate-ping" />
            <span className="relative w-2 h-2 rounded-full bg-emerald-500" />
          </span>
          Open
        </span>
      )}
      <p className="min-w-0 flex items-center gap-3 truncate">
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <CalendarDays aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${behind ? "text-amber-500" : "text-slate-400"}`} />
          {behind ? (
            // On a phone the "Day open" pill and the Night audit button sit
            // beside this line, so it only needs the day that is still open.
            <span className="truncate">
              <span className="hidden sm:inline">Night audit has not closed </span>
              {fmtDate(businessDate)}
            </span>
          ) : (
            <>
              Business date <strong className="font-semibold text-slate-900">{fmtDate(businessDate)}</strong>
            </>
          )}
        </span>
        {propertyName && (
          <span className="hidden sm:inline-flex items-center gap-1.5 min-w-0 pl-3 border-l border-slate-200 text-slate-500 truncate">
            <Building2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-slate-400" />
            <span className="truncate">{propertyName}</span>
          </span>
        )}
      </p>
      {behind && (
        <Link
          href="/night-audit"
          className="ml-auto shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-white border border-amber-200 text-xs font-semibold text-amber-900 hover:bg-amber-100 transition-colors duration-150"
        >
          <MoonStar aria-hidden="true" className="w-3.5 h-3.5" />
          Night audit
        </Link>
      )}
    </div>
  );
}
