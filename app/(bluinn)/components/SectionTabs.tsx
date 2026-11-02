"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A section's sub-pages, as a segmented bar under its hero banner. The first
 * tab is active only on its exact path (or a deeper path no other tab owns).
 */
export default function SectionTabs({ tabs, label }: { tabs: { href: string; label: string }[]; label: string }) {
  const pathname = usePathname();
  const root = tabs[0]?.href;
  if (tabs.length < 2) return null;
  return (
    <nav
      aria-label={label}
      className="flex gap-1 p-1 mb-6 overflow-x-auto bg-white border border-slate-200 rounded-xl shadow-sm print:hidden"
    >
      {tabs.map((t) => {
        const active =
          t.href === root
            ? pathname === t.href || (!tabs.some((o) => o.href !== root && pathname.startsWith(o.href)) && pathname.startsWith(`${t.href}/`))
            : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 px-3.5 py-2 rounded-lg text-[13.5px] whitespace-nowrap transition-colors duration-150 ${
              active
                ? "bg-(--g-50) text-(--g-700) font-semibold ring-1 ring-inset ring-(--g-200)"
                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
