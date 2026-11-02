"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { KeyRound, LogOut, Settings, X } from "lucide-react";
import type { Staff } from "../../lib/types";
import { signOut } from "../actions";
import PropertySwitcher from "./PropertySwitcher";
import BrandMark from "./BrandMark";
import { Avatar } from "./ui";
import { allowedGroups, groupFor, isActive, OPEN_MENU_EVENT, type Access, type NavGroup, type NavItem } from "./nav";

/** Pages outside the nav still get a sidebar of their own. */
const ACCOUNT_GROUP: NavGroup = {
  key: "admin",
  label: "My account",
  subtitle: "Your password and two-step sign-in",
  icon: KeyRound,
  items: [{ href: "/security", label: "Password & 2FA", icon: KeyRound, any: [] }],
};

/**
 * The context rail beside every admin page. It lists only the pages of the
 * section picked in the top bar, under a header card in that section's tint;
 * the person's own account sits at the foot. On small screens the same
 * content opens as a drawer listing every section, from the top bar's menu
 * button.
 *
 * Which items appear is decided by `allowedGroups` (the permission filter in
 * nav.ts), unchanged from the old single list.
 */
export default function Sidebar({
  staff,
  roleName,
  access,
  properties = [],
  currentProperty = null,
}: {
  staff: Staff;
  roleName: string;
  access: Access;
  /** The hotels this person may work at (SOW Module 14). */
  properties?: { id: string; code: string; name: string }[];
  currentProperty?: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const groups = allowedGroups(access);
  const group = groupFor(pathname, groups) ?? (pathname.startsWith("/security") ? ACCOUNT_GROUP : groups[0]);
  const name = staff.full_name || staff.email;

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MENU_EVENT, show);
    return () => window.removeEventListener(OPEN_MENU_EVENT, show);
  }, []);

  const account = (
    <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-white border border-slate-200 shadow-sm">
      <Avatar name={name} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900 leading-tight">My account</span>
        <span className="block text-[12px] text-slate-500 truncate">{name}</span>
      </span>
      <Link
        href="/security"
        onClick={() => setOpen(false)}
        aria-label="Password & 2FA"
        title="Password & 2FA"
        aria-current={pathname.startsWith("/security") ? "page" : undefined}
        className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-(--g-600) hover:bg-(--g-50) aria-[current=page]:bg-(--g-100) transition-colors duration-150"
      >
        <Settings className="w-4 h-4" strokeWidth={1.75} />
      </Link>
    </div>
  );

  return (
    <>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 flex print:hidden">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="relative w-76 max-w-[85vw] bg-white flex flex-col overflow-y-auto shadow-2xl rounded-r-2xl animate-slide-down">
            <div className="admin-topbar flex items-center justify-between px-4 py-3 text-white">
              <span className="flex items-center gap-2.5">
                <BrandMark className="w-8 h-8" />
                <span>
                  <span className="admin-display block text-[15px] leading-none">BluInn</span>
                  <span className="block text-[8.5px] uppercase tracking-[0.2em] text-white/65 mt-1.5">Property management</span>
                </span>
              </span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="p-1 rounded-lg hover:bg-white/10 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-5 flex-1">
              <PropertySwitcher properties={properties} current={currentProperty} />
              <NavList
                sections={groups.map((g) => ({ heading: g.label, items: g.items }))}
                pathname={pathname}
                onNavigate={() => setOpen(false)}
              />
            </div>
            <div className="p-4 pt-0 space-y-2">
              {account}
              <p className="px-1 text-[11px] text-slate-500">{roleName}{staff.job_title ? ` · ${staff.job_title}` : ""}</p>
              <form action={signOut}>
                <button
                  type="submit"
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13.5px] text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors duration-150 cursor-pointer"
                >
                  <LogOut strokeWidth={1.75} className="w-[18px] h-[18px] shrink-0 text-slate-400" />
                  <span>Sign out</span>
                </button>
              </form>
            </div>
          </aside>
        </div>
      )}

      <aside
        className="hidden lg:flex fixed top-14 bottom-0 left-0 z-20 w-60 flex-col border-r border-slate-200 print:hidden"
        style={{ background: "linear-gradient(180deg, var(--g-50) 0%, #fff 75%)" }}
      >
        <div className="flex-1 overflow-y-auto px-3 pt-4 pb-3 space-y-4">
          {group && <GroupHeader group={group} />}
          <PropertySwitcher properties={properties} current={currentProperty} />
          {group && <NavList sections={[{ items: group.items }]} pathname={pathname} onNavigate={() => {}} />}
        </div>
        <div className="p-3">{account}</div>
      </aside>
    </>
  );
}

