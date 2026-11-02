import Link from "next/link";
import { fmtDate } from "./ui";

/**
 * The slim bar under the top bar: which business date the hotel is trading
 * on, and at which property. It turns amber, with a way into night audit,
 * when the business date has fallen behind the calendar and the person can
 * close it.
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
      className={`flex items-center gap-3 px-4 sm:px-6 lg:px-8 py-2 text-[13px] border-b print:hidden ${
        behind ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-emerald-50 border-emerald-200 text-slate-700"
      }`}
    >
      <span
        aria-hidden="true"
        className={`w-2.5 h-2.5 shrink-0 rounded-full ring-3 ${behind ? "bg-amber-500 ring-amber-100" : "bg-emerald-500 ring-emerald-100"}`}
      />
      <p className="min-w-0 truncate">
        {behind ? (
          <>Night audit has not closed {fmtDate(businessDate)}.</>
        ) : (
          <>
            Business date <strong className="font-semibold text-slate-900">{fmtDate(businessDate)}</strong>
          </>
        )}
        {propertyName && <span className="text-slate-500"> · {propertyName}</span>}
      </p>
      {behind && (
        <Link
          href="/night-audit"
          className="ml-auto shrink-0 inline-flex items-center h-7 px-3 rounded-md bg-white border border-amber-200 text-xs font-semibold text-amber-900 hover:bg-amber-100 transition-colors duration-150"
        >
          Night audit
        </Link>
      )}
    </div>
  );
}
