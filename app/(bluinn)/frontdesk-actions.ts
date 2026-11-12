"use server";


import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "../lib/supabase/server";
import { requirePermission, requireSession, type Session } from "../lib/auth";
import { can } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import { friendlyDbError } from "../lib/db-errors";
import { timingFee, isEarly, isLate, depositReceived } from "../lib/policies";
import { rateForNight } from "../lib/pricing";
import { postRoomCharges, nightsBefore, loadFolio, loadGuestFolio, billLines, ancillaryCharge, insertFolioEntries } from "../lib/folio";
import { foliosToInvoice, invoiceLines, invoiceTotals } from "../lib/invoices";
import { billToProblem, issueOutstandingInvoices } from "../lib/invoice-issue";
import { invoiceEvent } from "../lib/event-invoice";
import {
  checkoutDeparture,
  earlyFeePosted,
  EARLY_FEE_PREFIX,
  lateFeePosted,
  LATE_FEE_PREFIX,
  propertyInvoiceProblem,
} from "../lib/checkout";
import { eachNight, nowTimeIn, todayIn, zonedTime } from "../lib/dates";
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

  const { entries: folioEntries } = await loadFolio(supabase, booking.id);
  const guaranteed = booking.payment_method === "ota_prepaid" || bool(fd, "guarantee_confirmed");
  // Money actually received: payments less refunds. An allowance is not a
  // deposit (0043).
  const paidAfter = depositReceived(folioEntries) + (payNow ?? 0);
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
    const { error: linkError } = await supabase.from("bookings").update({ guest_id: guestId }).eq("id", booking.id);
    if (linkError) return { error: `Not checked in: ${friendlyDbError(linkError.message)}` };
  }

  const { error: guestError } = await supabase
    .from("guests")
    .update({
      nationality,
      address: str(fd, "address", 500),
      ...(gender ? { gender } : {}),
      ...(dob ? { date_of_birth: dob } : {}),
    })
    .eq("id", guestId);
  if (guestError) return { error: `Not checked in: the guest's details were not saved. ${friendlyDbError(guestError.message)}` };

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
  const { error: docError } = await supabase.from("guest_documents").insert(docRows);
  if (docError) return { error: `Not checked in: the signature and ID scans were not recorded. ${friendlyDbError(docError.message)}` };

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
  // A retried check-in finds the fee already there and does not charge it twice.
  if (applyEarly && !earlyFeePosted(folioEntries, today)) {
    moneyRows.push({
      booking_id: booking.id,
      kind: "fee",
      description: `${EARLY_FEE_PREFIX} at ${nowLocal}`,
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
  if (error) {
    // The payment is on the folio already and counts towards the deposit on
    // a retry; the fee is not charged twice. Only a payment typed in again would be.
    const paid =
      payNow && payNow > 0 && payMethod
        ? ` The payment of ₹${payNow.toLocaleString("en-IN")} is recorded: clear it from the form before trying again.`
        : "";
    return { error: `Not checked in: ${friendlyDbError(error.message)}${paid}` };
  }

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

/** How long a desk's claim on a check-out lasts if it never releases it (a crash, say). */
const CHECKOUT_CLAIM_MS = 2 * 60 * 1000;

/**
 * Check-out, one desk at a time (0043). Two desks checking the same guest out
 * at once both took the settlement and both posted the late fee. The first
 * desk now claims the booking with a conditional update; a second gets
 * "already being checked out". The claim is released however the check-out
 * ends, and lapses on its own after two minutes.
 */
export async function checkOut(prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("frontdesk.checkout");
  const supabase = await createClient();
  const bookingId = uuidOrNull(fd, "booking_id");
  if (!bookingId) return { error: "Booking not found." };

  const stale = new Date(Date.now() - CHECKOUT_CLAIM_MS).toISOString();
  const { data: claimed } = await supabase
    .from("bookings")
    .update({ checkout_started_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("status", "checked_in")
    .or(`checkout_started_at.is.null,checkout_started_at.lt.${stale}`)
    .select("id");
  if (!claimed || claimed.length === 0) {
    const { data: b } = await supabase.from("bookings").select("status").eq("id", bookingId).maybeSingle();
    if (!b) return { error: "Booking not found." };
    if (b.status !== "checked_in") return { error: "Only an in-house guest can be checked out." };
    return { error: "This guest is already being checked out at another desk. Wait a moment and refresh." };
  }
  try {
    return await checkOutClaimed(prev, fd);
  } finally {
    await supabase.from("bookings").update({ checkout_started_at: null }).eq("id", bookingId);
  }
}

async function checkOutClaimed(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("frontdesk.checkout");
  const supabase = await createClient();
  const settings = await getSettings();
  const booking = await loadBooking(supabase, uuidOrNull(fd, "booking_id"));
  if (!booking) return { error: "Booking not found." };
  if (booking.status !== "checked_in") return { error: "Only an in-house guest can be checked out." };

  const today = todayIn(settings.timezone);
  const nowLocal = nowTimeIn(settings.timezone);

  // A stay split by date carries on as its second part from the split date:
  // this part ends there, and the room is handed over (0040), not vacated.
  const { data: nextPart } = await supabase
    .from("bookings")
    .select("id, reference, check_in")
    .eq("split_from_id", booking.id)
    .in("status", ["tentative", "confirmed"])
    .order("check_in")
    .limit(1)
    .maybeSingle();
  let departure = checkoutDeparture(booking, today, settings.business_date);
  if (nextPart && departure > nextPart.check_in) departure = nextPart.check_in;
  const handedOver = Boolean(nextPart && departure === nextPart.check_in);

  // ── 1. Any night an audit did not charge (idempotent: one line per night) ──
  const chargeable = { ...booking, check_out: departure };
  const posted = await postRoomCharges(
    supabase,
    [chargeable],
    (b) => nightsBefore(b, departure),
    settings,
    session.staff.id,
  );
  if (posted.error) return { error: friendlyDbError(posted.error) };

  // ── 2. Everything that could refuse, checked before anything else is posted ──
  // A refused check-out used to leave the late fee and the payment on the
  // folio, and every retry posted them again.
  // The guest settles their own part; organiser-paid nights are the event's (0042).
  const before = await loadGuestFolio(supabase, booking.id);
  // Late only for a guest actually leaving: a split stay's guest stays put.
  const late =
    !handedOver && departure >= booking.check_out && departure <= today && isLate(nowLocal, settings.check_out_time);
  const lastNight = eachNight(booking.check_in, departure).at(-1) ?? booking.check_in;
  const lateFee = late
    ? timingFee(
        settings.late_checkout_fee_type,
        Number(settings.late_checkout_fee_value),
        rateForNight(booking.rate_breakdown, lastNight, booking.quoted_rate),
      )
    : 0;
  // A retried check-out finds the fee already there and does not charge it twice.
  const fee =
    late && lateFee > 0 && bool(fd, "apply_late_fee") && !lateFeePosted(before.entries, today)
      ? ancillaryCharge(lateFee, booking, settings, lastNight)
      : null;
  const feeTotal = fee ? Math.round((fee.amount + fee.tax_amount) * 100) / 100 : 0;

  const payNow = num(fd, "payment_amount");
  const payMethod = oneOfOrNull(fd, "payment_method", PAYMENT_METHODS);
  if (payNow && payNow > 0) {
    if (!payMethod) return { error: "Choose how the payment was made." };
    if (!can(session, "folio.payment")) return { error: "Your role cannot take payments." };
  }

  // A balance may only be left by someone who can adjust folios, with a
  // reason on record.
  const balanceAfter = Math.round((before.totals.balance + feeTotal - (payNow && payNow > 0 ? payNow : 0)) * 100) / 100;
  const balanceReason = str(fd, "balance_reason", 300);
  if (balanceAfter > 0.5 && !(can(session, "folio.adjust") && balanceReason)) {
    return {
      error: `₹${balanceAfter.toLocaleString("en-IN")} would still be owed. Take payment before checking out.`,
    };
  }

  // The tax invoice. A hotel that cannot issue GST invoices yet (no GSTIN)
  // still lets its guests leave: check-out completes and says why there is
  // no invoice. A problem with who the invoice is to is the desk's to fix
  // now, so it refuses here, before the fee or the payment is posted.
  // Whoever may check a guest out issues the invoice that goes with it (0041),
  // so the stay's GST return and loyalty points never depend on who was at
  // the desk.
  const invoicing = can(session, "folio.invoice") || can(session, "frontdesk.checkout");
  const propertyProblem = propertyInvoiceProblem(settings);
  const billTo = {
    name: str(fd, "bill_to_name", 200),
    gstin: str(fd, "bill_to_gstin", 20),
    address: str(fd, "bill_to_address", 500),
  };
  const { data: issuedRows } = await supabase
    .from("invoices")
    .select("folio_id")
    .eq("booking_id", booking.id)
    .eq("status", "issued");
  const alreadyInvoiced = new Set((issuedRows ?? []).map((r) => r.folio_id as string));
  if (invoicing && !propertyProblem) {
    const largest = Math.max(
      0,
      ...foliosToInvoice(before.entries, alreadyInvoiced).map(
        (folioId) =>
          invoiceTotals(invoiceLines(before.entries.filter((e) => e.folio_id === folioId), { regime: settings.tax_regime ?? "gst" }))
            .grand,
      ),
    );
    const problem = billToProblem(settings, billTo, booking.contact_name, largest + feeTotal);
    if (problem) return { error: `Not checked out: ${problem}` };
  }

  // ── 3. Post the fee and take the payment ──
  if (fee) {
    const feeError = await insertFolioEntries(supabase, {
      booking_id: booking.id,
      kind: "fee",
      description: `${LATE_FEE_PREFIX} at ${nowLocal}`,
      ...fee,
      stay_date: today,
      created_by: session.staff.id,
    });
    if (feeError) return { error: `Not checked out: the late check-out fee was not posted. ${feeError}` };
  }
  if (payNow && payNow > 0) {
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

  const { entries, totals } = await loadGuestFolio(supabase, booking.id);
  if (totals.balance > 0.5) {
    await supabase.rpc("log_event", {
      p_module: "folio",
      p_action: "checkout_with_balance",
      p_record_id: booking.id,
      p_summary: `Checked out owing ₹${totals.balance}: ${balanceReason}`,
    });
  }

  // ── 4. The tax invoice for every folio holding charges ──
  // A folio already invoiced is left alone. From here, anything charged later
  // goes to an "After invoice" folio (0039) and is invoiced from the folio.
  let warn = "";
  if (foliosToInvoice(entries, alreadyInvoiced).length > 0) {
    if (!invoicing) {
      warn = "No tax invoice was issued: your role cannot issue invoices. Ask someone who can to issue it from the folio.";
    } else if (propertyProblem) {
      warn = `No tax invoice was issued: ${propertyProblem} Then issue it from the folio.`;
    } else {
      const issued = await issueOutstandingInvoices(supabase, settings, booking.id, billTo, session.staff.id);
      if (issued.error) {
        // Rare: everything about the bill-to was checked above. The fee is not
        // charged twice on a retry, but a payment typed in again would be.
        const paid = payNow && payNow > 0 ? ` The payment of ₹${payNow.toLocaleString("en-IN")} is recorded: clear it from the form before trying again.` : "";
        return { error: `Not checked out: the tax invoice could not be issued. ${issued.error}${paid}` };
      }
      if (issued.skipped.length > 0) {
        warn = `${issued.skipped.length === 1 ? "One folio was" : `${issued.skipped.length} folios were`} not invoiced: its allowances are larger than its charges. Correct the allowance on the folio, then issue the invoice there.`;
      }
    }
  }

  // An early departure releases the nights it did not stay, so the booking's
  // total (and the bookings report) drops them too (0041).
  const released = (booking.rate_breakdown ?? []).filter((n) => n.date >= departure);
  const releasedTotal = released.reduce((s, n) => s + Number(n.rate), 0) * booking.rooms_count;
  const { error } = await supabase
    .from("bookings")
    .update({
      status: "checked_out",
      check_out: departure,
      total_amount: Math.max(0, Math.round((Number(booking.total_amount) - releasedTotal) * 100) / 100),
      rate_breakdown: (booking.rate_breakdown ?? []).filter((n) => n.date < departure),
      checked_out_at: new Date().toISOString(),
      checked_out_by: session.staff.id,
    })
    .eq("id", booking.id);
  if (error) {
    // The invoice may be issued by now; a retry reuses it and finishes the job.
    const invoiced = warn ? "" : " Any tax invoice is already issued, and trying again reuses it.";
    return { error: `Not checked out: ${friendlyDbError(error.message)}${invoiced}` };
  }

  // The last organiser-paid room of a completed event to leave: the event's
  // invoice, which carries these rooms' nights, can now be issued (0042).
  if (booking.group_id) {
    const { data: group } = await supabase
      .from("booking_groups")
      .select("event_id, room_billing, event_bookings(status)")
      .eq("id", booking.group_id)
      .maybeSingle();
    const eventStatus = (group?.event_bookings as unknown as { status: string } | null)?.status;
    if (group?.event_id && group.room_billing === "organiser" && eventStatus === "completed" && can(session, "folio.invoice")) {
      const issued = await invoiceEvent(supabase, settings, session.staff.id, group.event_id as string, {
        name: "",
        gstin: "",
        address: "",
      });
      if ("number" in issued) {
        warn = [warn, `The event's invoice ${issued.number} is issued, with its rooms.`].filter(Boolean).join(" ");
      }
    }
  }

  if (booking.room_id && booking.rooms && !handedOver) {
    await issueKeys(supabase, session, booking, booking.rooms.room_number, booking.room_id, 1, "revoke");
  }
  if (handedOver) {
    warn = [warn, `${nextPart!.reference} is now checked in to the same room; the guest's keys still work.`]
      .filter(Boolean)
      .join(" ");
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
