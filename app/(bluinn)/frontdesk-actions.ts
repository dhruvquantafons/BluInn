"use server";


import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "../lib/supabase/server";
import { requirePermission, requireSession, type Session } from "../lib/auth";
import { can } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import { friendlyDbError } from "../lib/db-errors";
import { timingFee, isEarly, isLate } from "../lib/policies";
import { rateForNight } from "../lib/pricing";
import { postRoomCharges, nightsBefore, loadFolio, billLines, ancillaryCharge, insertFolioEntries } from "../lib/folio";
import { foliosToInvoice } from "../lib/invoices";
import { issueFolioInvoice } from "../lib/invoice-issue";
import { addDays, eachNight, nowTimeIn, todayIn, zonedTime } from "../lib/dates";
import { sendKeyCardCommand } from "../lib/integrations";
import { sendBookingMessage, describeSend } from "../lib/notifications";
import type { Booking, PaymentMethod } from "../lib/types";
import {
  type ActionState,
  str,
  num,
  int,
  bool,
  oneOf,
  oneOfOrNull,
  dateStr,
  uuidOrNull,
} from "./form-utils";

const PAYMENT_METHODS: PaymentMethod[] = [
  "cash", "card", "upi", "bank_transfer", "online_gateway", "ota_prepaid", "wallet", "other",
];
const ID_TYPES = ["passport", "aadhaar", "driving_licence", "voter_id", "pan", "other"] as const;
const DOC_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** A drawn signature is a small PNG; anything much larger is not one. */
const MAX_SIGNATURE_BYTES = 400 * 1024;

type FrontDeskBooking = Booking & {
  rooms: { id: string; room_number: string } | null;
  rate_plans: { name: string; meal_plan: string } | null;
};

function revalidateDesk(id: string) {
  revalidatePath(`/bookings/${id}`);
  revalidatePath("/front-desk");
  revalidatePath("/bookings");
  revalidatePath("/rooms");
  revalidatePath("/tape-chart");
  revalidatePath("/");
}

async function loadBooking(supabase: SupabaseClient, id: string | null) {
  if (!id) return null;
  const { data } = await supabase
    .from("bookings")
    .select("*, rooms(id, room_number), room_types(id, name), rate_plans(name, meal_plan)")
    .eq("id", id)
    .maybeSingle();
  return (data as FrontDeskBooking | null) ?? null;
}

async function uploadPrivate(
  supabase: SupabaseClient,
  path: string,
  body: Blob | Buffer,
  contentType: string,
) {
  const { error } = await supabase.storage
    .from("guest-documents")
    .upload(path, body, { contentType, upsert: false });
  return error?.message ?? null;
}

async function issueKeys(
  supabase: SupabaseClient,
  session: Session,
  booking: FrontDeskBooking,
  roomNumber: string,
  roomId: string,
  cards: number,
  action: "issue" | "revoke",
) {
  const result = await sendKeyCardCommand({
    action,
    reference: booking.reference,
    roomNumber,
    guestName: booking.contact_name,
    validFrom: booking.check_in,
    validUntil: booking.check_out,
    cards,
  });
  await supabase.from("key_card_events").insert({
    booking_id: booking.id,
    room_id: roomId,
    action,
    cards,
    provider: result.provider,
    status: result.status,
    response: result.error,
    created_by: session.staff.id,
  });
  return result;
}

// ── Check-in ───────────────────────────────────────────────────────────────

/**
 * Module 2 check-in requirements: government ID captured, guest
 * signature, deposit or payment confirmed, room assigned. The room must be
 * vacant and inspected.
 */
