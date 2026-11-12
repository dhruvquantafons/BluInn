"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "../lib/supabase/server";
import { requirePermission, requireAnyPermission, type Session } from "../lib/auth";
import { can } from "../lib/permissions";
import { getSettings } from "../lib/settings";
import { friendlyDbError } from "../lib/db-errors";
import { todayIn } from "../lib/dates";
import type { ChecklistEntry, HkChecklistItem, HousekeepingTask } from "../lib/types";
import { type ActionState, str, int, bool, oneOf, dateStr, uuidOrNull } from "./form-utils";

/**
 * Module 5 — Housekeeping.
 *
 * Room status flow: Dirty → Cleaning (task started) → Clean (task done) →
 * Inspected (supervisor passed it: ready for guest). A failed inspection
 * returns the room to Dirty and the task to its housekeeper.
 */

function revalidateHk() {
  revalidatePath("/housekeeping", "layout");
  revalidatePath("/rooms");
  revalidatePath("/front-desk");
  revalidatePath("/");
}

async function hotelToday() {
  return todayIn((await getSettings()).timezone);
}

async function loadTask(supabase: SupabaseClient, id: string | null) {
  if (!id) return null;
  const { data } = await supabase
    .from("housekeeping_tasks")
    .select("*, rooms(id, room_number, floor, status, housekeeping_status, dnd)")
    .eq("id", id)
    .maybeSingle();
  return (data as HousekeepingTask | null) ?? null;
}

/** Housekeepers act on their own tasks; supervisors on any. */
function mayWork(session: Session, task: HousekeepingTask) {
  return can(session, "housekeeping.assign") || task.assigned_to === session.staff.id;
}

/**
 * Sets the room's housekeeping status. Returns a sentence when it could not
 * (0043): the task used to show cleaned while the room stayed dirty.
 */
async function setRoomHk(
  supabase: SupabaseClient,
  roomId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { error } = await supabase
    .from("rooms")
    .update({ housekeeping_status: status, housekeeping_updated_at: new Date().toISOString(), ...extra })
    .eq("id", roomId);
  return error ? ` The room's status was not updated: ${friendlyDbError(error.message)}` : "";
}

// ── Planning ────────────────────────────────────────────────────────────────

export async function generateTasks(): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("hk_generate_tasks", { p_date: await hotelToday() });
  if (error) return { error: friendlyDbError(error.message) };
  revalidateHk();
  return { success: data ? `${data} task(s) created and assigned.` : "Nothing new to add — every room is covered." };
}

export async function createTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const roomId = uuidOrNull(fd, "room_id");
  if (!roomId) return { error: "Choose a room." };
  const kind = oneOf(fd, "kind", ["checkout", "deep_clean"] as const, "checkout");

  const { data: id, error } = await supabase.rpc("hk_create_task", {
    p_room: roomId,
    p_kind: kind,
    p_date: await hotelToday(),
  });
  if (error) return { error: friendlyDbError(error.message) };
  if (!id) return { error: "That room already has an open task of this kind today." };

  const assignee = uuidOrNull(fd, "assigned_to");
  let warn = "";
  if (assignee) {
    const { error: assignError } = await supabase
      .from("housekeeping_tasks")
      .update({ assigned_to: assignee, assigned_at: new Date().toISOString() })
      .eq("id", id);
    if (assignError) warn += ` It was not assigned: ${friendlyDbError(assignError.message)}`;
  }
  // Starting a clean means the room is not ready, whatever it showed before.
  const { data: room } = await supabase.from("rooms").select("housekeeping_status, status").eq("id", roomId).single();
  if (room && room.status !== "occupied" && room.housekeeping_status === "inspected") {
    warn += await setRoomHk(supabase, roomId, "dirty");
  }

  revalidateHk();
  return warn ? { error: `Task added.${warn}` } : { success: "Task added." };
}

export async function reassignTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  if (!id) return { error: "Task not found." };
  const staffId = uuidOrNull(fd, "assigned_to");
  const { error } = await supabase
    .from("housekeeping_tasks")
    .update({ assigned_to: staffId, assigned_at: staffId ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) return { error: friendlyDbError(error.message) };
  revalidateHk();
  return { success: staffId ? "Assigned." : "Unassigned." };
}

