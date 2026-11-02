/**
 * Shared admin component kit.
 *
 * Visual language (full notes in app/(bluinn)/DESIGN.md): a pale grey canvas
 * under a royal-blue top bar; every page opens on a gradient hero banner in
 * its nav section's tint (`--hero-*`, set by GroupScope), with glass chips,
 * stat tiles and buttons on it; below that, white rounded-xl cards with a
 * hairline and a soft lift, KPI cards with a coloured accent bar, and status
 * as borderless tinted pills (`admin-pill`). Everything is Inter, semibold
 * and tightly tracked for headings and figures. Motion is limited to short
 * colour/shadow transitions on hover and the route fade in template.tsx.
 *
 * Pages should build from these primitives rather than restating classes,
 * so a later restyle only has to touch this file.
 */
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { PAGE_SIZE, pageHref, pageList, type PageParams } from "./paging";
import type { BookingStatus } from "../../lib/types";
import { BOOKING_STATUS_LABELS } from "../../lib/types";
import BrandMark from "./BrandMark";

export type HeroChip = {
  label: React.ReactNode;
  href?: string;
  icon?: React.ReactNode;
  /** `warn` tints the chip amber, for something that needs attention. */
  tone?: "default" | "warn";
};

export type HeroStat = {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  href?: string;
};

const HERO_STAT_COLS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * The page's hero banner: a gradient card in the current section's tint.
 *
 * Every page and section layout opens with one. Beyond the title and
 * description it can carry an eyebrow line, a row of glass `chips` (alerts,
 * quick facts), the page's `action` (buttons written for a white page are
 * restyled for the banner by globals.css), up to four glass `stats` tiles
 * and a `progress` bar along the foot. On the right sits a decorative mark:
 * the BluInn mark unless the page passes its own `icon`.
 *
 * It prints as a plain title and description.
 */
