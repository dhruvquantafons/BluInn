"use client";

import { usePathname } from "next/navigation";
import { groupFor } from "./nav";

/**
 * Tags the shell with the current nav section (`data-group`), so the section
 * tints in globals.css reach every server-rendered page below it: the hero
 * banner, stat cards and sidebar all read `--g-*` and `--hero-*` instead of
 * being told which section they are in. Paths outside the nav (Password &
 * 2FA) fall back to the Admin tint.
 */
export default function GroupScope({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const pathname = usePathname();
  return (
    <div data-group={groupFor(pathname)?.key ?? "admin"} className={className}>
      {children}
    </div>
  );
}