export async function checkIn(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.checkin");
  const supabase = await createClient();
  const settings = await getSettings();
  const booking = await loadBooking(supabase, uuidOrNull(fd, "booking_id"));

  if (!booking) return { error: "Booking not found." };
  if (!["tentative", "confirmed"].includes(booking.status)) {
    return { error: `This booking is ${booking.status.replace("_", " ")} and cannot be checked in.` };
  }

  const today = todayIn(settings.timezone);
  if (booking.check_in > today) {
    return { error: `The booking starts on ${booking.check_in}. Amend the arrival date first to check in early.` };
  }
  if (booking.check_out <= today) return { error: "This stay has already ended." };
  if (booking.rooms_count > 1) {
    return { error: "Split this booking into one booking per room before checking in." };
  }

  // ── Room ──
  const roomId = uuidOrNull(fd, "room_id");
  if (!roomId) return { error: "Assign a room." };
  const { data: room } = await supabase
    .from("rooms")
    .select("id, room_number, status, housekeeping_status, room_type_id")
    .eq("id", roomId)
    .single();
  if (!room) return { error: "Room not found." };
  if (room.status !== "available") return { error: `Room ${room.room_number} is not vacant.` };
  // Only inspected rooms, unless someone who may override says why (0032).
  const overrideReason = str(fd, "override_reason", 300);
  const overridden = room.housekeeping_status !== "inspected";
  if (overridden && !(can(session, "frontdesk.checkin_override") && overrideReason)) {
    return { error: `Room ${room.room_number} has not been inspected (it is ${room.housekeeping_status}).` };
  }

  // ── Identity ──
  const idType = oneOfOrNull(fd, "id_type", ID_TYPES);
  const idNumber = str(fd, "id_number", 50);
  const nationality = str(fd, "nationality", 80) || "Indian";
  if (!idType || !idNumber) return { error: "Record the guest's government ID." };
  const foreign = !/^indian?$/i.test(nationality);
  if (foreign && idType !== "passport") {
    return { error: "Foreign nationals must present a passport." };
  }

  // ── Registration card ──
  if (!bool(fd, "terms_accepted")) return { error: "The guest must accept the house terms." };
  const signature = str(fd, "signature", 600_000);
  const sigMatch = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(signature);
  if (!sigMatch) return { error: "Capture the guest's signature." };
  const sigBytes = Buffer.from(sigMatch[1], "base64");
  if (sigBytes.length > MAX_SIGNATURE_BYTES) return { error: "That signature image is too large." };

  const docs: { kind: string; file: File }[] = [];
  for (const kind of ["id_front", "id_back", "visa"] as const) {
    const file = fd.get(kind);
    if (file instanceof File && file.size > 0) {
      if (!DOC_TYPES.includes(file.type)) return { error: "ID scans must be JPEG, PNG, WebP or PDF." };
      if (file.size > MAX_DOC_BYTES) return { error: "Each ID scan must be under 5 MB." };
      docs.push({ kind, file });
    }
  }
  if (foreign && !docs.some((d) => d.kind === "visa")) {
    return { error: "Upload the visa page for a foreign national." };
  }

  // ── Personal details for the registration card ──
  const gender = oneOf(fd, "gender", ["", "female", "male", "other"] as const, "");
  const dob = dateStr(fd, "date_of_birth") || null;

  // ── Payment confirmation ──
  const payNow = num(fd, "payment_amount");
  const payMethod = oneOfOrNull(fd, "payment_method", PAYMENT_METHODS);
  if (payNow && payNow > 0 && !payMethod) return { error: "Choose how the payment was made." };
  if (payNow && payNow > 0 && !can(session, "folio.payment")) {
    return { error: "Your role cannot take payments." };
  }

  const { totals } = await loadFolio(supabase, booking.id);
  const guaranteed = booking.payment_method === "ota_prepaid" || bool(fd, "guarantee_confirmed");
  const paidAfter = totals.payments + (payNow ?? 0);
  if (!guaranteed && paidAfter < Number(booking.deposit_required)) {
    return {
      error: `Collect the deposit of ₹${Number(booking.deposit_required).toLocaleString("en-IN")} (₹${paidAfter.toLocaleString("en-IN")} received), or confirm a card guarantee.`,
    };
  }

  // ── Guest record ──
  let guestId = booking.guest_id;
  if (!guestId) {
    const { data: g, error } = await supabase
      .from("guests")
      .insert({
        full_name: booking.contact_name,
        email: booking.contact_email || null,
        phone: booking.contact_phone || null,
      })
      .select("id")
      .single();
    if (error) return { error: friendlyDbError(error.message) };
    guestId = g.id as string;
    await supabase.from("bookings").update({ guest_id: guestId }).eq("id", booking.id);
  }

  await supabase
    .from("guests")
    .update({
      nationality,
      address: str(fd, "address", 500),
      ...(gender ? { gender } : {}),
      ...(dob ? { date_of_birth: dob } : {}),
    })
    .eq("id", guestId);

  const { error: idError } = await supabase.rpc("set_guest_identity", {
    p_guest: guestId,
    p_type: idType,
    p_number: idNumber,
    p_country: str(fd, "issuing_country", 80) || (foreign ? "" : "India"),
    p_expiry: dateStr(fd, "id_expiry") || null,
    p_visa: str(fd, "visa_number", 50),
  });
  if (idError) return { error: friendlyDbError(idError.message) };

  // ── Uploads: private bucket, paths not guessable from outside ──
  const stamp = Date.now();
  const sigPath = `${guestId}/${booking.id}/signature-${stamp}.png`;
  const sigError = await uploadPrivate(supabase, sigPath, sigBytes, "image/png");
  if (sigError) return { error: `Could not store the signature: ${sigError}` };

  const docRows: Record<string, unknown>[] = [
    { guest_id: guestId, booking_id: booking.id, kind: "signature", storage_path: sigPath, uploaded_by: session.staff.id },
  ];
  for (const { kind, file } of docs) {
    const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
    const path = `${guestId}/${booking.id}/${kind}-${stamp}.${ext}`;
    const err = await uploadPrivate(supabase, path, file, file.type);
    if (err) return { error: `Could not store the ID scan: ${err}` };
    docRows.push({ guest_id: guestId, booking_id: booking.id, kind, storage_path: path, uploaded_by: session.staff.id });
  }
  await supabase.from("guest_documents").insert(docRows);

  const { error: cardError } = await supabase.from("registration_cards").upsert(
    {
      booking_id: booking.id,
      guest_name: str(fd, "guest_name", 200) || booking.contact_name,
      address: str(fd, "address", 500),
      nationality,
      phone: booking.contact_phone,
      email: booking.contact_email,
      arriving_from: str(fd, "arriving_from", 200),
      next_destination: str(fd, "next_destination", 200),
      purpose_of_visit: str(fd, "purpose_of_visit", 200),
      terms_accepted: true,
      signature_path: sigPath,
      signed_at: new Date().toISOString(),
      created_by: session.staff.id,
    },
    { onConflict: "booking_id" },
  );
  if (cardError) return { error: friendlyDbError(cardError.message) };

  // ── Money ──
  // The payment and any early check-in fee are written together, and before
  // the stay begins: the deposit check above has already counted the payment,
  // so a payment the folio refuses (no open cash shift, say) must stop the
  // check-in rather than leave the guest in house with nothing received.
  const moneyRows: Record<string, unknown>[] = [];
  if (payNow && payNow > 0 && payMethod) {
    moneyRows.push({
      booking_id: booking.id,
      kind: "payment",
      description: "Payment at check-in",
      amount: payNow,
      method: payMethod,
      reference: str(fd, "payment_reference", 100),
      is_deposit: true,
      created_by: session.staff.id,
    });
  }

  const nowLocal = nowTimeIn(settings.timezone);
  const early = booking.check_in === today && isEarly(nowLocal, settings.check_in_time);
  const earlyFee = early
    ? timingFee(
        settings.early_checkin_fee_type,
        Number(settings.early_checkin_fee_value),
        rateForNight(booking.rate_breakdown, booking.check_in, booking.quoted_rate),
      )
    : 0;
  const applyEarly = early && earlyFee > 0 && bool(fd, "apply_early_fee");
  if (applyEarly) {
    moneyRows.push({
      booking_id: booking.id,
      kind: "fee",
      description: `Early check-in at ${nowLocal}`,
      ...ancillaryCharge(earlyFee, booking, settings),
      stay_date: today,
      created_by: session.staff.id,
    });
  }
  if (moneyRows.length > 0) {
    const moneyError = await insertFolioEntries(supabase, moneyRows);
    if (moneyError) return { error: `Not checked in: ${moneyError}` };
  }

  // ── The stay begins ── (the trigger marks the room occupied)
  const { error } = await supabase
    .from("bookings")
    .update({
      status: "checked_in",
      room_id: room.id,
      guest_id: guestId,
      hold_until: null,
      checked_in_at: new Date().toISOString(),
      checked_in_by: session.staff.id,
    })
    .eq("id", booking.id);
  if (error) return { error: friendlyDbError(error.message) };

  if (overridden) {
    await supabase.rpc("log_event", {
      p_module: "frontdesk",
      p_action: "checkin_override",
      p_record_id: booking.id,
      p_summary: `Checked into room ${room.room_number} before inspection (${room.housekeeping_status}): ${overrideReason}`,
    });
  }

  if (early && earlyFee > 0 && !applyEarly) {
    await supabase.rpc("log_event", {
      p_module: "frontdesk",
      p_action: "fee_waived",
      p_record_id: booking.id,
      p_summary: `Early check-in fee of ₹${earlyFee} waived at ${nowLocal}`,
    });
  }

  const cards = int(fd, "key_cards", 0, 0, 10);
  let keys = "";
  if (cards > 0) {
    const r = await issueKeys(supabase, session, booking, room.room_number, room.id, cards, "issue");
    keys = r.status === "sent" ? ` ${cards} key card(s) sent to the lock system.` : ` Key cards: ${r.error}`;
  }

  revalidateDesk(booking.id);
  redirect(`/bookings/${booking.id}?checkedIn=1${keys ? `&keys=${encodeURIComponent(keys.trim())}` : ""}`);
}

