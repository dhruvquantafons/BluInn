import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  ChartColumn,
  CircleCheck,
  ConciergeBell,
  Gauge,
  GanttChart,
  IndianRupee,
  LogIn,
  LogOut,
  Plus,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { createClient } from "../../lib/supabase/server";
import { requireSession } from "../../lib/auth";
import { can } from "../../lib/permissions";
import { getSettings } from "../../lib/settings";
import type { Booking, Room } from "../../lib/types";
import { OCCUPYING_STATUSES, roomBoardLabel } from "../../lib/types";
import { todayIn, minutesSince, addDays } from "../../lib/dates";
import { kpisFrom, reportByKind, resolveRange, type DailyRow } from "../../lib/reports";
import { runReport } from "../../lib/report-data";
import LiveRefresh from "../components/LiveRefresh";
import {
  PageHeader,
  Card,
  CardHeader,
  EmptyState,
  StatCard,
  StatusPill,
  Avatar,
  buttonClass,
  secondaryButtonClass,
  fmtDate,
  fmtMoney,
} from "../components/ui";
import TapeChart, { TapeChartLegend } from "../components/TapeChart";
import { OccupancyRevenueChart, OCCUPANCY_COLOR, REVENUE_COLOR, RoomStatusDonut } from "../components/charts";

/**
 * Donut colours per room-board state (hex: they are drawn as SVG), in slice
 * order. Checked with the dataviz palette validator — the order keeps the
 * green away from the red, which colour-blind readers would confuse. Grey
 * for Out of Service is deliberate (the room is out of play), and the
 * legend's counts carry identity.
 */
