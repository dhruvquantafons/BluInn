"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../lib/supabase/server";
import { requirePermission } from "../lib/auth";
import { can } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import { getCurrentProperty } from "../lib/properties";
import { friendlyDbError } from "../lib/db-errors";
import { noShowPenalty } from "../lib/policies";
import { ancillaryCharge, postRoomCharges } from "../lib/folio";
import { overstayExtension, propertyInvoiceProblem } from "../lib/checkout";
import { issueOutstandingInvoices, lastBillTo } from "../lib/invoice-issue";
import { addDays, todayIn, zonedTime } from "../lib/dates";
import { escalateOverdueTickets } from "../lib/staff-alerts";
import type { Booking, FolioEntry, RatePlan } from "../lib/types";
import { type ActionState, bool } from "./form-utils";

/**
 * Night audit (Module 2): closes the hotel's business day.
 *
 *   1. Posts room charges and tax for every in-house guest for the night.
 *   2. Marks expected arrivals who never came as no-shows (optional), posting
 *      the rate plan's no-show penalty.
 *   3. Releases tentative holds that have expired.
 *   4. Closes the day's folio entries, so they can no longer be voided.
 *      Cash shifts are not closed: the audit page lists any still open, and
 *      each cashier (or a cash-shift auditor) counts and closes the drawer.
 *   5. Syncs room availability with room blocks for tomorrow, schedules
 *      due deep cleans and preventive maintenance, and escalates overdue
 *      maintenance tickets.
 *   6. Purges identity scans past the retention period, retires expired
 *      loyalty points, re-checks every member's tier and totals the outlet
 *      takings.
 *   7. Stores the daily revenue report and rolls the business date forward.
 *
 * Each step is idempotent, so a run that fails part-way can be run again.
 */
/** How long a "running" audit blocks another attempt before it is presumed dead. */
const RUNNING_LEASE_MS = 5 * 60 * 1000;