// ── Check-out ──────────────────────────────────────────────────────────────

export async function checkOut(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.checkout");
  const supabase = await createClient();
  const settings = await getSettings();
  const booking = await loadBooking(supabase, uuidOrNull(fd, "booking_id"));
  if (!booking) return { error: "Booking not found." };
  if (booking.status !== "checked_in") return { error: "Only an in-house guest can be checked out." };

  const today = todayIn(settings.timezone);
  const nowLocal = nowTimeIn(settings.timezone);

  // Leaving early: the stay ends today (a same-day departure still pays one night).
  const departure =
    booking.check_out > today ? (today > booking.check_in ? today : addDays(booking.check_in, 1)) : booking.check_out;

  // Charge any night an audit did not.
  const chargeable = { ...booking, check_out: departure };
  const posted = await postRoomCharges(
    supabase,
    [chargeable],
    (b) => nightsBefore(b, departure),
    settings,
    session.staff.id,
  );
  if (posted.error) return { error: friendlyDbError(posted.error) };

  const late = booking.check_out <= today && isLate(nowLocal, settings.check_out_time);
  const lastNight = eachNight(booking.check_in, departure).at(-1) ?? booking.check_in;
  const lateFee = late
    ? timingFee(
        settings.late_checkout_fee_type,
        Number(settings.late_checkout_fee_value),
        rateForNight(booking.rate_breakdown, lastNight, booking.quoted_rate),
      )
    : 0;
  if (late && lateFee > 0 && bool(fd, "apply_late_fee")) {
    const feeError = await insertFolioEntries(supabase, {
      booking_id: booking.id,
      kind: "fee",
      description: `Late check-out at ${nowLocal}`,
      ...ancillaryCharge(lateFee, booking, settings, lastNight),
      stay_date: today,
      created_by: session.staff.id,
    });
    if (feeError) return { error: `Not checked out: the late check-out fee was not posted. ${feeError}` };
  }

  const payNow = num(fd, "payment_amount");
  const payMethod = oneOfOrNull(fd, "payment_method", PAYMENT_METHODS);
  if (payNow && payNow > 0) {
    if (!payMethod) return { error: "Choose how the payment was made." };
    if (!can(session, "folio.payment")) return { error: "Your role cannot take payments." };
    const payError = await insertFolioEntries(supabase, {
      booking_id: booking.id,
      kind: "payment",
      description: "Settlement at check-out",
      amount: payNow,
      method: payMethod,
      reference: str(fd, "payment_reference", 100),
      created_by: session.staff.id,
    });
    if (payError) return { error: `Not checked out: the payment was not recorded. ${payError}` };
  }

  const { entries, totals } = await loadFolio(supabase, booking.id);

  // A balance may only be left by someone who can adjust folios, with a
  // reason on record.
  if (totals.balance > 0.5) {
    const allowed = can(session, "folio.adjust") && str(fd, "balance_reason", 300);
    if (!allowed) {
      return {
        error: `₹${totals.balance.toLocaleString("en-IN")} is still owed. Take payment before checking out.`,
      };
    }
    await supabase.rpc("log_event", {
      p_module: "folio",
      p_action: "checkout_with_balance",
      p_record_id: booking.id,
      p_summary: `Checked out owing ₹${totals.balance}: ${str(fd, "balance_reason", 300)}`,
    });
  }

  // ── The tax invoice ──
  // Every folio holding charges is invoiced as the guest leaves, so the
  // stay's tax reaches the GST register (and the guest's loyalty points are
  // earned). A folio already invoiced is left alone, so a retry after a
  // refusal — say, a business guest's address missing — picks up where it
  // stopped. From here, anything charged later goes to an "After invoice"
  // folio (0039) and is invoiced separately.
  let warn = "";
  const { data: issuedRows } = await supabase
    .from("invoices")
    .select("folio_id")
    .eq("booking_id", booking.id)
    .eq("status", "issued");
  const toInvoice = foliosToInvoice(entries, new Set((issuedRows ?? []).map((r) => r.folio_id as string)));
  if (toInvoice.length > 0) {
    if (can(session, "folio.invoice")) {
      const billTo = {
        name: str(fd, "bill_to_name", 200),
        gstin: str(fd, "bill_to_gstin", 20),
        address: str(fd, "bill_to_address", 500),
      };
      for (const folioId of toInvoice) {
        const issued = await issueFolioInvoice(supabase, settings, folioId, billTo, session.staff.id);
        if ("error" in issued) return { error: `Not checked out: the tax invoice could not be issued. ${issued.error}` };
      }
    } else {
      warn = "No tax invoice was issued: your role cannot issue invoices. Ask someone who can to issue it from the folio.";
    }
  }

  const { error } = await supabase
    .from("bookings")
    .update({
      status: "checked_out",
      check_out: departure,
      rate_breakdown: (booking.rate_breakdown ?? []).filter((n) => n.date < departure),
      checked_out_at: new Date().toISOString(),
      checked_out_by: session.staff.id,
    })
    .eq("id", booking.id);
  if (error) return { error: friendlyDbError(error.message) };

  if (booking.room_id && booking.rooms) {
    await issueKeys(supabase, session, booking, booking.rooms.room_number, booking.room_id, 1, "revoke");
  }

  // Express check-out: the final bill goes to the guest by email.
  let sent = "";
  if (bool(fd, "email_bill")) {
    const summary = await sendBookingMessage(
      supabase,
      "final_bill",
      { ...booking, room_type_name: booking.room_types?.name, rate_plan_name: booking.rate_plans?.name },
      settings,
      {
        staffId: session.staff.id,
        bill: { lines: billLines(entries, settings.tax_label), balance: totals.balance },
        sms: false,
      },
    );
    sent = describeSend(summary);
  }

  revalidateDesk(booking.id);
  redirect(
    `/bookings/${booking.id}?checkedOut=1${sent ? `&sent=${encodeURIComponent(sent)}` : ""}${warn ? `&warn=${encodeURIComponent(warn)}` : ""}`,
  );
}

