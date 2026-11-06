import Link from "next/link";
import { LogIn, LogOut, BedDouble, Search, UserPlus, Bell, Star, Plane, Wallet } from "lucide-react";
import { createClient } from "../../../lib/supabase/server";
import { requirePermission } from "../../../lib/auth";
import { can } from "../../../lib/permissions";
import { getSettings, hhmm } from "../../../lib/settings";
import { addDays, todayIn, zonedTime } from "../../../lib/dates";
import { depositState, occasionInStay } from "../../../lib/front-desk";
import { folioTotals } from "../../../lib/policies";
import type { Booking, FolioEntry, GuestRequest } from "../../../lib/types";
import { REQUEST_KIND_LABELS, STAY_TYPE_LABELS } from "../../../lib/types";
import { createGuestRequest, updateGuestRequest } from "../../frontdesk-actions";
import {
  PageHeader,
  Card,
  CardHeader,
  EmptyState,
  Avatar,
  StatusPill,
  Tag,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  inputClass,
  buttonClass,
  secondaryButtonClass,
  Field,
} from "../../components/ui";
import ActionForm from "../../components/ActionForm";
import LiveRefresh from "../../components/LiveRefresh";
import CashierShiftCard, { loadMyShift } from "../../components/CashierShiftCard";
import DiscrepancyCard, { loadDiscrepancies } from "../../components/DiscrepancyCard";

type DeskBooking = Booking & { rooms: { id: string; room_number: string } | null };

const SELECT =
  "*, guests(id, full_name, email, phone, tags, date_of_birth, anniversary), room_types(id, name), rooms(id, room_number)";

type DeskGuest = { tags?: string[]; date_of_birth?: string | null; anniversary?: string | null };