/** Cancels a task that should not be done (the room was taken off sale, a duplicate…). */
export async function cancelTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const reason = str(fd, "reason", 300);
  if (!id) return { error: "Task not found." };
  if (!reason) return { error: "Say why the task is cancelled." };
  const { data: task } = await supabase.from("housekeeping_tasks").select("notes").eq("id", id).maybeSingle();
  const { data, error } = await supabase
    .from("housekeeping_tasks")
    .update({ status: "cancelled", notes: [task?.notes, `Cancelled: ${reason}`].filter(Boolean).join(" · ") })
    .eq("id", id)
    .in("status", ["pending", "in_progress"])
    .select("id");
  if (error) return { error: friendlyDbError(error.message) };
  if (!data?.length) return { error: "Only a task not yet cleaned can be cancelled." };
  revalidateHk();
  return { success: "Task cancelled." };
}

// ── Working a task ──────────────────────────────────────────────────────────

export async function startTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("housekeeping.tasks");
  const supabase = await createClient();
  const task = await loadTask(supabase, uuidOrNull(fd, "id"));
  if (!task) return { error: "Task not found." };
  if (!mayWork(session, task)) return { error: "This task is assigned to someone else." };
  if (task.status !== "pending") return { error: "This task has already been started." };

  const { error } = await supabase
    .from("housekeeping_tasks")
    .update({
      status: "in_progress",
      started_at: new Date().toISOString(),
      // Whoever starts an unassigned task takes it.
      assigned_to: task.assigned_to ?? session.staff.id,
    })
    .eq("id", task.id)
    .eq("status", "pending");
  if (error) return { error: friendlyDbError(error.message) };

  const warn = await setRoomHk(supabase, task.room_id, "cleaning");
  revalidateHk();
  return warn ? { error: `Started.${warn}` } : { success: "Started. The timer is running." };
}

export async function completeTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("housekeeping.tasks");
  const supabase = await createClient();
  const task = await loadTask(supabase, uuidOrNull(fd, "id"));
  if (!task) return { error: "Task not found." };
  if (!mayWork(session, task)) return { error: "This task is assigned to someone else." };
  if (task.status !== "in_progress") return { error: "Start the task first." };

  const { data: items } = await supabase.from("hk_checklist_items").select("*").eq("is_active", true).order("sort_order");
  const checklist: ChecklistEntry[] = ((items ?? []) as HkChecklistItem[]).map((i) => ({
    item_id: i.id,
    label: i.label,
    category: i.category,
    // A quantity typed in means it was restocked, ticked or not (0041); it
    // used to be ignored, so the stock it used was never deducted.
    done: bool(fd, `done_${i.id}`) || int(fd, `qty_${i.id}`, 0, 0, 99) > 0,
    qty: int(fd, `qty_${i.id}`, 0, 0, 99),
  }));
  const missed = checklist.filter((c) => c.category !== "minibar" && !c.done);
  if (missed.length && !bool(fd, "confirm_incomplete")) {
    return { error: `Not ticked: ${missed.map((m) => m.label).join(", ")}. Tick them, or confirm finishing without them.` };
  }

  const { error } = await supabase
    .from("housekeeping_tasks")
    .update({
      status: "cleaned",
      completed_at: new Date().toISOString(),
      completed_by: session.staff.id,
      checklist,
    })
    .eq("id", task.id);
  if (error) return { error: friendlyDbError(error.message) };

  const warn = await setRoomHk(supabase, task.room_id, "clean");
  revalidateHk();
  return warn ? { error: `Marked cleaned.${warn}` } : { success: "Done. Waiting for the supervisor to inspect." };
}

export async function inspectTask(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("housekeeping.inspect");
  const supabase = await createClient();
  const task = await loadTask(supabase, uuidOrNull(fd, "id"));
  if (!task) return { error: "Task not found." };
  if (task.status !== "cleaned") return { error: "This room is not waiting for inspection." };

  const passed = oneOf(fd, "result", ["pass", "fail"] as const, "pass") === "pass";
  const note = str(fd, "note", 500);
  if (!passed && !note) return { error: "Say what needs redoing." };

  const { error } = await supabase
    .from("housekeeping_tasks")
    .update(
      passed
        ? { status: "inspected", inspected_at: new Date().toISOString(), inspected_by: session.staff.id, inspection_note: note }
        : {
            status: "pending",
            started_at: null,
            completed_at: null,
            inspection_note: note,
            failed_count: task.failed_count + 1,
            inspected_by: session.staff.id,
          },
    )
    .eq("id", task.id);
  if (error) return { error: friendlyDbError(error.message) };

  const warn = await setRoomHk(
    supabase,
    task.room_id,
    passed ? "inspected" : "dirty",
    passed && task.kind === "deep_clean" ? { last_deep_clean_on: task.task_date } : {},
  );
  revalidateHk();
  if (warn) return { error: `${passed ? "Inspection passed." : "Sent back."}${warn}` };
  return { success: passed ? `Room ${task.rooms?.room_number} is ready for guests.` : "Sent back for re-cleaning." };
}