/** Sends more key cards to the lock system for an in-house guest (lost or extra keys). */
export async function reissueKeys(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.checkin");
  const supabase = await createClient();
  const booking = await loadBooking(supabase, uuidOrNull(fd, "booking_id"));
  if (!booking || booking.status !== "checked_in" || !booking.rooms || !booking.room_id) {
    return { error: "Keys can only be issued for an in-house guest with a room." };
  }
  const cards = int(fd, "cards", 1, 1, 10);
  const r = await issueKeys(supabase, session, booking, booking.rooms.room_number, booking.room_id, cards, "issue");
  revalidatePath(`/bookings/${booking.id}`);
  return r.status === "sent" ? { success: `${cards} key card(s) sent to the lock system.` } : { error: r.error };
}

// ── Guest requests ─────────────────────────────────────────────────────────

export async function createGuestRequest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.requests");
  const supabase = await createClient();
  const settings = await getSettings();
  const description = str(fd, "description", 1000);
  if (!description) return { error: "Describe the request." };

  const bookingId = uuidOrNull(fd, "booking_id");
  let roomId = uuidOrNull(fd, "room_id");
  if (bookingId && !roomId) {
    const { data } = await supabase.from("bookings").select("room_id").eq("id", bookingId).maybeSingle();
    roomId = data?.room_id ?? null;
  }

  // "due" is a local date and time at the hotel.
  const dueDate = dateStr(fd, "due_date");
  const dueTime = str(fd, "due_time", 5);
  let dueAt: string | null = null;
  if (dueDate && /^\d{2}:\d{2}$/.test(dueTime)) {
    dueAt = zonedTime(dueDate, dueTime, settings.timezone).toISOString();
  }

  const kind = oneOf(
    fd,
    "kind",
    ["wake_up_call", "housekeeping", "maintenance", "message", "request", "complaint", "trace"] as const,
    "request",
  );
  // A trace is a follow-up for a department on a date (0031).
  const departmentId = uuidOrNull(fd, "department_id");
  if (kind === "trace" && !dueAt && dueDate) {
    // A trace with a date but no time is for the start of that day's shift.
    dueAt = zonedTime(dueDate, "09:00", settings.timezone).toISOString();
  }
  if (kind === "trace" && !dueAt) return { error: "Give the trace a date for the follow-up." };
  // A maintenance request also becomes a maintenance ticket (0011_maintenance.sql).
  const { error } = await supabase.from("guest_requests").insert({
    booking_id: bookingId,
    room_id: roomId,
    kind,
    description,
    due_at: dueAt,
    department_id: departmentId,
    created_by: session.staff.id,
  });
  if (error) return { error: friendlyDbError(error.message) };

  if (bookingId) revalidatePath(`/bookings/${bookingId}`);
  revalidatePath("/front-desk");
  if (kind === "maintenance") revalidatePath("/maintenance", "layout");
  return { success: kind === "maintenance" ? "Logged and sent to maintenance as a ticket." : "Logged." };
}