export function PageHeader({
  title,
  description,
  action,
  eyebrow,
  chips,
  stats,
  progress,
  icon,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  eyebrow?: string;
  chips?: HeroChip[];
  stats?: HeroStat[];
  progress?: { value: number; label: React.ReactNode };
  icon?: React.ReactNode;
}) {
  return (
    <header className="admin-hero mb-6 px-6 sm:px-7 pt-6 pb-6">
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-white/75 mb-1.5">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="text-[15px] text-white/85 mt-1.5 max-w-3xl leading-relaxed">{description}</p>}
          {chips && chips.length > 0 && (
            <ul className="flex flex-wrap gap-2 mt-4 print:hidden">
              {chips.map((c, i) => {
                const cls = `inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12.5px] text-white transition-colors duration-150 [&_svg]:w-3.5 [&_svg]:h-3.5 [&_svg]:shrink-0 ${
                  c.tone === "warn"
                    ? "bg-amber-300/25 border border-amber-200/45 hover:bg-amber-300/35"
                    : "admin-glass"
                }`;
                return (
                  <li key={i}>
                    {c.href ? (
                      <Link href={c.href} className={cls}>
                        {c.icon}
                        {c.label}
                      </Link>
                    ) : (
                      <span className={cls}>
                        {c.icon}
                        {c.label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {action && <div className="admin-hero-actions flex flex-wrap items-center gap-2 mt-5 print:hidden">{action}</div>}
        </div>
        <span
          aria-hidden="true"
          className="hidden md:flex shrink-0 w-20 h-20 rounded-full admin-glass items-center justify-center text-white shadow-[0_0_0_10px_rgb(255_255_255/0.06)] [&_svg]:w-9 [&_svg]:h-9 print:hidden"
        >
          {icon ?? <BrandMark className="w-12 h-12" />}
        </span>
      </div>

      {stats && stats.length > 0 && (
        <div className={`grid grid-cols-2 gap-3 mt-6 print:hidden ${HERO_STAT_COLS[Math.min(stats.length, 4)]}`}>
          {stats.map((s) => {
            const body = (
              <>
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-white/85 [&_svg]:w-3.5 [&_svg]:h-3.5">
                  {s.icon}
                  {s.label}
                </p>
                <p className="admin-display text-[1.75rem] leading-none text-white mt-2.5">{s.value}</p>
                {s.hint && <p className="text-[12px] text-white/70 mt-2">{s.hint}</p>}
              </>
            );
            const cls = "admin-glass block rounded-xl px-4 py-3.5 transition-colors duration-150";
            return s.href ? (
              <Link key={s.label} href={s.href} className={cls}>
                {body}
              </Link>
            ) : (
              <div key={s.label} className={cls}>
                {body}
              </div>
            );
          })}
        </div>
      )}

      {progress && (
        <div className="mt-5 print:hidden">
          <p className="text-right text-[12.5px] text-white/80 mb-1.5">{progress.label}</p>
          <div className="h-1.5 rounded-full bg-white/20 overflow-hidden">
            <div
              className="h-full rounded-full bg-white/90"
              style={{ width: `${Math.max(0, Math.min(100, progress.value))}%` }}
            />
          </div>
        </div>
      )}
    </header>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white border border-slate-200 rounded-xl shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/**
 * The header row of a list card: an icon tile in the section's tint, the
 * title, an optional count badge and an "All ›" style link to the full list.
 */
export function CardHeader({
  title,
  icon,
  count,
  href,
  linkLabel = "All",
  description,
  action,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  count?: number;
  href?: string;
  linkLabel?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100">
      {icon && (
        <span className="w-8 h-8 shrink-0 rounded-lg bg-(--g-50) text-(--g-600) flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-slate-900">{title}</h2>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      {count !== undefined && (
        <span className="min-w-6 px-2 py-0.5 rounded-full bg-(--g-50) text-[11px] font-semibold text-(--g-700) text-center tabular-nums">
          {count}
        </span>
      )}
      {action}
      {href && (
        <Link
          href={href}
          className="shrink-0 inline-flex items-center gap-0.5 text-[13px] font-medium text-slate-500 hover:text-(--g-700) transition-colors duration-150"
        >
          {linkLabel}
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}

/**
 * Pill tints for booking status, after the reference's booking list:
 * pending is amber, an expected arrival is lime, an in-house guest is green.
 * The shared BOOKING_STATUS_STYLES in lib/types stays as it is for its other
 * consumers.
 */
const STATUS_PILL: Record<BookingStatus, string> = {
  tentative: "bg-amber-100 text-amber-800",
  confirmed: "bg-lime-100 text-lime-900",
  checked_in: "bg-emerald-100 text-emerald-800",
  checked_out: "bg-slate-100 text-slate-600",
  cancelled: "bg-rose-100 text-rose-800",
  no_show: "bg-orange-100 text-orange-800",
  waitlisted: "bg-violet-100 text-violet-800",
};

const pillClass =
  "admin-pill inline-flex items-center self-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap";

export function StatusPill({ status }: { status: BookingStatus }) {
  return <span className={`${pillClass} ${STATUS_PILL[status]}`}>{BOOKING_STATUS_LABELS[status]}</span>;
}

export function StatCard({
  label,
  value,
  href,
  hint,
  icon,
  highlight = false,
}: {
  label: string;
  value: number | string;
  href?: string;
  hint?: string;
  /** Optional lucide icon, shown in a tinted tile beside the label. */
  icon?: React.ReactNode;
  /** A tinted card with a stronger accent. Use it for the one figure a row leads with. */
  highlight?: boolean;
}) {
  const body = (
    <div
      className={`group relative h-full flex flex-col overflow-hidden rounded-xl border pl-5 pr-4 py-4 shadow-sm transition duration-200 ease-out ${
        highlight ? "bg-linear-to-br from-(--g-50) to-white border-(--g-200)" : "bg-white border-slate-200"
      } ${href ? "hover:border-slate-300 hover:shadow-[0_10px_24px_-14px_rgb(18_23_34/0.28)]" : ""}`}
    >
      <span aria-hidden="true" className={`absolute left-0 inset-y-0 ${highlight ? "w-1 bg-(--g-600)" : "w-[3px] bg-(--g-500)"}`} />
      <div className="flex items-center gap-2.5">
        {icon && (
          <span
            aria-hidden="true"
            className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4 ${
              highlight ? "bg-(--g-600) text-white" : "bg-(--g-50) text-(--g-600)"
            }`}
          >
            {icon}
          </span>
        )}
        <p className="flex-1 min-w-0 text-[13px] font-medium text-slate-600">{label}</p>
        {href && (
          <ChevronRight
            aria-hidden="true"
            className="w-4 h-4 shrink-0 text-slate-300 transition duration-200 group-hover:text-slate-500 group-hover:translate-x-0.5"
          />
        )}
      </div>
      <p className="admin-display text-[1.75rem] leading-none text-slate-900 mt-3.5">{value}</p>
      {hint && <p className="text-[12px] text-slate-500 mt-auto pt-3">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-slate-700 mb-1.5">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500 mt-1">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:outline-none focus:border-brand-500 focus:ring-3 focus:ring-brand-100 transition-colors duration-150";

/**
 * Primary action: royal blue with white text. The `admin-btn` marker lets the
 * hero banner turn it white when it is handed to PageHeader as the action.
 */
export const buttonClass =
  "admin-btn inline-flex items-center justify-center px-4 py-2 text-sm font-semibold rounded-lg bg-brand-600 text-white border border-transparent shadow-sm hover:bg-brand-700 transition-colors duration-150 ease-out cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

/** White with a hairline; `admin-btn-secondary` turns it to glass on the hero. */
export const secondaryButtonClass =
  "admin-btn-secondary inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg bg-white text-slate-700 border border-slate-200 shadow-sm hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900 transition-colors duration-150 ease-out cursor-pointer disabled:opacity-50";

export function Banner({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p
      role="status"
      className={`text-sm px-4 py-2.5 rounded-xl border ${
        error
          ? "bg-rose-50 text-rose-800 border-rose-200"
          : "bg-emerald-50 text-emerald-800 border-emerald-200"
      }`}
    >
      {error ?? success}
    </p>
  );
}

/** Centred muted line inside a card, with an optional icon in a tinted ring. */
export function EmptyState({ message, icon }: { message: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center py-12 px-4 text-sm text-slate-500">
      {icon && (
        <span
          aria-hidden="true"
          className="w-11 h-11 rounded-full bg-(--g-50) text-(--g-600) flex items-center justify-center [&_svg]:w-5 [&_svg]:h-5"
        >
          {icon}
        </span>
      )}
      {message}
    </div>
  );
}

/** Formats a yyyy-mm-dd date without dragging in a timezone shift. */
export function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtMoney(amount: number | null | undefined) {
  if (amount === null || amount === undefined) return "—";
  return `₹${Number(amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export const dangerButtonClass =
  "inline-flex items-center justify-center px-4 py-2 text-sm font-medium rounded-lg bg-white text-rose-700 border border-rose-200 hover:bg-rose-50 transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

export const checkboxClass = "accent-brand-600 w-4 h-4 shrink-0 rounded";

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <h2 className="text-slate-900">{children}</h2>
      {action}
    </div>
  );
}

/** A small labelled value, used in summary grids. */
export function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900 mt-0.5">{children}</dd>
    </div>
  );
}

export function Check({ name, label, defaultChecked, hint, value }: {
  name: string;
  label: React.ReactNode;
  defaultChecked?: boolean;
  hint?: string;
  value?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className={`${checkboxClass} mt-0.5`} />
      <span>
        {label}
        {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "ok" | "error"; children: React.ReactNode }) {
  const tones = {
    info: "bg-slate-50 border-slate-200 text-slate-600",
    warn: "bg-amber-50 border-amber-200 text-amber-900",
    ok: "bg-emerald-50 border-emerald-200 text-emerald-900",
    error: "bg-rose-50 border-rose-200 text-rose-900",
  };
  return <div className={`text-sm border rounded-xl px-4 py-3 leading-relaxed ${tones[tone]}`}>{children}</div>;
}

export function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "gold" | "green" | "red" | "amber" | "blue" | "violet" }) {
  const tones = {
    neutral: "bg-slate-100 text-slate-600",
    gold: "bg-lime-100 text-lime-900",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-rose-100 text-rose-800",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    violet: "bg-violet-100 text-violet-800",
  };
  return <span className={`${pillClass} ${tones[tone]}`}>{children}</span>;
}

/** Header row of a table inside a Card: a faint grey band, small uppercase labels, one hairline. */
export const tableHeadClass =
  "text-left text-[11px] uppercase tracking-[0.06em] font-semibold text-slate-500 bg-slate-50 border-b border-slate-200";

/** Body row: a quick grey wash on hover. */
export const tableRowClass = "hover:bg-slate-50 transition-colors duration-150";

/* ── People ─────────────────────────────────────────────────────────────── */

const AVATAR_TONES = [
  "bg-brand-100 text-brand-800",
  "bg-emerald-100 text-emerald-800",
  "bg-lime-100 text-lime-900",
  "bg-amber-100 text-amber-800",
  "bg-blue-100 text-blue-800",
  "bg-violet-100 text-violet-800",
  "bg-slate-100 text-slate-700",
];

/**
 * Initials in a soft tinted circle, for the person a table row is about
 * (guest, staff member). Decorative — the name always sits beside it — so
 * it is hidden from screen readers. The tint is chosen from the name, so the
 * same person always gets the same colour.
 */
export function Avatar({ name, size = "sm" }: { name: string | null | undefined; size?: "sm" | "md" }) {
  const clean = (name ?? "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center shrink-0 rounded-full font-semibold ${
        size === "md" ? "w-9 h-9 text-xs" : "w-7 h-7 text-[10.5px]"
      } ${AVATAR_TONES[hash % AVATAR_TONES.length]}`}
    >
      {initials}
    </span>
  );
}

/* ── Search and filters ─────────────────────────────────────────────────── */

/**
 * A list's search box: a plain GET form, so submitting reloads the page with
 * `?q=` and the server component applies it to its query. `keep` carries the
 * list's other filters through as hidden fields; `page` is never carried, so
 * a new search starts on page 1.
 */
export function SearchInput({
  action,
  defaultValue = "",
  placeholder = "Search",
  name = "q",
  keep = {},
  button = "Search",
  className = "",
}: {
  /** The list's own route, e.g. "/rooms". */
  action: string;
  defaultValue?: string;
  placeholder?: string;
  name?: string;
  keep?: PageParams;
  /** Submit button label; pass `false` to rely on the Enter key alone. */
  button?: string | false;
  className?: string;
}) {
  return (
    <form action={action} role="search" className={`flex gap-2 ${className}`}>
      {Object.entries(keep).map(([k, v]) => (v && k !== "page" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div className="relative flex-1 min-w-0">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label={placeholder}
          className={`${inputClass} pl-9`}
        />
      </div>
      {button && (
        <button type="submit" className={secondaryButtonClass}>
          {button}
        </button>
      )}
    </form>
  );
}

/**
 * A row of filter chips, each a link that sets one query param. The option
 * whose value is "all" clears the param. Other filters (`params`) are kept;
 * `page` is dropped, so changing a filter always starts on page 1.
 */
export function FilterChips({
  path,
  param,
  options,
  current,
  params = {},
  label = "Filter",
}: {
  path: string;
  param: string;
  /** `swatch` is a background class for a small colour dot, when the chips double as a legend. */
  options: { value: string; label: string; count?: number; swatch?: string }[];
  current: string;
  params?: PageParams;
  /** Accessible name for the group, e.g. "Status". */
  label?: string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const active = o.value === current;
        return (
          <Link
            key={o.value}
            href={pageHref(path, { ...params, [param]: o.value === "all" ? null : o.value }, 1)}
            aria-current={active ? "true" : undefined}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs rounded-full border transition-colors duration-150 ease-out ${
              active
                ? "bg-(--g-600) border-(--g-600) text-white font-semibold shadow-sm"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900"
            }`}
          >
            {o.swatch && <span aria-hidden="true" className={`w-2 h-2 rounded-full ${o.swatch}`} />}
            {o.label}
            {o.count !== undefined && (
              <span className={`tabular-nums text-[10.5px] ${active ? "text-white/80" : "text-slate-400"}`}>{o.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function nightsBetween(checkIn: string, checkOut: string) {
  return Math.max(
    1,
    Math.round(
      (new Date(checkOut + "T00:00:00").getTime() -
        new Date(checkIn + "T00:00:00").getTime()) /
        86400000,
    ),
  );
}

/* ── Pagination ─────────────────────────────────────────────────────────── */

export { PAGE_SIZE, pageParam, pageRange, outOfRange, pageHref, clampPage } from "./paging";

/**
 * "Showing 26–50 of 312" with numbered page links. Server-rendered links, so
 * paging is plain navigation and keeps every filter in the URL. Renders
 * nothing when everything fits on one page.
 *
 * Put it as the last child of the list's Card; pass `className` to change
 * the default bar styling when the list is not in a card.
 */
export function Pagination({
  page,
  total,
  path,
  params = {},
  pageSize = PAGE_SIZE,
  className = "px-5 py-3 border-t border-slate-100",
}: {
  page: number;
  total: number;
  /** The list's own route, e.g. "/bookings". */
  path: string;
  /** The current filters, carried onto every page link. */
  params?: PageParams;
  pageSize?: number;
  className?: string;
}) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  if (last === 1 && page === 1) return null;
  const first = Math.min(total, (page - 1) * pageSize + 1);
  const end = Math.min(total, page * pageSize);
  const cell = "min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-lg text-xs tabular-nums transition-colors duration-150";
  const idle = `${cell} text-slate-600 hover:bg-slate-100 hover:text-slate-900`;
  const off = `${cell} text-slate-300`;

  return (
    <nav aria-label="Pagination" className={`flex flex-wrap items-center justify-between gap-3 print:hidden ${className}`}>
      <p className="text-xs text-slate-500 tabular-nums">
        Showing {first.toLocaleString("en-IN")}–{end.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
      </p>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={pageHref(path, params, page - 1)} aria-label="Previous page" className={idle}>
            <ChevronLeft className="w-4 h-4" />
          </Link>
        ) : (
          <span aria-hidden="true" className={off}>
            <ChevronLeft className="w-4 h-4" />
          </span>
        )}
        {pageList(Math.min(page, last), last).map((n, i) =>
          n === "gap" ? (
            <span key={`gap-${i}`} className={`${cell} text-slate-400`} aria-hidden="true">
              …
            </span>
          ) : n === page ? (
            <span key={n} aria-current="page" className={`${cell} bg-(--g-600) text-white font-semibold`}>
              {n}
            </span>
          ) : (
            <Link key={n} href={pageHref(path, params, n)} className={idle}>
              {n}
            </Link>
          ),
        )}
        {page < last ? (
          <Link href={pageHref(path, params, page + 1)} aria-label="Next page" className={idle}>
            <ChevronRight className="w-4 h-4" />
          </Link>
        ) : (
          <span aria-hidden="true" className={off}>
            <ChevronRight className="w-4 h-4" />
          </span>
        )}
      </div>
    </nav>
  );
}
