import { Building2, CalendarDays } from "lucide-react";
import { fmtDate } from "./ui";

/**
 * The slim bar under the top bar: today's date at the hotel (in the
 * property's own timezone) and which property the person is working in.
 */
export default function StatusStrip({ today, propertyName }: { today: string; propertyName: string | null }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 sm:gap-3 px-4 sm:px-6 lg:px-8 h-11 text-[13px] border-b backdrop-blur-sm print:hidden bg-white/70 border-slate-200 text-slate-600"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80">
        <span aria-hidden="true" className="relative flex w-2 h-2">
          <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-60 animate-ping" />
          <span className="relative w-2 h-2 rounded-full bg-emerald-500" />
        </span>
        Open
      </span>
      <p className="min-w-0 flex items-center gap-3 truncate">
        <span className="inline-flex items-center gap-1.5 truncate">
          <CalendarDays aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          Today <strong className="font-semibold text-slate-900">{fmtDate(today)}</strong>
        </span>
        {propertyName && (
          <span className="hidden sm:inline-flex items-center gap-1.5 min-w-0 pl-3 border-l border-slate-200 text-slate-500 truncate">
            <Building2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-slate-400" />
            <span className="truncate">{propertyName}</span>
          </span>
        )}
      </p>
    </div>
  );
}