const BOARD_TONE: Record<string, string> = {
  Occupied: "#2659d8",
  "Vacant Clean": "#3fae7a",
  "Vacant Dirty": "#dca22a",
  "Out of Order": "#cf5f52",
  "Out of Service": "#94a0b0",
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const session = await requireSession();
  const { denied } = await searchParams;
  const supabase = await createClient();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);
  const seesBookings = can(session, "bookings.view") || can(session, "frontdesk.view");
  const seesRevenue = can(session, "reports.financial");
  const canCreate = can(session, "bookings.create");

  const tapeStart = addDays(today, -1);
  const tapeDays = 14;
  const tapeEnd = addDays(tapeStart, tapeDays);

  // One daily_revenue run over the last 30 days feeds the revenue chart;
  // today's KPIs are computed from today's row alone, exactly as before.
  const revenueRows = seesRevenue
    ? (((await runReport(supabase, reportByKind("daily_revenue")!, resolveRange("last30", today))).rows ??
        []) as unknown as DailyRow[])
    : [];
  const todayKpis = seesRevenue
    ? kpisFrom(
        revenueRows.filter((r) => r.day === today),
        Number(settings.monthly_operating_cost),
      )
    : null;
  // The report's own rooms sold ÷ rooms available gives each day's occupancy.
  const revenueTrend = revenueRows
    .map((r) => ({
      day: r.day,
      occupancy: Number(r.rooms_available) > 0 ? Math.round((Number(r.rooms_sold) / Number(r.rooms_available)) * 1000) / 10 : null,
      revenue: Number(r.total_revenue),
    }))
    .sort((a, z) => a.day.localeCompare(z.day));

  const [
    tentative,
    waitlisted,
    arrivals,
    departures,
    inHouse,
    occupied,
    rooms,
    unassigned,
    openRequests,
    hkOpen,
    mtOpen,
    leavePending,
    tapeRooms,
    tapeTypes,
    tapeBookings,
    tapeBlocks,
  ] = await Promise.all([
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "tentative"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "waitlisted"),
    supabase
      .from("bookings")
      .select("*, guests(id, full_name), rooms(id, room_number)")
      .eq("check_in", today)
      .in("status", ["tentative", "confirmed"])
      .order("created_at"),
    supabase
      .from("bookings")
      .select("*, guests(id, full_name), rooms(id, room_number)")
      .eq("check_out", today)
      .eq("status", "checked_in")
      .order("created_at"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "checked_in"),
    supabase
      .from("bookings")
      .select("rooms_count")
      .lte("check_in", today)
      .gt("check_out", today)
      .in("status", OCCUPYING_STATUSES),
    supabase.from("rooms").select("id, status, housekeeping_status"),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .is("room_id", null)
      .lte("check_in", today)
      .in("status", ["confirmed", "checked_in"]),
    supabase.from("guest_requests").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase
      .from("housekeeping_tasks")
      .select("status, started_at, target_minutes")
      .lte("task_date", today)
      .in("status", ["in_progress", "cleaned"]),
    supabase
      .from("maintenance_tickets")
      .select("priority, due_at, assigned_to")
      .in("status", ["open", "in_progress", "on_hold"]),
    supabase.from("leave_requests").select("staff_id").eq("status", "pending").neq("staff_id", session.staff.id),
    supabase.from("rooms").select("*").order("room_number"),
    supabase.from("room_types").select("*").order("sort_order"),
    supabase
      .from("bookings")
      .select("id, reference, contact_name, check_in, check_out, status, room_id, room_type_id, rooms_count, is_vip")
      .in("status", ["tentative", "confirmed", "checked_in", "checked_out"])
      .lt("check_in", tapeEnd)
      .gt("check_out", tapeStart),
    supabase.from("room_blocks").select("*").is("released_at", null).lt("start_date", tapeEnd),
  ]);

  const arrivalList = (arrivals.data ?? []) as Booking[];
  const departureList = (departures.data ?? []) as Booking[];
  const roomList = (rooms.data ?? []) as Pick<Room, "id" | "status" | "housekeeping_status">[];
  const sellable = roomList.filter((r) => r.status !== "out_of_service" && r.status !== "out_of_order").length;
  const committed = (occupied.data ?? []).reduce((s, b) => s + Number((b as { rooms_count: number }).rooms_count), 0);
  const occupancy = sellable > 0 ? Math.round((committed / sellable) * 100) : null;
  const statusCounts = roomList.reduce<Record<string, number>>((acc, r) => {
    const label = roomBoardLabel(r);
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});

  const alerts: { text: string; href: string }[] = [];
  if (settings.business_date < today && can(session, "frontdesk.night_audit")) {
    alerts.push({ text: `Night audit has not closed ${fmtDate(settings.business_date)}.`, href: "/night-audit" });
  }
  if ((unassigned.count ?? 0) > 0) {
    alerts.push({ text: `${unassigned.count} arriving or in-house booking(s) have no room assigned.`, href: "/front-desk" });
  }
  if ((tentative.count ?? 0) > 0) {
    alerts.push({ text: `${tentative.count} tentative booking(s) waiting to be confirmed.`, href: "/bookings?status=tentative" });
  }
  if ((waitlisted.count ?? 0) > 0) {
    alerts.push({ text: `${waitlisted.count} guest(s) on the waitlist.`, href: "/bookings?status=waitlisted" });
  }
  const hkTasks = (hkOpen.data ?? []) as { status: string; started_at: string | null; target_minutes: number }[];
  const toInspect = hkTasks.filter((t) => t.status === "cleaned").length;
  const overdue = hkTasks.filter(
    (t) => t.status === "in_progress" && t.started_at && minutesSince(t.started_at) > t.target_minutes,
  ).length;
  if (overdue > 0 && can(session, "housekeeping.assign")) {
    alerts.push({ text: `${overdue} room clean(s) over the turnaround target.`, href: "/housekeeping" });
  }
  if (toInspect > 0 && can(session, "housekeeping.inspect")) {
    alerts.push({ text: `${toInspect} room(s) waiting for inspection.`, href: "/housekeeping" });
  }
  if ((openRequests.count ?? 0) > 0) {
    alerts.push({ text: `${openRequests.count} open guest request(s).`, href: "/front-desk" });
  }
  if (can(session, "guests.view")) {
    const { data: inHouseGuests } = await supabase
      .from("bookings")
      .select("guests(date_of_birth, anniversary)")
      .eq("status", "checked_in")
      .not("guest_id", "is", null);
    const md = today.slice(5);
    const celebrating = (inHouseGuests ?? []).filter((b) => {
      const g = b.guests as unknown as { date_of_birth: string | null; anniversary: string | null } | null;
      return g?.date_of_birth?.slice(5) === md || g?.anniversary?.slice(5) === md;
    }).length;
    if (celebrating) {
      alerts.push({ text: `${celebrating} in-house guest(s) celebrating a birthday or anniversary today.`, href: "/guests/occasions" });
    }
  }
  const tickets = (mtOpen.data ?? []) as { priority: string; due_at: string; assigned_to: string | null }[];
  if (can(session, "maintenance.manage") || can(session, "maintenance.work")) {
    const urgent = tickets.filter((t) => t.priority === "urgent").length;
    const late = tickets.filter((t) => minutesSince(t.due_at) > 0).length;
    const mine = tickets.filter((t) => t.assigned_to === session.staff.id).length;
    if (urgent) alerts.push({ text: `${urgent} urgent maintenance ticket(s) open.`, href: "/maintenance?priority=urgent" });
    if (late) alerts.push({ text: `${late} maintenance ticket(s) past their resolution target.`, href: "/maintenance" });
    if (mine && !can(session, "maintenance.manage")) {
      alerts.push({ text: `${mine} maintenance ticket(s) assigned to you.`, href: "/maintenance/mine" });
    }
  }
  if (can(session, "hr.approve_leave") && leavePending.data?.length) {
    alerts.push({ text: `${leavePending.data.length} leave request(s) waiting for approval.`, href: "/hr/leave" });
  }

  const canFrontDesk = can(session, "frontdesk.view");
  const shown = alerts.slice(0, 3);

  return (
    <>
      <LiveRefresh tables={["bookings", "rooms", "guest_requests", "maintenance_tickets"]} />
      <PageHeader
        eyebrow={new Date(today + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
        title={`Good day, ${session.staff.full_name.split(" ")[0] || "there"}`}
        description={`${fmtDate(today)} · business date ${fmtDate(settings.business_date)}`}
        chips={[
          ...shown.map((a) => ({ label: a.text, href: a.href, tone: "warn" as const, icon: <AlertTriangle /> })),
          ...(alerts.length > shown.length ? [{ label: `${alerts.length - shown.length} more`, href: "#attention" }] : []),
        ]}
        action={
          canCreate || canFrontDesk || seesBookings ? (
            <>
              {canCreate && (
                <Link href="/bookings/new" className={buttonClass}>
                  <Plus className="w-4 h-4 mr-1.5" /> New booking
                </Link>
              )}
              {canFrontDesk && (
                <Link href="/front-desk" className={secondaryButtonClass}>
                  <ConciergeBell className="w-4 h-4 mr-1.5" /> Front desk
                </Link>
              )}
              {seesBookings && (
                <Link href="/tape-chart" className={secondaryButtonClass}>
                  <GanttChart className="w-4 h-4 mr-1.5" /> Tape chart
                </Link>
              )}
            </>
          ) : null
        }
        stats={
          seesBookings
            ? [
                { label: "Arriving today", value: arrivalList.length, icon: <LogIn />, href: "/front-desk" },
                { label: "Departing today", value: departureList.length, icon: <LogOut />, href: "/front-desk" },
                { label: "In house", value: inHouse.count ?? 0, icon: <BedDouble />, href: "/front-desk" },
                {
                  label: "Occupancy tonight",
                  value: occupancy === null ? "—" : `${occupancy}%`,
                  hint: sellable ? `${committed} of ${sellable} rooms` : "Add rooms to inventory",
                  icon: <Gauge />,
                  href: "/rooms",
                },
              ]
            : undefined
        }
        progress={
          seesBookings && occupancy !== null
            ? { value: occupancy, label: <><strong className="font-semibold text-white">{occupancy}%</strong> occupied tonight · {committed} of {sellable} rooms</> }
            : undefined
        }
      />

      {denied && (
        <div className="mb-6 flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          Your role does not include that section.
        </div>
      )}

      {alerts.length > 0 ? (
        <Card className="mb-6">
          <div id="attention" className="scroll-mt-24">
            <CardHeader icon={<AlertTriangle />} title="Needs attention" count={alerts.length} />
          </div>
          <div className="divide-y divide-slate-100">
            {alerts.map((a) => (
              <Link key={a.text} href={a.href} className="group flex items-center gap-3 px-5 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors duration-150">
                <span className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
                </span>
                {a.text}
                <ArrowRight className="w-3.5 h-3.5 ml-auto text-slate-300 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:text-slate-500" />
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="mb-6 flex items-center gap-3 px-5 py-4">
          <span className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
            <CircleCheck className="w-[18px] h-[18px]" />
          </span>
          <p className="text-sm text-slate-600">
            <strong className="font-semibold text-slate-900">You&apos;re all clear.</strong> Nothing is waiting on you.
          </p>
        </Card>
      )}

      {seesBookings && todayKpis && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="ADR today"
            value={fmtMoney(todayKpis.adr)}
            hint="Room revenue ÷ rooms sold"
            href="/reports"
            icon={<IndianRupee />}
          />
          <StatCard
            label="RevPAR today"
            value={fmtMoney(todayKpis.revpar)}
            hint="Room revenue ÷ rooms available"
            href="/reports"
            icon={<BedDouble />}
          />
          <StatCard
            label="Revenue today"
            value={fmtMoney(todayKpis.totalRevenue)}
            hint="Including tax"
            href="/reports/financial"
            icon={<Wallet />}
            highlight
          />
          <StatCard
            label="GOPPAR today"
            value={todayKpis.goppar === null ? "—" : fmtMoney(todayKpis.goppar)}
            hint={todayKpis.goppar === null ? "Set a monthly operating cost" : "After operating cost"}
            href="/reports"
            icon={<TrendingUp />}
          />
        </div>
      )}

      {((seesBookings && todayKpis) || roomList.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {seesBookings && todayKpis && (
            <Card className={roomList.length > 0 ? "lg:col-span-2" : "lg:col-span-3"}>
              <CardHeader
                icon={<ChartColumn />}
                title="Occupancy & revenue"
                description="Last 30 days · revenue including tax"
                href="/reports/financial"
                linkLabel="Financial report"
                action={
                  <div className="hidden sm:flex items-center gap-4 text-xs text-slate-600 mr-2">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: OCCUPANCY_COLOR }} /> Occupancy
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: REVENUE_COLOR }} /> Revenue
                    </span>
                  </div>
                }
              />
              <div className="px-5 py-4">
                <OccupancyRevenueChart data={revenueTrend} />
              </div>
            </Card>
          )}
          {roomList.length > 0 && (
            <Card className={seesBookings && todayKpis ? "" : "lg:col-span-3"}>
              <CardHeader icon={<BedDouble />} title="Room status" href="/rooms" linkLabel="Room board" />
              <div className="px-5 py-4">
                <RoomStatusDonut
                  data={Object.keys(BOARD_TONE).map((label) => ({
                    label,
                    count: statusCounts[label] ?? 0,
                    color: BOARD_TONE[label],
                  }))}
                />
              </div>
            </Card>
          )}
        </div>
      )}

      {seesBookings && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <MovementList title="Arrivals" icon={<LogIn />} bookings={arrivalList} empty="No arrivals today." />
            <MovementList title="Departures" icon={<LogOut />} bookings={departureList} empty="No departures today." />
          </div>

          {(tapeRooms.data?.length ?? 0) > 0 && (
            <Card className="mb-6 overflow-hidden">
              <CardHeader icon={<GanttChart />} title="Tape chart" href="/tape-chart" linkLabel="Full tape chart" />
              <div className="px-5 pt-4">
                <TapeChartLegend />
              </div>
              <div className="overflow-x-auto border-t border-slate-100">
                <TapeChart
                  rooms={tapeRooms.data ?? []}
                  roomTypes={tapeTypes.data ?? []}
                  bookings={(tapeBookings.data ?? []) as unknown as Booking[]}
                  blocks={tapeBlocks.data ?? []}
                  start={tapeStart}
                  days={tapeDays}
                  today={today}
                  canCreate={canCreate}
                />
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function MovementList({
  title,
  icon,
  bookings,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  bookings: Booking[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader icon={icon} title={title} count={bookings.length} href="/front-desk" />
      {bookings.length === 0 ? (
        <EmptyState icon={icon} message={empty} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {bookings.map((b) => (
            <li key={b.id}>
              <Link href={`/bookings/${b.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors duration-150">
                <Avatar name={b.guests?.full_name || b.contact_name} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-900 truncate">
                    {b.guests?.full_name || b.contact_name || "Unnamed guest"}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {b.adults + b.children} guest(s) · {b.rooms_count} room(s)
                  </span>
                </span>
                <span className={`text-xs tabular-nums ${b.rooms?.room_number ? "text-slate-600" : "text-amber-700"}`}>
                  {b.rooms?.room_number ?? "No room"}
                </span>
                <StatusPill status={b.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
