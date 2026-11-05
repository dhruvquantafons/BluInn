"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../lib/supabase/server";
import { requirePermission } from "../lib/auth";
import { friendlyDbError } from "../lib/db-errors";
import { type ActionState, str, num, int, bool, oneOf, uuidOrNull } from "./form-utils";

/**
 * Inventory and stores (0033). The database keeps the ledger: every movement
 * goes through inventory_move(), which checks the permission, the property
 * and the direction of each kind of movement.
 */

const CATEGORIES = ["amenity", "linen", "minibar", "cleaning", "engineering", "food", "beverage", "other"] as const;
const LOCATION_KINDS = ["store", "floor", "outlet", "other"] as const;
const MOVES = ["receive", "issue", "consume", "wastage", "adjust"] as const;

function revalidateInventory() {
  revalidatePath("/inventory", "layout");
}

export async function moveStock(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("inventory.manage");
  const supabase = await createClient();
  const itemId = uuidOrNull(fd, "item_id");
  const kind = oneOf(fd, "kind", MOVES, "receive");
  const qty = num(fd, "qty");
  if (!itemId) return { error: "Choose an item." };
  if (qty === null || qty < 0 || (qty === 0 && kind !== "adjust")) return { error: "Enter a quantity above zero." };

  const from = uuidOrNull(fd, "from_location");
  const to = uuidOrNull(fd, "to_location");
  // Which end each kind needs: receive and count go *to* a location; use and
  // wastage come *from* one; issue needs both (store → pantry).
  if ((kind === "receive" || kind === "adjust") && !to) return { error: "Choose the location." };
  if ((kind === "consume" || kind === "wastage") && !from) return { error: "Choose where it was taken from." };
  if (kind === "issue" && (!from || !to)) return { error: "Choose where it goes from and to." };

  const cost = num(fd, "unit_cost");
  const { error } = await supabase.rpc("inventory_move", {
    p_item: itemId,
    p_kind: kind,
    p_qty: qty,
    p_from: kind === "receive" || kind === "adjust" ? null : from,
    p_to: kind === "consume" || kind === "wastage" ? null : to,
    p_reason: str(fd, "reason", 300),
    p_unit_cost: kind === "receive" && cost !== null && cost > 0 ? cost : null,
    p_reference: str(fd, "reference", 100),
  });
  if (error) return { error: friendlyDbError(error.message) };

  revalidateInventory();
  const label = { receive: "Received", issue: "Issued", consume: "Recorded as used", wastage: "Written off", adjust: "Count recorded" }[kind];
  return { success: `${label}.` };
}

export async function saveInventoryItem(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("inventory.manage");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const name = str(fd, "name", 120);
  if (!name) return { error: "Name the item." };

  const payload = {
    sku: str(fd, "sku", 40).toUpperCase(),
    name,
    category: oneOf(fd, "category", CATEGORIES, "other"),
    unit: str(fd, "unit", 20) || "each",
    par_level: Math.max(0, num(fd, "par_level") ?? 0),
    reorder_level: Math.max(0, num(fd, "reorder_level") ?? 0),
    unit_cost: Math.max(0, num(fd, "unit_cost") ?? 0),
    pos_item_id: uuidOrNull(fd, "pos_item_id"),
    hk_checklist_item_id: uuidOrNull(fd, "hk_checklist_item_id"),
    is_active: id ? bool(fd, "is_active") : true,
    updated_at: new Date().toISOString(),
  };
  const { error } = id
    ? await supabase.from("inventory_items").update(payload).eq("id", id)
    : await supabase.from("inventory_items").insert(payload);
  if (error) {
    return { error: /duplicate key/i.test(error.message) ? "That SKU, POS item or checklist line is already linked to another item." : friendlyDbError(error.message) };
  }

  revalidateInventory();
  return { success: id ? `${name} saved.` : `${name} added.` };
}

export async function saveInventoryLocation(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("inventory.manage");
  const supabase = await createClient();
  const id = uuidOrNull(fd, "id");
  const name = str(fd, "name", 80);
  if (!name) return { error: "Name the location." };
  const hkDefault = bool(fd, "hk_default");

  // Only one location takes housekeeping's checklist consumption.
  if (hkDefault) {
    const clear = supabase.from("inventory_locations").update({ hk_default: false }).eq("hk_default", true);
    const { error } = id ? await clear.neq("id", id) : await clear;
    if (error) return { error: friendlyDbError(error.message) };
  }

  const payload = {
    name,
    kind: oneOf(fd, "kind", LOCATION_KINDS, "store"),
    outlet_id: uuidOrNull(fd, "outlet_id"),
    hk_default: hkDefault,
    is_active: id ? bool(fd, "is_active") : true,
    sort_order: int(fd, "sort_order", 0, 0, 999),
  };
  const { error } = id
    ? await supabase.from("inventory_locations").update(payload).eq("id", id)
    : await supabase.from("inventory_locations").insert(payload);
  if (error) {
    return { error: /duplicate key/i.test(error.message) ? "A location with that name, or for that outlet, already exists." : friendlyDbError(error.message) };
  }

  revalidateInventory();
  return { success: id ? `${name} saved.` : `${name} added.` };
}