// ── Do Not Disturb ──────────────────────────────────────────────────────────

export async function setDnd(fd: FormData) {
  await requireAnyPermission(["rooms.status", "housekeeping.tasks", "frontdesk.requests"]);
  const supabase = await createClient();
  const id = uuidOrNull(fd, "room_id");
  if (!id) return;
  await supabase.from("rooms").update({ dnd: bool(fd, "dnd"), dnd_updated_at: new Date().toISOString() }).eq("id", id);
  revalidateHk();
}

// ── Lost & found ────────────────────────────────────────────────────────────

export async function logLostItem(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("housekeeping.lost_found");
  const supabase = await createClient();
  const description = str(fd, "description", 500);
  const foundOn = dateStr(fd, "found_on") || (await hotelToday());
  const roomId = uuidOrNull(fd, "room_id");
  if (!description) return { error: "Describe the item." };
  if (!roomId && !str(fd, "location")) return { error: "Choose the room, or say where it was found." };

  const { data, error } = await supabase
    .from("lost_found_items")
    .insert({
      room_id: roomId,
      location: str(fd, "location", 200),
      found_on: foundOn,
      description,
      found_by: session.staff.id,
    })
    .select("reference")
    .single();
  if (error) return { error: friendlyDbError(error.message) };

  revalidatePath("/housekeeping/lost-found");
  return { success: `Logged as ${data.reference}.` };
}

const LOST_CATEGORIES = ["electronics", "documents", "jewellery", "clothing", "money", "other"] as const;
const LOST_STATUSES = ["stored", "returned", "disposed"] as const;

/**
 * Files a found item properly: what it is, where it is kept, whose stay it is
 * likely from, and how it ended (returned to whom, or disposed of).
 */
export async function updateLostItem(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requirePermission("housekeeping.lost_found");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  if (!id) return { error: "Item not found." };
  const status = oneOf(fd, "status", LOST_STATUSES, "stored");
  const returnedTo = str(fd, "returned_to", 200);
  if (status === "returned" && !returnedTo) return { error: "Say who it was returned to." };

  let bookingId: string | null = null;
  const reference = str(fd, "booking_reference", 40).toUpperCase();
  if (reference) {
    const { data: booking } = await supabase.from("bookings").select("id").eq("reference", reference).maybeSingle();
    if (!booking) return { error: `No booking ${reference} at this hotel.` };
    bookingId = booking.id as string;
  }

  const { error } = await supabase
    .from("lost_found_items")
    .update({
      category: oneOf(fd, "category", LOST_CATEGORIES, "other"),
      storage_location: str(fd, "storage_location", 200),
      booking_id: bookingId,
      status,
      returned_to: status === "returned" ? returnedTo : "",
      notes: str(fd, "notes", 1000),
      resolved_at: status === "stored" ? null : new Date().toISOString(),
      resolved_by: status === "stored" ? null : session.staff.id,
    })
    .eq("id", id);
  if (error) return { error: friendlyDbError(error.message) };
  revalidatePath("/housekeeping/lost-found");
  return { success: status === "stored" ? "Saved." : status === "returned" ? `Marked returned to ${returnedTo}.` : "Marked disposed." };
}

// ── Setup ───────────────────────────────────────────────────────────────────

export async function saveZone(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const name = str(fd, "name", 80);
  const floors = [
    ...new Set(
      str(fd, "floors", 200)
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= -5 && n <= 200),
    ),
  ].sort((a, b) => a - b);
  if (!name) return { error: "Name the zone." };
  if (floors.length === 0) return { error: "List the floors in this zone, e.g. 1, 2." };

  const { error } = id
    ? await supabase.from("housekeeping_zones").update({ name, floors }).eq("id", id)
    : await supabase.from("housekeeping_zones").insert({ name, floors });
  if (error) return { error: error.code === "23505" ? "A zone with that name exists." : friendlyDbError(error.message) };

  revalidateHk();
  return { success: "Zone saved." };
}

export async function deleteZone(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  if (!id) return { error: "Zone not found." };
  const { error } = await supabase.from("housekeeping_zones").delete().eq("id", id);
  if (error) return { error: friendlyDbError(error.message) };
  revalidateHk();
  return { success: "Zone deleted." };
}

