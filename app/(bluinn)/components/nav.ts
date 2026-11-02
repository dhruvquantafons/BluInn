import {
  LayoutDashboard,
  ConciergeBell,
  CalendarCheck,
  UsersRound,
  Users,
  GanttChart,
  UtensilsCrossed,
  PartyPopper,
  BedDouble,
  SprayCan,
  Wrench,
  Contact,
  Clock,
  IndianRupee,
  TrendingUp,
  BellRing,
  ReceiptIndianRupee,
  Building2,
  MoonStar,
  UserCog,
  ShieldCheck,
  Settings,
  ScrollText,
  ChartColumn,
  Hotel,
  BriefcaseBusiness,
  SlidersHorizontal,
} from "lucide-react";
import type { Permission } from "../../lib/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  /** Shown when the person holds any of these; empty means everyone. */
  any: Permission[];
};

/** Keys match the `[data-group]` tints in globals.css. */
export type GroupKey = "front" | "ops" | "commercial" | "people" | "admin";

export type NavGroup = {
  key: GroupKey;
  label: string;
  /** One line under the group name in the sidebar header card. */
  subtitle: string;
  icon: typeof LayoutDashboard;
  items: NavItem[];
};

/**
 * The admin's navigation: five top-level sections, shown as tabs in the top
 * bar, each listing its own pages in the sidebar. Every item keeps the href
 * and permissions it had in the old single sidebar list.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    key: "front",
    label: "Front Office",
    subtitle: "Arrivals, stays and the guests behind them",
    icon: ConciergeBell,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true, any: ["dashboard.view"] },
      { href: "/front-desk", label: "Front desk", icon: ConciergeBell, any: ["frontdesk.view"] },
      { href: "/bookings", label: "Bookings", icon: CalendarCheck, any: ["bookings.view"] },
      { href: "/guests", label: "Guests", icon: Contact, any: ["guests.view"] },
      { href: "/groups", label: "Groups", icon: UsersRound, any: ["bookings.groups"] },
      { href: "/tape-chart", label: "Tape chart", icon: GanttChart, any: ["bookings.view", "frontdesk.view"] },
      { href: "/night-audit", label: "Night audit", icon: MoonStar, any: ["frontdesk.night_audit"] },
    ],
  },
  {
    key: "ops",
    label: "Operations",
    subtitle: "Rooms, upkeep, outlets and events",
    icon: Hotel,
    items: [
      { href: "/rooms", label: "Rooms", icon: BedDouble, any: ["rooms.view"] },
      {
        href: "/housekeeping",
        label: "Housekeeping",
        icon: SprayCan,
        any: ["housekeeping.tasks", "housekeeping.inspect", "housekeeping.assign", "housekeeping.lost_found"],
      },
      {
        href: "/maintenance",
        label: "Maintenance",
        icon: Wrench,
        any: ["maintenance.report", "maintenance.work", "maintenance.manage"],
      },
      {
        href: "/pos",
        label: "Point of sale",
        icon: UtensilsCrossed,
        any: ["pos.view", "pos.order", "pos.pay", "pos.manage"],
      },
      {
        href: "/events",
        label: "Events & banquets",
        icon: PartyPopper,
        any: ["events.view", "events.book", "events.quote", "events.approve", "events.bill", "events.manage"],
      },
    ],
  },
  {
    key: "commercial",
    label: "Commercial",
    subtitle: "Rates, revenue, billing and reports",
    icon: BriefcaseBusiness,
    items: [
      { href: "/rates", label: "Rates", icon: IndianRupee, any: ["rates.view", "rates.manage"] },
      {
        href: "/revenue",
        label: "Revenue",
        icon: TrendingUp,
        any: ["revenue.view", "revenue.manage", "revenue.approve"],
      },
      {
        href: "/billing/invoices",
        label: "Billing",
        icon: ReceiptIndianRupee,
        any: ["folio.invoice", "folio.refund_approve", "folio.city_ledger"],
      },
      { href: "/companies", label: "Companies", icon: Building2, any: ["companies.manage"] },
      {
        href: "/reports",
        label: "Reports",
        icon: ChartColumn,
        any: ["reports.view", "reports.financial", "reports.schedule"],
      },
      {
        href: "/notifications",
        label: "Notifications",
        icon: BellRing,
        any: ["guests.view", "settings.manage", "audit.view"],
      },
    ],
  },
  {
    key: "people",
    label: "People",
    subtitle: "Shifts, attendance, leave and staff",
    icon: Users,
    items: [
      { href: "/hr", label: "HR & attendance", icon: Clock, any: [] },
      { href: "/staff", label: "Staff", icon: UserCog, any: ["staff.manage"] },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    subtitle: "Properties, roles, settings and the audit trail",
    icon: SlidersHorizontal,
    items: [
      {
        href: "/properties",
        label: "Properties",
        icon: Building2,
        any: ["properties.view", "properties.manage"],
      },
      { href: "/roles", label: "Roles", icon: ShieldCheck, any: ["roles.manage"] },
      { href: "/settings", label: "Settings", icon: Settings, any: ["settings.manage"] },
      { href: "/audit", label: "Audit log", icon: ScrollText, any: ["audit.view"] },
    ],
  },
];

/** Fired by the top bar's hamburger; the Sidebar owns the drawer and listens for it. */
export const OPEN_MENU_EVENT = "admin:open-menu";

export type Access = { isSuperuser: boolean; permissions: string[] };

/** The groups this person can see, each trimmed to the items they may open. */
export function allowedGroups(access: Access): NavGroup[] {
  const allowed = (item: NavItem) =>
    item.any.length === 0 || access.isSuperuser || item.any.some((p) => access.permissions.includes(p));
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length > 0);
}

export function isActive(item: NavItem, pathname: string) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The group a path belongs to: the one holding the longest matching href, so
 * /billing/invoices resolves to Commercial rather than to anything
 * shorter. Paths outside the nav (Password & 2FA) return null.
 */
export function groupFor(pathname: string, groups: NavGroup[] = NAV_GROUPS): NavGroup | null {
  let best: { group: NavGroup; length: number } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (isActive(item, pathname) && (!best || item.href.length > best.length)) {
        best = { group, length: item.href.length };
      }
    }
  }
  return best?.group ?? null;
}
