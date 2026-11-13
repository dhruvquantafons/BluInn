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
  UserCog,
  ShieldCheck,
  Settings,
  ScrollText,
  ChartColumn,
  Hotel,
  BriefcaseBusiness,
  SlidersHorizontal,
  MoonStar,
  Wallet,
  Boxes,
  Activity,
  DatabaseBackup,
} from "lucide-react";
import type { Permission } from "../../lib/permissions";
import { BILLING_TABS, REPORT_TABS, firstOpenable } from "../../lib/page-access";

export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  /** Shown when the person holds any of these; empty means everyone. */
  any: Permission[];
  /**
   * Other pages of the section, tried in order when the person cannot open
   * href itself; the link then goes to the first one they can (0043).
   */
  tabs?: string[];
  /** The section root this item stays highlighted under, when href may change. */
  match?: string;
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
      { href: "/front-desk", label: "Front desk", icon: ConciergeBell, exact: true, any: ["frontdesk.view"] },
      { href: "/front-desk/shifts", label: "Cash shifts", icon: Wallet, any: ["folio.cashier", "folio.cashier_audit", "reports.financial"] },
      { href: "/bookings", label: "Bookings", icon: CalendarCheck, any: ["bookings.view"] },
      { href: "/guests", label: "Guests", icon: Contact, any: ["guests.view"] },
      { href: "/groups", label: "Groups", icon: UsersRound, any: ["bookings.groups"] },
      { href: "/tape-chart", label: "Tape chart", icon: GanttChart, any: ["bookings.view", "frontdesk.view"] },
      { href: "/night-audit", label: "Night audit", icon: MoonStar, any: ["frontdesk.night_audit", "folio.view"] },
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
        tabs: ["/housekeeping/my-tasks", "/housekeeping/lost-found"],
        match: "/housekeeping",
        label: "Housekeeping",
        icon: SprayCan,
        any: ["housekeeping.tasks", "housekeeping.inspect", "housekeeping.assign", "housekeeping.lost_found"],
      },
      {
        href: "/maintenance",
        tabs: ["/maintenance/mine"],
        match: "/maintenance",
        label: "Maintenance",
        icon: Wrench,
        any: ["maintenance.report", "maintenance.work", "maintenance.manage"],
      },
      { href: "/inventory", label: "Inventory", icon: Boxes, any: ["inventory.view", "inventory.manage"] },
      {
        href: "/pos",
        label: "Point of sale",
        icon: UtensilsCrossed,
        any: ["pos.view", "pos.order", "pos.pay", "pos.manage"],
      },
      {
        href: "/events",
        tabs: ["/events/diary", "/events/setup"],
        match: "/events",
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
        tabs: BILLING_TABS.slice(1),
        match: "/billing",
        label: "Billing",
        icon: ReceiptIndianRupee,
        any: ["folio.view", "folio.invoice", "folio.refund_approve", "folio.credit_note", "reports.financial"],
      },
      {
        href: "/reports",
        tabs: REPORT_TABS.slice(1),
        match: "/reports",
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
      { href: "/settings/status", label: "System status", icon: Activity, any: ["settings.manage"] },
      { href: "/settings/export", label: "Data export", icon: DatabaseBackup, any: ["data.export"] },
      { href: "/audit", label: "Audit log", icon: ScrollText, any: ["audit.view"] },
    ],
  },
];

/** Fired by the top bar's hamburger; the Sidebar owns the drawer and listens for it. */
export const OPEN_MENU_EVENT = "bluinn:open-menu";

export type Access = { isSuperuser: boolean; permissions: string[] };

/**
 * The groups this person can see, each trimmed to the items they may open.
 * An item is shown only if its page (or one of its section's tabs) admits the
 * person, and it links to the first of those they can open (0043): it used to
 * show on its own permission list and then bounce people with "access denied".
 */
export function allowedGroups(access: Access): NavGroup[] {
  const usable = (item: NavItem): NavItem | null => {
    if (!item.any.length || access.isSuperuser || item.any.some((p) => access.permissions.includes(p))) {
      const target = firstOpenable(access, [item.href, ...(item.tabs ?? [])]);
      return target ? { ...item, href: target } : null;
    }
    return null;
  };
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.map(usable).filter((i): i is NavItem => i !== null) })).filter(
    (g) => g.items.length > 0,
  );
}

export function isActive(item: NavItem, pathname: string) {
  const root = item.match ?? item.href;
  return item.exact ? pathname === item.href : pathname === root || pathname.startsWith(`${root}/`);
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