export async function runNightAudit(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requirePermission("frontdesk.night_audit");
  const supabase = await createClient();
  const settings = await getSettings();
  const day = settings.business_date;
  const nextDay = addDays(day, 1);
  const staffId = session.staff.id;

  if (!bool(fd, "confirm"))
    return { error: `Tick the box to confirm closing ${day}.` };

  // Each property closes its own day, so every lookup here is keyed by both
  // (the primary key became (property_id, business_date) in 0024). Without the
  // property, a group owner with two hotels open would match two rows.
  const property = await getCurrentProperty();
  if (!property) return { error: "No property is selected." };

  // The day being closed must have started. Running before midnight is fine
  // (many hotels close at 23:00); closing a date that is still ahead of the
  // calendar would charge a night nobody has slept yet.
  if (day > todayIn(settings.timezone)) {
    return {
      error: `The business date ${day} has not started yet. Run night audit once it has.`,
    };
  }

  const { data: existing } = await supabase
    .from("night_audits")
    .select("status, started_at")
    .eq("property_id", property.id)
    .eq("business_date", day)
    .maybeSingle();
  if (existing?.status === "completed") {
    return { error: `${day} has already been closed.` };
  }
  // Two people pressing Run at once would both post. Every step is idempotent,
  // so this is about a clean report, not money; a run that died part-way is
  // still "running" and can be taken over after a few minutes.
  if (
    existing?.status === "running" &&
    Date.now() - Date.parse(existing.started_at) < RUNNING_LEASE_MS
  ) {
    return {
      error:
        "Night audit is already running for this day. Wait a minute and refresh.",
    };
  }

  const { error: startError } = await supabase.from("night_audits").upsert(
    {
      property_id: property.id,
      business_date: day,
      status: "running",
      started_by: staffId,
      started_at: new Date().toISOString(),
      error: "",
    },
    { onConflict: "property_id,business_date" },
  );
  if (startError) return { error: friendlyDbError(startError.message) };

  const fail = async (message: string) => {
    await supabase
      .from("night_audits")
      .update({ status: "failed", error: message })
      .eq("property_id", property.id)
      .eq("business_date", day);
    return {
      error: `Night audit stopped: ${friendlyDbError(message)} Fix the problem and run it again.`,
    };
  };

  // Stays that need a GST invoice someone else must issue (the night auditor
  // role cannot issue invoices), listed on the report.
  const invoicing =
    can(session, "folio.invoice") && !propertyInvoiceProblem(settings);
  const toInvoice: { reference: string; guest: string; reason: string }[] = [];
  const invoiceStay = async (
    b: {
      id: string;
      reference: string;
      contact_name: string;
      guest_id: string | null;
    },
    why: string,
  ) => {
    if (!invoicing) {
      toInvoice.push({
        reference: b.reference,
        guest: b.contact_name,
        reason: why,
      });
      return;
    }
    const billTo = await lastBillTo(supabase, b);
    const r = await issueOutstandingInvoices(
      supabase,
      settings,
      b.id,
      billTo,
      staffId,
    );
    if (r.error)
      toInvoice.push({
        reference: b.reference,
        guest: b.contact_name,
        reason: `${why}: ${r.error}`,
      });
  };

  // ── 0. Stays due out tonight but still in house ──
  const { data: dueOutData } = await supabase
    .from("bookings")
    .select(
      "id, reference, contact_name, guest_id, check_in, check_out, quoted_rate, rate_breakdown, rooms_count, stay_type, total_amount, rooms(room_number)",
    )
    .eq("status", "checked_in")
    .lte("check_out", day);
  type DueOut = Pick<
    Booking,
    | "id"
    | "reference"
    | "contact_name"
    | "guest_id"
    | "check_in"
    | "check_out"
    | "quoted_rate"
    | "rate_breakdown"
    | "rooms_count"
    | "stay_type"
    | "total_amount"
  > & {
    rooms: { room_number: string } | null;
  };
  const handovers: { reference: string; next: string }[] = [];
  const overstays: {
    reference: string;
    guest: string;
    room: string;
    due_out: string;
    extended_to: string | null;
  }[] = [];
  // Overstays whose stay could not be extended (the room is booked to someone
  // else from tonight): the guest is still in it, so tonight is charged anyway.
  const stuck: DueOut[] = [];
  for (const b of (dueOutData ?? []) as unknown as DueOut[]) {
    // A stay split by date hands its room to its second part (0040): this
    // part checks out, and the database checks the next one in.
    const { data: next } = await supabase
      .from("bookings")
      .select("reference, check_in")
      .eq("split_from_id", b.id)
      .in("status", ["tentative", "confirmed"])
      .lte("check_in", b.check_out)
      .limit(1)
      .maybeSingle();
    if (next) {
      const { error } = await supabase
        .from("bookings")
        .update({
          status: "checked_out",
          checked_out_at: new Date().toISOString(),
          checked_out_by: staffId,
        })
        .eq("id", b.id)
        .eq("status", "checked_in");
      if (error)
        return fail(
          `Split stay ${b.reference} could not hand over to ${next.reference}: ${error.message}`,
        );
      handovers.push({ reference: b.reference, next: next.reference });
      await invoiceStay(b, "split stay handed over");
      continue;
    }

    // An overstay: the guest is still here tonight, so tonight is charged and
    // the room stays theirs. The stay runs on at the last night's rate.
    const ext = overstayExtension(b, day);
    let extendedTo: string | null = null;
    if (ext) {
      // The nights added are added to the booking's total too (0041).
      const added = ext.rate_breakdown
        .slice((b.rate_breakdown ?? []).length)
        .reduce((s, n) => s + Number(n.rate), 0);
      const total =
        Math.round((Number(b.total_amount) + added * b.rooms_count) * 100) /
        100;
      const { error } = await supabase
        .from("bookings")
        .update({ ...ext, total_amount: total })
        .eq("id", b.id)
        .eq("status", "checked_in");
      if (!error) extendedTo = ext.check_out;
      else stuck.push({ ...b, rate_breakdown: ext.rate_breakdown });
    }
    overstays.push({
      reference: b.reference,
      guest: b.contact_name,
      room: b.rooms?.room_number ?? "",
      due_out: b.check_out,
      extended_to: extendedTo,
    });
  }

  // ── 1. Room charges ──
  const { data: inHouseData, error: inHouseError } = await supabase
    .from("bookings")
    .select(
      "id, reference, check_in, check_out, rooms_count, rate_breakdown, quoted_rate, stay_type, contact_name, rooms(room_number)",
    )
    .eq("status", "checked_in")
    .lte("check_in", day)
    .gt("check_out", day);
  if (inHouseError) return fail(inHouseError.message);

  const inHouse = (inHouseData ?? []) as unknown as (Booking & {
    rooms: { room_number: string } | null;
  })[];
  const charges = await postRoomCharges(
    supabase,
    [...inHouse, ...(stuck as unknown as Booking[])],
    () => [day],
    settings,
    staffId,
    day,
  );
  if (charges.error) return fail(charges.error);

  // ── 2. No-shows ──
  const { data: dueData } = await supabase
    .from("bookings")
    .select(
      "id, reference, contact_name, guest_id, rooms_count, check_in, quoted_rate, rate_breakdown, rate_plans(*)",
    )
    .in("status", ["tentative", "confirmed"])
    .lte("check_in", day);
  const due = (dueData ?? []) as unknown as (Booking & {
    rate_plans: RatePlan | null;
  })[];

  const noShows: { reference: string; guest: string; penalty: number }[] = [];
  if (bool(fd, "mark_no_shows") && can(session, "bookings.cancel")) {
    for (const b of due) {
      const penalty = noShowPenalty(
        b.rate_plans,
        b.rate_breakdown ?? [],
        b.rooms_count,
      );
      // The penalty goes first, then the status (0043): a penalty that failed
      // after the booking was closed was lost, since a rerun no longer finds
      // the booking. A rerun after a failed status change finds this night's
      // penalty already there and does not post it twice.
      let penaltyId: string | null = null;
      if (penalty.amount > 0) {
        const { data: posted } = await supabase
          .from("folio_entries")
          .select("id")
          .eq("booking_id", b.id)
          .eq("kind", "penalty")
          .eq("night_audit_date", day)
          .is("voided_at", null)
          .limit(1)
          .maybeSingle();
        if (!posted) {
          const { data: entry, error: penaltyError } = await supabase
            .from("folio_entries")
            .insert({
              booking_id: b.id,
              kind: "penalty",
              description: penalty.explanation,
              ...ancillaryCharge(penalty.amount, b, settings),
              night_audit_date: day,
              created_by: staffId,
            })
            .select("id")
            .single();
          if (penaltyError)
            return fail(
              `No-show penalty for ${b.reference} was not posted: ${penaltyError.message}`,
            );
          penaltyId = entry.id as string;
        }
      }
      const { data: closed, error } = await supabase
        .from("bookings")
        .update({
          status: "no_show",
          cancelled_at: new Date().toISOString(),
          cancelled_by: staffId,
          cancellation_reason: `No-show at night audit for ${day}`,
          penalty_amount: penalty.amount,
          hold_until: null,
        })
        .eq("id", b.id)
        .in("status", ["tentative", "confirmed"])
        .select("id");
      if (error || !closed || closed.length === 0) {
        // Not closed (the guest arrived meanwhile, or the update failed): the
        // penalty just posted comes off again.
        if (penaltyId) {
          await supabase
            .from("folio_entries")
            .update({
              voided_at: new Date().toISOString(),
              voided_by: staffId,
              void_reason: "No-show not recorded",
            })
            .eq("id", penaltyId);
        }
        if (error) return fail(error.message);
        continue;
      }
      if (penalty.amount > 0) {
        // The penalty is a taxable supply: it goes on a GST invoice like a stay.
        await invoiceStay(b, "no-show penalty");
      }
      noShows.push({
        reference: b.reference,
        guest: b.contact_name,
        penalty: penalty.amount,
      });
    }
  }

  // ── 3a. Event rooms at their cut-off (0042) ──
  // Rooms an event is holding that nobody has taken go back on sale.
  const { data: dueBlocks } = await supabase
    .from("booking_groups")
    .select("event_id, event_bookings(number, title, status)")
    .not("event_id", "is", null)
    .lte("release_on", day);
  const eventRoomsReleased: { event: string; rooms: number }[] = [];
  for (const g of dueBlocks ?? []) {
    const ev = g.event_bookings as unknown as {
      number: string;
      title: string;
      status: string;
    } | null;
    if (!ev || ev.status === "cancelled" || ev.status === "completed") continue;
    const { data: released, error } = await supabase.rpc(
      "event_release_unsold_rooms",
      { p_event: g.event_id },
    );
    if (error)
      return fail(
        `Unsold rooms for ${ev.number} were not released: ${error.message}`,
      );
    if (Number(released) > 0)
      eventRoomsReleased.push({
        event: `${ev.number} ${ev.title}`,
        rooms: Number(released),
      });
  }

  // ── 3. Expired holds ──
  const { data: expired } = await supabase
    .from("bookings")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: staffId,
      cancellation_reason: "Tentative hold expired",
      hold_until: null,
    })
    .eq("status", "tentative")
    .lt("hold_until", new Date().toISOString())
    .gt("check_in", day)
    .select("reference, contact_name");

  // ── 4. Close the day's folio entries ──
  const { error: closeError } = await supabase.rpc("close_folio_day", {
    p_date: day,
  });
  if (closeError) return fail(closeError.message);

  const { data: dayEntries } = await supabase
    .from("folio_entries")
    .select(
      "kind, amount, tax_amount, method, created_by, voided_at, staff:created_by(full_name, email)",
    )
    .eq("night_audit_date", day)
    .is("voided_at", null);

  type DayEntry = Pick<
    FolioEntry,
    "kind" | "amount" | "tax_amount" | "method"
  > & {
    created_by: string | null;
    staff: { full_name: string; email: string } | null;
  };
  const entries = (dayEntries ?? []) as unknown as DayEntry[];

  // The day's revenue on the one definition every report uses (0044): before
  // tax, outlet bills paid at the outlet and own-bill events in, allowances and
  // credit notes off, paid-outs and tips out.
  const { data: revenueData, error: revenueError } = await supabase.rpc(
    "night_audit_revenue",
    { p_day: day },
  );
  if (revenueError) return fail(revenueError.message);
  const revenue = revenueData as {
    room: number;
    other: number;
    net: number;
    tax: number;
    total: number;
    by_dept: Record<string, number>;
  };

  // Rooms available tonight, from tonight's out-of-order blocks (0044). Read
  // before step 5 moves room statuses on to tomorrow's blocks.
  const { data: sellableData, error: sellableError } = await supabase.rpc(
    "sellable_rooms",
    { p_day: day },
  );
  if (sellableError) return fail(sellableError.message);

  const byMethod: Record<string, number> = {};
  const byCashier: Record<string, number> = {};
  for (const e of entries) {
    if (e.kind !== "payment" && e.kind !== "refund") continue;
    const signed = e.kind === "refund" ? -Number(e.amount) : Number(e.amount);
    const method = e.method ?? "other";
    byMethod[method] =
      Math.round(((byMethod[method] ?? 0) + signed) * 100) / 100;
    const who = e.staff?.full_name || e.staff?.email || "System";
    byCashier[who] = Math.round(((byCashier[who] ?? 0) + signed) * 100) / 100;
  }

  // ── 5. Room blocks → room availability for tomorrow ──
  const [{ data: rooms }, { data: blocks }] = await Promise.all([
    supabase.from("rooms").select("id, status, room_number"),
    supabase
      .from("room_blocks")
      .select("room_id, kind, start_date, end_date")
      .is("released_at", null)
      .lte("start_date", nextDay),
  ]);
  const activeBlock = new Map(
    (blocks ?? [])
      .filter((b) => b.end_date === null || b.end_date >= nextDay)
      .map((b) => [b.room_id as string, b.kind as string]),
  );
  let blocksApplied = 0;
  // Rooms whose status could not be synced are named in the report (0043);
  // they used to be skipped without a word.
  const roomStatusFailed: string[] = [];
  for (const room of rooms ?? []) {
    if (room.status === "occupied") continue;
    const kind = activeBlock.get(room.id);
    const target = kind ?? "available";
    if (room.status !== target) {
      const { error } = await supabase
        .from("rooms")
        .update({ status: target })
        .eq("id", room.id);
      if (!error) blocksApplied += 1;
      else roomStatusFailed.push(String(room.room_number));
    }
  }

  // ── 5b. Tomorrow's housekeeping list: due deep cleans ──
  const { data: hkCreated } = await supabase.rpc("hk_generate_tasks", {
    p_date: nextDay,
  });

  // ── 5c. Preventive maintenance due tomorrow; tickets past their target ──
  const { data: mtCreated } = await supabase.rpc("mt_generate_preventive", {
    p_date: nextDay,
  });
  const mtEscalated = await escalateOverdueTickets(supabase, staffId);

  // ── 6. Identity document retention ──
  let purged = 0;
  if (can(session, "guests.view_id")) {
    const cutoff = new Date(
      Date.now() - settings.id_document_retention_days * 86400000,
    ).toISOString();
    const { data: old } = await supabase
      .from("guest_documents")
      .select("id, storage_path")
      .lt("uploaded_at", cutoff)
      .limit(500);
    if (old?.length) {
      const { error } = await supabase.storage
        .from("guest-documents")
        .remove(old.map((d) => d.storage_path));
      if (!error) {
        await supabase
          .from("guest_documents")
          .delete()
          .in(
            "id",
            old.map((d) => d.id),
          );
        purged = old.length;
      }
    }
  }

  // ── 6b. Loyalty: retire expired points, re-check every member's tier ──
  //
  // Both are idempotent. Expiry only touches lots whose date has already
  // passed, and a tier review that finds nothing to change writes nothing,
  // so re-running a failed audit cannot double-count either.
  let pointsExpired = 0;
  let tiersReviewed = 0;
  if (settings.loyalty_enabled) {
    const { data: expiredPoints } = await supabase.rpc(
      "loyalty_expire_points",
      { p_date: day },
    );
    pointsExpired = Number(expiredPoints ?? 0);
    const { data: reviewed } = await supabase.rpc("loyalty_evaluate_all", {
      p_date: day,
    });
    tiersReviewed = Number(reviewed ?? 0);
  }

  // ── 6c. Outlet takings ──
  //
  // What the outlets took in themselves. A bill charged to a room is already
  // in the folio figures, so it is left out here (it used to be counted
  // twice, 0044); tips are the staff's and are shown on their own.
  const { data: posRows } = await supabase
    .from("pos_orders")
    .select(
      "id, grand_total, tip_amount, pos_outlets(name), pos_payments(kind, amount, voided_at)",
    )
    .eq("status", "settled")
    .gte("closed_at", zonedTime(day, "00:00", settings.timezone).toISOString())
    .lt(
      "closed_at",
      zonedTime(nextDay, "00:00", settings.timezone).toISOString(),
    );

  const outletTakings: Record<string, number> = {};
  const outletByMethod: Record<string, number> = {};
  let posTotal = 0;
  let posTips = 0;
  let posBills = 0;
  for (const row of posRows ?? []) {
    const order = row as unknown as {
      grand_total: number;
      tip_amount: number;
      pos_outlets: { name: string } | null;
      pos_payments: {
        kind: string;
        amount: number;
        voided_at: string | null;
      }[];
    };
    if (
      (order.pos_payments ?? []).some(
        (p) => p.kind === "room_charge" && !p.voided_at,
      )
    )
      continue;
    posBills += 1;
    const name = order.pos_outlets?.name ?? "Outlet";
    const takings = Number(order.grand_total) - Number(order.tip_amount ?? 0);
    outletTakings[name] =
      Math.round(((outletTakings[name] ?? 0) + takings) * 100) / 100;
    posTotal += takings;
    posTips += Number(order.tip_amount ?? 0);
    for (const p of order.pos_payments ?? []) {
      if (p.voided_at) continue;
      outletByMethod[p.kind] =
        Math.round(((outletByMethod[p.kind] ?? 0) + Number(p.amount)) * 100) /
        100;
    }
  }

  // ── 7. Daily revenue report ──
  // Arrived and departed on the day, as the flash report counts them: a guest
  // who came and left the same day is both (0044).
  const [{ count: arrivals }, { count: departures }, { count: cancellations }] =
    await Promise.all([
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("check_in", day)
        .in("status", ["checked_in", "checked_out"]),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("check_out", day)
        .eq("status", "checked_out"),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("status", "cancelled")
        .gte(
          "cancelled_at",
          zonedTime(day, "00:00", settings.timezone).toISOString(),
        )
        .lt(
          "cancelled_at",
          zonedTime(nextDay, "00:00", settings.timezone).toISOString(),
        ),
    ]);

  // Complimentary and house-use rooms are occupied but not sold (USALI), so
  // they stay out of occupancy, ADR and RevPAR and are reported on their own.
  const roomsSold = inHouse
    .filter((b) => (b.stay_type ?? "paid") === "paid")
    .reduce((s, b) => s + b.rooms_count, 0);
  const roomsComp = inHouse
    .filter((b) => (b.stay_type ?? "paid") !== "paid")
    .reduce((s, b) => s + b.rooms_count, 0);
  const roomRevenue = Number(revenue.room);
  const available = Number(sellableData ?? 0);

  const report = {
    business_date: day,
    rooms: {
      available,
      sold: roomsSold,
      complimentary: roomsComp,
      occupancy_percent: available
        ? Math.round((roomsSold / available) * 1000) / 10
        : 0,
    },
    // Before tax except `total`; `net` marks the 0044 definition, which the
    // daily report then uses exactly as frozen here.
    revenue: {
      room: roomRevenue,
      other: Number(revenue.other),
      net: Number(revenue.net),
      tax: Number(revenue.tax),
      total: Number(revenue.total),
      by_dept: revenue.by_dept,
    },
    kpis: {
      adr: roomsSold ? Math.round((roomRevenue / roomsSold) * 100) / 100 : 0,
      revpar: available ? Math.round((roomRevenue / available) * 100) / 100 : 0,
    },
    payments: {
      by_method: byMethod,
      by_cashier: byCashier,
      total: Object.values(byMethod).reduce((s, v) => s + v, 0),
    },
    movements: {
      arrivals: arrivals ?? 0,
      departures: departures ?? 0,
      cancellations: cancellations ?? 0,
      no_shows: noShows,
      expired_holds: (expired ?? []).map((b) => ({
        reference: b.reference,
        guest: b.contact_name,
      })),
      event_rooms_released: eventRoomsReleased,
      pending_arrivals_left: bool(fd, "mark_no_shows")
        ? []
        : due.map((b) => ({ reference: b.reference, guest: b.contact_name })),
    },
    exceptions: {
      overstays,
      handovers,
      to_invoice: toInvoice,
    },
    housekeeping: {
      room_statuses_updated: blocksApplied,
      room_statuses_failed: roomStatusFailed,
      tasks_created: (hkCreated as number | null) ?? 0,
    },
    maintenance: {
      preventive_created: (mtCreated as number | null) ?? 0,
      escalated: mtEscalated,
    },
    compliance: { id_documents_purged: purged },
    loyalty: { points_expired: pointsExpired, tiers_reviewed: tiersReviewed },
    outlets: {
      bills: posBills,
      total: Math.round(posTotal * 100) / 100,
      tips: Math.round(posTips * 100) / 100,
      by_outlet: outletTakings,
      by_method: outletByMethod,
    },
    posted_room_charges: charges.posted,
  };

  const { error: doneError } = await supabase
    .from("night_audits")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      report,
      error: "",
    })
    .eq("property_id", property.id)
    .eq("business_date", day);
  if (doneError) return fail(doneError.message);

  const { error: rollError } = await supabase.rpc("advance_business_date", {
    p_closed: day,
  });
  if (rollError) return fail(rollError.message);

  revalidatePath("/night-audit");
  revalidatePath("/front-desk");
  revalidatePath("/");
  redirect(`/night-audit/${day}`);
}