function GroupHeader({ group }: { group: NavGroup }) {
  const Icon = group.icon;
  return (
    <div className="flex items-start gap-3 px-2 pb-4 border-b border-(--g-200)/70">
      <span className="w-10 h-10 shrink-0 rounded-xl bg-(--g-600) text-white flex items-center justify-center shadow-sm">
        <Icon className="w-5 h-5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0">
        <span className="block text-[17px] font-semibold tracking-tight text-(--g-700) leading-tight">{group.label}</span>
        <span className="block text-[12px] text-slate-500 leading-snug mt-0.5">{group.subtitle}</span>
      </span>
    </div>
  );
}

/**
 * The nav list with a sliding highlight behind the active item.
 *
 * The highlight is one absolutely positioned element that is moved to the
 * active link after each navigation, so it glides between items instead of
 * blinking from one to the next. It is positioned directly in a layout
 * effect (no state, no re-render). Until it has been placed the active link
 * paints its own background, so there is never a frame without one. The
 * sidebar renders this twice (drawer and desktop rail); each instance
 * measures its own links.
 */
function NavList({
  sections,
  pathname,
  onNavigate,
}: {
  sections: { heading?: string; items: NavItem[] }[];
  pathname: string;
  onNavigate: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const mark = markRef.current;
    if (!nav || !mark) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) {
        mark.style.opacity = "0";
        return;
      }
      mark.style.opacity = "1";
      mark.style.height = `${active.offsetHeight}px`;
      mark.style.transform = `translateY(${active.offsetTop}px)`;
      // Only animate moves after the first placement.
      if (nav.dataset.ready !== "true") requestAnimationFrame(() => (nav.dataset.ready = "true"));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  // The longest matching href wins, so /billing/invoices lights one item.
  const all = sections.flatMap((s) => s.items).filter((item) => isActive(item, pathname));
  const activeHref = all.sort((a, z) => z.href.length - a.href.length)[0]?.href;

  return (
    <nav ref={navRef} className="group/nav relative space-y-5">
      <span
        ref={markRef}
        aria-hidden="true"
        className="absolute left-0 right-0 top-0 rounded-xl bg-(--g-100) opacity-0 pointer-events-none before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-(--g-600) group-data-[ready=true]/nav:transition-[transform,height,opacity] group-data-[ready=true]/nav:duration-300 group-data-[ready=true]/nav:ease-[cubic-bezier(0.22,1,0.36,1)]"
      />
      {sections.map((section, i) => (
        <div key={section.heading ?? i} className="space-y-1">
          {section.heading && <p className="admin-eyebrow px-3 pb-1">{section.heading}</p>}
          {section.items.map(({ href, label, icon: Icon }) => {
            const active = href === activeHref;
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`group relative z-10 flex items-center gap-3 px-2.5 py-2 rounded-xl text-[14px] transition-colors duration-150 ease-out ${
                  active
                    ? "text-(--g-800) font-semibold bg-(--g-100) group-data-[ready=true]/nav:bg-transparent"
                    : "text-slate-700 hover:bg-white hover:text-slate-900"
                }`}
              >
                <span
                  className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center border transition-colors duration-150 ${
                    active
                      ? "bg-white border-(--g-200) text-(--g-600) shadow-sm"
                      : "bg-white/70 border-slate-200 text-slate-500 group-hover:text-slate-700"
                  }`}
                >
                  <Icon strokeWidth={1.75} className="w-4 h-4" />
                </span>
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