export async function setStaffDuty(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "staff_id");
  if (!id) return { error: "Staff member not found." };
  const { error } = await supabase.rpc("set_hk_staff", {
    p_staff: id,
    p_zone: uuidOrNull(fd, "zone_id"),
    p_on_duty: bool(fd, "on_duty"),
  });
  if (error) return { error: friendlyDbError(error.message) };
  revalidateHk();
  return { success: "Saved." };
}

export async function saveChecklistItem(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.assign");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const label = str(fd, "label", 120);
  if (!label) return { error: "Name the item." };
  const payload = {
    label,
    category: oneOf(fd, "category", ["linen", "amenities", "minibar"] as const, "amenities"),
    par_qty: int(fd, "par_qty", 1, 0, 99),
    sort_order: int(fd, "sort_order", 50, 0, 999),
    is_active: id ? bool(fd, "is_active") : true,
  };
  const { error } = id
    ? await supabase.from("hk_checklist_items").update(payload).eq("id", id)
    : await supabase.from("hk_checklist_items").insert(payload);
  if (error) return { error: friendlyDbError(error.message) };

  revalidateHk();
  return { success: "Checklist saved." };
}

// ── Occupancy reports, minibar and laundry (0032) ───────────────────────────

/** The database puts the sentence for the desk in the hint (0017). */
const rpcError = (e: { message: string; hint?: string | null }) => e.hint || friendlyDbError(e.message);

/**
 * What the attendant saw: is someone living in the room? Compared with the
 * front desk's status, it finds skips and sleepers (room_discrepancies).
 */
export async function reportRoom(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAnyPermission(["housekeeping.tasks", "housekeeping.inspect", "rooms.status"]);
  const supabase = await createClient();
  const roomId = uuidOrNull(fd, "room_id");
  const reported = oneOf(fd, "reported", ["occupied", "vacant"] as const, "occupied");
  if (!roomId) return { error: "Room not found." };

  const { error } = await supabase.rpc("hk_report_room", {
    p_room: roomId,
    p_reported: reported,
    p_luggage: bool(fd, "luggage"),
    p_notes: str(fd, "notes", 300),
  });
  if (error) return { error: rpcError(error) };

  revalidateHk();
  revalidatePath("/front-desk");
  return { success: `Recorded: room ${reported}.` };
}

/**
 * Minibar items used, or a laundry bag collected, posted to the guest in the
 * room as one outlet bill charged to their folio.
 */
export async function postRoomConsumption(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("housekeeping.post_charges");
  const supabase = await createClient();
  const roomId = uuidOrNull(fd, "room_id");
  const outlet = oneOf(fd, "outlet", ["mini_bar", "laundry"] as const, "mini_bar");
  if (!roomId) return { error: "Room not found." };

  // One quantity field per menu item: qty_<item id>.
  const items: { item_id: string; qty: number }[] = [];
  for (const [key, value] of fd.entries()) {
    const m = /^qty_([0-9a-f-]{36})$/i.exec(key);
    const qty = Number(value);
    if (m && Number.isFinite(qty) && qty > 0) items.push({ item_id: m[1], qty: Math.min(qty, 99) });
  }
  if (items.length === 0) return { error: "Enter how many of at least one item." };

  const { data: orderId, error } = await supabase.rpc("hk_post_consumption", {
    p_room: roomId,
    p_outlet_kind: outlet,
    p_items: items,
    p_notes: str(fd, "notes", 300),
  });
  if (error) return { error: rpcError(error) };

  revalidateHk();
  revalidatePath("/pos");
  // The charge lands on the guest's folio, so their booking shows it at once.
  const { data: order } = await supabase.from("pos_orders").select("booking_id").eq("id", orderId as string).maybeSingle();
  if (order?.booking_id) revalidatePath(`/bookings/${order.booking_id}`, "layout");
  return { success: outlet === "laundry" ? "Laundry collected and charged to the room." : "Minibar charged to the room." };
}

export async function setLaundryStatus(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAnyPermission(["housekeeping.post_charges", "housekeeping.assign", "pos.manage"]);
  const supabase = await createClient();
  const orderId = uuidOrNull(fd, "order_id");
  const status = oneOf(fd, "laundry_status", ["collected", "processing", "delivered"] as const, "processing");
  if (!orderId) return { error: "Laundry bag not found." };
  const { error } = await supabase.rpc("pos_set_laundry_status", { p_order: orderId, p_status: status });
  if (error) return { error: rpcError(error) };
  revalidateHk();
  return { success: status === "delivered" ? "Delivered to the room." : "Sent to laundry." };
}