export async function updateGuestRequest(fd: FormData) {
  const session = await requirePermission("frontdesk.requests");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const status = oneOf(fd, "status", ["done", "cancelled", "open"] as const, "done");
  if (!id) return;

  const { data } = await supabase
    .from("guest_requests")
    .update({
      status,
      completed_by: status === "open" ? null : session.staff.id,
      completed_at: status === "open" ? null : new Date().toISOString(),
    })
    .eq("id", id)
    .select("booking_id")
    .single();

  if (data?.booking_id) revalidatePath(`/bookings/${data.booking_id}`);
  revalidatePath("/front-desk");
}

/**
 * Marks a trace done from its department's board. Any staff member may: the
 * trace was sent to their department (RLS, 0031), and the audit log keeps who.
 */
export async function completeTrace(fd: FormData) {
  const session = await requireSession();
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  if (!id) return;
  await supabase
    .from("guest_requests")
    .update({ status: "done", completed_by: session.staff.id, completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("kind", "trace");
  revalidatePath("/front-desk");
  revalidatePath("/housekeeping");
  revalidatePath("/maintenance");
}

// ── Everyone in the room (0030) ─────────────────────────────────────────────

/**
 * Adds a sharer to a stay: a guest profile of their own, with their ID, so
 * every adult in the room is on record.
 */
export async function addRoomGuest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.checkin");
  const supabase = await createClient();
  const booking = await loadBooking(supabase, uuidOrNull(fd, "booking_id"));
  if (!booking) return { error: "Booking not found." };
  if (!["tentative", "confirmed", "checked_in"].includes(booking.status)) {
    return { error: "This stay is closed." };
  }

  const name = str(fd, "full_name", 200);
  const nationality = str(fd, "nationality", 80);
  const idType = oneOfOrNull(fd, "id_type", ID_TYPES);
  const idNumber = str(fd, "id_number", 50);
  if (!name) return { error: "Enter the guest's name." };
  if (!nationality) return { error: "Enter the guest's nationality." };
  if (!idType || !idNumber) return { error: "Record the guest's government ID." };
  const foreign = !/^indian?$/i.test(nationality);
  if (foreign && idType !== "passport") return { error: "Foreign nationals must present a passport." };

  const dob = dateStr(fd, "date_of_birth") || null;

  const { data: guest, error: guestError } = await supabase
    .from("guests")
    .insert({
      full_name: name,
      nationality,
      gender: oneOf(fd, "gender", ["", "female", "male", "other"] as const, ""),
      date_of_birth: dob,
    })
    .select("id")
    .single();
  if (guestError) return { error: friendlyDbError(guestError.message) };

  const { error: idError } = await supabase.rpc("set_guest_identity", {
    p_guest: guest.id,
    p_type: idType,
    p_number: idNumber,
    p_country: str(fd, "issuing_country", 80) || (foreign ? "" : "India"),
    p_expiry: dateStr(fd, "id_expiry") || null,
    p_visa: str(fd, "visa_number", 50),
  });
  if (idError) return { error: friendlyDbError(idError.message) };

  const { error } = await supabase
    .from("booking_guests")
    .insert({ booking_id: booking.id, guest_id: guest.id, added_by: session.staff.id });
  if (error) return { error: friendlyDbError(error.message) };

  revalidateDesk(booking.id);
  return { success: `${name} added to the stay.` };
}

export async function removeRoomGuest(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("frontdesk.checkin");
  const supabase = await createClient();
  const bookingId = uuidOrNull(fd, "booking_id");
  const guestId = uuidOrNull(fd, "guest_id");
  if (!bookingId || !guestId) return { error: "Guest not found." };

  const { data: removed, error } = await supabase
    .from("booking_guests")
    .delete()
    .eq("booking_id", bookingId)
    .eq("guest_id", guestId)
    .eq("is_primary", false)
    .select("guest_id");
  if (error) return { error: friendlyDbError(error.message) };
  if (!removed?.length) return { error: "The main guest stays on the booking; change the booker instead." };

  revalidateDesk(bookingId);
  return { success: "Guest removed from the stay. Their profile and ID record are kept." };
}