export default async function FrontDeskPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requirePermission("frontdesk.view");
  const { q = "" } = await searchParams;
  const supabase = await createClient();
  const settings = await getSettings();
  const today = todayIn(settings.timezone);

  const dayStart = zonedTime(today, "00:00", settings.timezone).toISOString();
  const dayEnd = zonedTime(addDays(today, 1), "00:00", settings.timezone).toISOString();

  const [arrivalsRes, inHouseRes, requestsRes, searchRes, transfersRes, depositsRes, departmentsRes] = await Promise.all([
    supabase
      .from("bookings")
      .select(SELECT)
      .in("status", ["tentative", "confirmed"])
      .lte("check_in", today)
      .gt("check_out", today)
      .order("check_in")
      .order("eta", { nullsFirst: false }),
    supabase.from("bookings").select(SELECT).eq("status", "checked_in").order("check_out"),
    supabase
      .from("guest_requests")
      .select("*, rooms(room_number), bookings(contact_name, reference), departments(name)")
      .eq("status", "open")
      .order("due_at", { nullsFirst: false })
      .order("created_at"),
    q.trim()
      ? (() => {
          // Quick check-in search: confirmation number, name or phone.
          const term = `%${q.trim().replace(/[%,()]/g, "")}%`;
          return supabase
            .from("bookings")
            .select(SELECT)
            .or(`reference.ilike.${term},contact_name.ilike.${term},contact_phone.ilike.${term},contact_email.ilike.${term}`)
            .in("status", ["tentative", "confirmed", "checked_in", "waitlisted"])
            .order("check_in")
            .limit(20);
        })()
      : Promise.resolve({ data: null }),
    // Today's airport and station transfers (0031).
    supabase
      .from("bookings")
      .select("id, reference, contact_name, pickup_required, pickup_at, pickup_details, drop_required, drop_at, drop_details, rooms(room_number)")
      .in("status", ["tentative", "confirmed", "checked_in"])
      .or(
        `and(pickup_required.eq.true,pickup_at.gte.${dayStart},pickup_at.lt.${dayEnd}),and(drop_required.eq.true,drop_at.gte.${dayStart},drop_at.lt.${dayEnd})`,
      ),
    // Deposits that fall due in the next three days, or already have.
    supabase
      .from("bookings")
      .select("id, reference, contact_name, check_in, deposit_required, deposit_due_on")
      .in("status", ["tentative", "confirmed"])
      .gt("deposit_required", 0)
      .lte("deposit_due_on", addDays(today, 3))
      .order("deposit_due_on"),
    supabase.from("departments").select("id, name").order("sort_order"),
  ]);

  const arrivals = (arrivalsRes.data ?? []) as DeskBooking[];
  const inHouse = (inHouseRes.data ?? []) as DeskBooking[];
  const departures = inHouse.filter((b) => b.check_out <= today);
  const stayovers = inHouse.filter((b) => b.check_out > today);
  const requests = (requestsRes.data ?? []) as (GuestRequest & {
    rooms: { room_number: string } | null;
    bookings: { contact_name: string; reference: string } | null;
    departments: { name: string } | null;
  })[];
  type Transfer = {
    id: string;
    reference: string;
    contact_name: string;
    pickup_required: boolean;
    pickup_at: string | null;
    pickup_details: string;
    drop_required: boolean;
    drop_at: string | null;
    drop_details: string;
    rooms: { room_number: string } | null;
  };
  const transfers = ((transfersRes.data ?? []) as unknown as Transfer[])
    .flatMap((b) => [
      ...(b.pickup_required && b.pickup_at && b.pickup_at >= dayStart && b.pickup_at < dayEnd
        ? [{ booking: b, kind: "Pick-up" as const, at: b.pickup_at, details: b.pickup_details }]
        : []),
      ...(b.drop_required && b.drop_at && b.drop_at >= dayStart && b.drop_at < dayEnd
        ? [{ booking: b, kind: "Drop" as const, at: b.drop_at, details: b.drop_details }]
        : []),
    ])
    .sort((a, b) => a.at.localeCompare(b.at));
  const departments = (departmentsRes.data ?? []) as { id: string; name: string }[];
  const results = (searchRes.data ?? null) as DeskBooking[] | null;

  const { data: folio } = inHouse.length
    ? await supabase
        .from("folio_entries")
        .select("booking_id, kind, amount, tax_amount, voided_at, is_deposit")
        .in("booking_id", inHouse.map((b) => b.id))
    : { data: [] };
  const balanceOf = (id: string) =>
    folioTotals(((folio ?? []) as FolioEntry[]).filter((e) => e.booking_id === id)).balance;

  type DueDeposit = { id: string; reference: string; contact_name: string; check_in: string; deposit_required: number; deposit_due_on: string };
  const dueDeposits = (depositsRes.data ?? []) as DueDeposit[];
  const { data: depositEntries } = dueDeposits.length
    ? await supabase
        .from("folio_entries")
        .select("booking_id, kind, amount, tax_amount, voided_at, is_deposit")
        .in("booking_id", dueDeposits.map((b) => b.id))
    : { data: [] };
  const depositsOwed = dueDeposits
    .map((b) => {
      const received = folioTotals(((depositEntries ?? []) as FolioEntry[]).filter((e) => e.booking_id === b.id)).payments;
      return { ...b, received, state: depositState(Number(b.deposit_required), received, b.deposit_due_on, today) };
    })
    .filter((b) => b.state !== "received" && b.state !== "none");

  const isCashier = can(session, "folio.cashier");
  const [myShift, discrepancies] = await Promise.all([
    isCashier ? loadMyShift(supabase, session.staff.id) : Promise.resolve(null),
    loadDiscrepancies(supabase),
  ]);

  const canCheckIn = can(session, "frontdesk.checkin");
  const canCheckOut = can(session, "frontdesk.checkout");

  return (
    <>
      <LiveRefresh tables={["bookings", "rooms", "guest_requests"]} />
      <PageHeader
        title="Front desk"
        description={`Today, ${fmtDate(today)}. Check-in from ${hhmm(settings.check_in_time)}, check-out by ${hhmm(settings.check_out_time)}.`}
        stats={[
          { label: "To arrive", value: arrivals.length, icon: <LogIn /> },
          { label: "To depart", value: departures.length, icon: <LogOut /> },
          { label: "In house", value: inHouse.length, icon: <BedDouble /> },
        ]}
        action={
          can(session, "bookings.create") ? (
            <Link href="/bookings/new?walkin=1" className={buttonClass}>
              <span className="flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5" /> Walk-in
              </span>
            </Link>
          ) : null
        }
      />

      <Card className="mb-6 p-3">
        <form className="flex gap-2" action="/front-desk">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              name="q"
              defaultValue={q}
              autoFocus
              placeholder="Find a guest: confirmation number, name or phone"
              className={`${inputClass} pl-9`}
            />
          </div>
          <button type="submit" className={buttonClass}>
            Find
          </button>
        </form>
      </Card>

      {results && (
        <Card className="mb-6">
          <p className="px-5 py-3 text-xs text-slate-600 border-b border-slate-100">
            {results.length} match(es) for “{q}”
          </p>
          <BookingRows bookings={results} today={today} canCheckIn={canCheckIn} canCheckOut={canCheckOut} />
        </Card>
      )}

      <div className="space-y-6">
        {isCashier && (
          <CashierShiftCard
            mine={myShift}
            required={settings.require_cashier_shift}
            guests={
              can(session, "folio.post")
                ? inHouse.map((b) => ({
                    id: b.id,
                    label: `${b.rooms?.room_number ? `Room ${b.rooms.room_number} · ` : ""}${b.contact_name} (${b.reference})`,
                  }))
                : []
            }
          />
        )}

        <DiscrepancyCard rows={discrepancies} />

        {(transfers.length > 0 || depositsOwed.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {transfers.length > 0 && (
              <Card>
                <CardHeader icon={<Plane />} title="Transfers today" count={transfers.length} />
                <ul className="divide-y divide-slate-100">
                  {transfers.map((t) => (
                    <li key={`${t.booking.id}-${t.kind}`} className="px-5 py-2.5 text-sm">
                      <span className="font-medium text-slate-900 tabular-nums">
                        {new Date(t.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: settings.timezone })}
                      </span>{" "}
                      <Tag tone={t.kind === "Pick-up" ? "blue" : "violet"}>{t.kind}</Tag>{" "}
                      <Link href={`/bookings/${t.booking.id}`} className="text-slate-700 hover:text-brand-700">
                        {t.booking.contact_name}
                        {t.booking.rooms?.room_number ? ` · ${t.booking.rooms.room_number}` : ""}
                      </Link>
                      {t.details && <span className="block text-[11px] text-slate-500">{t.details}</span>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {depositsOwed.length > 0 && (
              <Card>
                <CardHeader icon={<Wallet />} title="Deposits due" count={depositsOwed.length} />
                <ul className="divide-y divide-slate-100">
                  {depositsOwed.map((b) => (
                    <li key={b.id} className="px-5 py-2.5 text-sm flex flex-wrap items-center gap-2">
                      <Link href={`/bookings/${b.id}?tab=folio`} className="text-slate-900 hover:text-brand-700">
                        {b.contact_name}
                      </Link>
                      <span className="text-[11px] text-slate-500">
                        {b.reference} · arrives {fmtDate(b.check_in)}
                      </span>
                      <span className="ml-auto text-xs tabular-nums">
                        {fmtMoney(Number(b.deposit_required) - b.received)} by {fmtDate(b.deposit_due_on)}
                      </span>
                      {b.state === "overdue" && <Tag tone="red">Overdue</Tag>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        <Card>
          <CardHeader icon={<LogIn />} title="Arrivals" count={arrivals.length} />
          {arrivals.length === 0 ? (
            <EmptyState icon={<LogIn />} message="No more arrivals due today." />
          ) : (
            <BookingRows bookings={arrivals} today={today} canCheckIn={canCheckIn} canCheckOut={canCheckOut} />
          )}
        </Card>

        <Card>
          <CardHeader icon={<LogOut />} title="Departures" count={departures.length} />
          {departures.length === 0 ? (
            <EmptyState icon={<LogOut />} message="No departures left today." />
          ) : (
            <BookingRows
              bookings={departures}
              today={today}
              canCheckIn={canCheckIn}
              canCheckOut={canCheckOut}
              balanceOf={balanceOf}
            />
          )}
        </Card>

        <Card>
          <CardHeader icon={<BedDouble />} title="Staying on" count={stayovers.length} />
          {stayovers.length === 0 ? (
            <EmptyState icon={<BedDouble />} message="No stay-over guests." />
          ) : (
            <BookingRows
              bookings={stayovers}
              today={today}
              canCheckIn={canCheckIn}
              canCheckOut={canCheckOut}
              balanceOf={balanceOf}
            />
          )}
        </Card>

        {can(session, "frontdesk.requests") && (
          <Card>
            <CardHeader
              icon={<Bell />}
              title="Guest requests"
              action={<span className="text-xs text-slate-500">{requests.length} open</span>}
            />
            <div className="p-5">

              {requests.length > 0 && (
                <ul className="divide-y divide-slate-100 mb-5 border border-slate-100 rounded-lg">
                  {requests.map((r) => {
                    const overdue = r.due_at && new Date(r.due_at) < new Date();
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <Tag tone={r.kind === "complaint" ? "red" : r.kind === "wake_up_call" ? "violet" : r.kind === "trace" ? "blue" : "gold"}>
                          {REQUEST_KIND_LABELS[r.kind]}
                          {r.departments?.name ? ` · ${r.departments.name}` : ""}
                        </Tag>
                        <div className="flex-1 min-w-[180px]">
                          <p className="text-sm text-slate-900">{r.description}</p>
                          <p className="text-[11px] text-slate-500">
                            {r.rooms?.room_number ? `Room ${r.rooms.room_number} · ` : ""}
                            {r.bookings?.contact_name ?? ""}
                            {r.due_at && (
                              <span className={overdue ? "text-rose-700 font-medium" : ""}>
                                {" "}
                                · due {fmtDateTime(r.due_at)}
                              </span>
                            )}
                          </p>
                        </div>
                        <form action={updateGuestRequest}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="done" />
                          <button type="submit" className={`${secondaryButtonClass} !py-1.5`}>
                            Done
                          </button>
                        </form>
                      </li>
                    );
                  })}
                </ul>
              )}

              <ActionForm action={createGuestRequest} submitLabel="Log request" className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <Field label="For">
                    <select name="booking_id" className={inputClass} defaultValue="">
                      <option value="">No guest (general)</option>
                      {inHouse.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.rooms?.room_number ? `${b.rooms.room_number} · ` : ""}
                          {b.contact_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Type">
                    <select name="kind" className={inputClass} defaultValue="request">
                      {Object.entries(REQUEST_KIND_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Due date">
                    <input type="date" name="due_date" defaultValue={today} className={inputClass} />
                  </Field>
                  <Field label="Due time">
                    <input type="time" name="due_time" className={inputClass} />
                  </Field>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="sm:col-span-3">
                    <Field label="Details">
                      <input name="description" required placeholder="Wake-up call, extra towels, message from…" className={inputClass} />
                    </Field>
                  </div>
                  <Field label="Department" hint="For a trace: who follows it up.">
                    <select name="department_id" defaultValue="" className={inputClass}>
                      <option value="">—</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </ActionForm>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function BookingRows({
  bookings,
  today,
  canCheckIn,
  canCheckOut,
  balanceOf,
}: {
  bookings: DeskBooking[];
  today: string;
  canCheckIn: boolean;
  canCheckOut: boolean;
  balanceOf?: (id: string) => number;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {bookings.map((b) => {
        const balance = balanceOf?.(b.id);
        const arriving = ["tentative", "confirmed"].includes(b.status);
        return (
          <li key={b.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <Avatar name={b.guests?.full_name || b.contact_name} />
            <Link href={`/bookings/${b.id}`} className="flex-1 min-w-[200px] group">
              <p className="text-sm font-medium text-slate-900 group-hover:text-brand-700 flex items-center gap-1.5">
                {(b.is_vip || ((b.guests as DeskGuest | null)?.tags ?? []).includes("VIP")) && (
                  <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" aria-label="VIP" />
                )}
                {b.guests?.full_name || b.contact_name || "Unnamed guest"}
                {occasionInStay((b.guests as DeskGuest | null)?.date_of_birth, b.check_in, b.check_out) && (
                  <Tag tone="violet">Birthday</Tag>
                )}
                {occasionInStay((b.guests as DeskGuest | null)?.anniversary, b.check_in, b.check_out) && (
                  <Tag tone="violet">Anniversary</Tag>
                )}
                {b.stay_type && b.stay_type !== "paid" && <Tag tone="blue">{STAY_TYPE_LABELS[b.stay_type]}</Tag>}
                {b.pickup_required && <Tag tone="neutral">Pick-up</Tag>}
              </p>
              <p className="text-[11px] text-slate-500">
                <span className="font-mono">{b.reference}</span> · {b.room_types?.name ?? "Room"} · {fmtDate(b.check_in)} →{" "}
                {fmtDate(b.check_out)}
                {b.eta ? ` · ETA ${b.eta.slice(0, 5)}` : ""}
                {arriving && b.check_in < today ? " · late arrival" : ""}
              </p>
            </Link>

            <span className={`text-xs whitespace-nowrap ${b.rooms?.room_number ? "text-slate-700" : "text-amber-700"}`}>
              {b.rooms?.room_number ? `Room ${b.rooms.room_number}` : "No room"}
            </span>

            {balance !== undefined && (
              <span className={`text-xs whitespace-nowrap ${balance > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                {balance > 0 ? `Owes ${fmtMoney(balance)}` : "Settled"}
              </span>
            )}

            <StatusPill status={b.status} />

            {arriving && canCheckIn && b.check_in <= today && (
              <Link href={`/bookings/${b.id}/check-in`} className={`${buttonClass} !py-1.5`}>
                Check in
              </Link>
            )}
            {b.status === "checked_in" && canCheckOut && (
              <Link href={`/bookings/${b.id}/check-out`} className={`${secondaryButtonClass} !py-1.5`}>
                Check out
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
