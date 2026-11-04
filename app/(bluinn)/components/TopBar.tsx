"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, LogOut, Menu, Search } from "lucide-react";
import { signOut } from "../actions";
import BrandMark, { Wordmark } from "./BrandMark";
import { PRODUCT } from "../../lib/app-config";
import { Avatar } from "./ui";
import { allowedGroups, groupFor, OPEN_MENU_EVENT, type Access } from "./nav";

/**
 * The blue bar across the top of every admin page:
 * - the wordmark and the five nav sections as tabs (each opens the first page
 *   in it this person may see; the sidebar then lists the rest)
 * - the booking search (or the Guests search for staff without booking
 *   access), a plain GET form focused with ⌘K / Ctrl+K
 * - the property's local time, the notification log, who is signed in, and
 *   sign out
 */
export default function TopBar({
  access,
  name,
  roleName,
  timezone,
}: {
  access: Access;
  name: string;
  roleName: string;
  timezone: string;
}) {
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const can = (...perms: string[]) => access.isSuperuser || perms.some((p) => access.permissions.includes(p));

  const groups = allowedGroups(access);
  const current = groupFor(pathname, groups);
  const search = can("bookings.view")
    ? { action: "/bookings", placeholder: "Search bookings…" }
    : can("guests.view")
      ? { action: "/guests", placeholder: "Search guests…" }
      : null;
  const seesLog = can("guests.view", "settings.manage", "audit.view");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="admin-topbar sticky top-0 z-30 h-14 flex items-center gap-3 lg:gap-6 px-3 sm:px-5 text-white print:hidden">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(OPEN_MENU_EVENT))}
        aria-label="Open menu"
        className="lg:hidden p-1.5 -ml-1 rounded-lg text-white/90 hover:bg-white/10 cursor-pointer"
      >
        <Menu className="w-5 h-5" />
      </button>

      <Link href="/" className="flex items-center gap-2.5 shrink-0">
        <span className="w-9 h-9 rounded-xl bg-white/10 ring-1 ring-white/20 flex items-center justify-center">
          <BrandMark className="w-7 h-7" />
        </span>
        <span className="hidden sm:block">
          <Wordmark className="block text-[15px] leading-none" />
          <span className="block text-[8.5px] uppercase tracking-[0.2em] text-white/65 leading-none mt-1.5">{PRODUCT.descriptor}</span>
        </span>
      </Link>

      <nav aria-label="Sections" className="hidden lg:flex shrink-0 items-center gap-0.5 p-1 rounded-xl bg-black/10 ring-1 ring-white/10">
        {groups.map((g) => {
          const active = current?.key === g.key;
          const Icon = g.icon;
          return (
            <Link
              key={g.key}
              href={g.items[0].href}
              aria-current={active ? "true" : undefined}
              className={`flex items-center gap-2 h-8 px-2.5 xl:px-3 rounded-lg text-[13.5px] whitespace-nowrap transition-colors duration-150 ${
                active
                  ? "bg-white text-brand-700 font-semibold shadow-[0_1px_2px_rgb(10_20_60/0.25)]"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              <Icon aria-hidden="true" strokeWidth={1.9} className="hidden 2xl:block w-4 h-4 shrink-0" />
              {g.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-2.5">
        {search && (
          <form action={search.action} role="search" className="relative hidden md:block lg:hidden xl:block min-w-0 w-56 2xl:w-64">
            <Search className="w-4 h-4 text-white/70 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={inputRef}
              type="search"
              name="q"
              placeholder={search.placeholder}
              aria-label={search.placeholder}
              className="w-full h-9 pl-9 pr-11 text-sm rounded-lg bg-white/12 border border-white/20 text-white placeholder:text-white/65 hover:bg-white/16 focus:outline-none focus:bg-white/20 focus:border-white/40 transition-colors duration-150"
            />
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded-md bg-white/15 text-[10.5px] font-sans text-white/80 pointer-events-none">
              ⌘K
            </kbd>
          </form>
        )}

        <PropertyClock timezone={timezone} />

        {seesLog && (
          <Link
            href="/notifications"
            aria-label="Notification log"
            title="Notification log"
            className={`w-9 h-9 inline-flex items-center justify-center rounded-full transition-colors duration-150 ${
              pathname.startsWith("/notifications") ? "bg-white/20 text-white" : "text-white/85 hover:bg-white/12 hover:text-white"
            }`}
          >
            <Bell className="w-[18px] h-[18px]" strokeWidth={1.75} />
          </Link>
        )}

        <Link href="/security" title="Password & 2FA" className="shrink-0 flex items-center gap-2.5 rounded-lg pl-1 pr-1 2xl:pr-2 py-1 hover:bg-white/10 transition-colors duration-150">
          <span className="rounded-full ring-2 ring-white/35">
            <Avatar name={name} size="md" />
          </span>
          <span className="hidden 2xl:block min-w-0 max-w-40">
            <span className="block text-[13px] font-semibold leading-tight truncate">{name}</span>
            <span className="block text-[11px] text-white/70 leading-tight truncate">{roleName}</span>
          </span>
        </Link>

        <form action={signOut} className="hidden sm:block shrink-0">
          <button
            type="submit"
            title="Sign out"
            className="inline-flex items-center gap-2 h-9 px-2.5 2xl:px-3 whitespace-nowrap rounded-lg border border-white/35 text-[13px] font-medium text-white hover:bg-white/12 hover:border-white/55 transition-colors duration-150 cursor-pointer"
          >
            <LogOut className="w-4 h-4" strokeWidth={1.75} />
            <span className="hidden 2xl:inline">Sign out</span>
          </button>
        </form>
      </div>
    </header>
  );
}

/**
 * The property's local time, ticking once a minute. Rendered only after
 * mount so the server and browser never disagree about the minute.
 */
function PropertyClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  if (!now) return null;
  let time: string;
  try {
    time = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  } catch {
    time = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  }
  return (
    <span
      title="Property time"
      className="hidden xl:inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-9 px-3 rounded-full bg-white text-[13px] font-semibold text-slate-900 tabular-nums shadow-sm"
    >
      <span aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-500 ring-3 ring-emerald-100" />
      {time}
    </span>
  );
}
