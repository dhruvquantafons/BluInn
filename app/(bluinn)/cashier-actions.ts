"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../lib/supabase/server";
import { requirePermission, requireAnyPermission } from "../lib/auth";
import { friendlyDbError } from "../lib/db-errors";
import { type ActionState, str, num, oneOf, uuidOrNull } from "./form-utils";

/**
 * Cashier shifts (0029): open with a float, record pay-ins, paid-outs and
 * safe drops, close by counting the drawer. The database does the arithmetic
 * (cashier_shift_expected) and the permission checks; these actions only
 * read the form and explain the result.
 */

const fmtMoney = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function revalidateShifts() {
  revalidatePath("/front-desk");
  revalidatePath("/front-desk/shifts");
  revalidatePath("/pos");
  revalidatePath("/night-audit");
}

export async function openShift(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("folio.cashier");
  const supabase = await createClient();
  const float = num(fd, "opening_float") ?? 0;
  if (float < 0) return { error: "The float cannot be negative." };

  const { error } = await supabase.rpc("cashier_open_shift", { p_float: float });
  if (error) return { error: friendlyDbError(error.message) };

  revalidateShifts();
  return { success: `Shift opened with a float of ${fmtMoney(float)}.` };
}

export async function recordCashMovement(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requirePermission("folio.cashier");
  const supabase = await createClient();
  const kind = oneOf(fd, "kind", ["pay_in", "paid_out", "safe_drop"] as const, "paid_out");
  const amount = num(fd, "amount");
  const reason = str(fd, "reason", 300);
  const bookingId = kind === "paid_out" ? uuidOrNull(fd, "booking_id") : null;

  if (amount === null || amount <= 0) return { error: "Enter an amount above zero." };
  if (!reason) return { error: "Give a reason." };

  const { error } = await supabase.rpc("cashier_cash_movement", {
    p_kind: kind,
    p_amount: amount,
    p_reason: reason,
    p_booking: bookingId,
  });
  if (error) return { error: friendlyDbError(error.message) };

  revalidateShifts();
  if (bookingId) revalidatePath(`/bookings/${bookingId}`);
  const label = kind === "pay_in" ? "Pay-in" : kind === "safe_drop" ? "Safe drop" : "Paid-out";
  return {
    success: `${label} of ${fmtMoney(amount)} recorded${bookingId ? " and charged to the guest's folio" : ""}.`,
  };
}

export async function closeShift(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAnyPermission(["folio.cashier", "folio.cashier_audit"]);
  const supabase = await createClient();
  const shiftId = uuidOrNull(fd, "shift_id");
  const counted = num(fd, "counted_cash");
  if (!shiftId) return { error: "Shift not found." };
  if (counted === null || counted < 0) return { error: "Enter the cash you counted in the drawer." };

  const { data, error } = await supabase.rpc("cashier_close_shift", {
    p_shift: shiftId,
    p_counted: counted,
    p_notes: str(fd, "notes", 500),
  });
  if (error) return { error: friendlyDbError(error.message) };

  revalidateShifts();
  const variance = Number((data as { variance: number } | null)?.variance ?? 0);
  return {
    success:
      variance === 0
        ? "Shift closed. The drawer balances."
        : `Shift closed. The drawer is ${variance < 0 ? "short" : "over"} by ${fmtMoney(Math.abs(variance))}.`,
  };
}
