import type { CashMovementKind } from "./types";

/**
 * What a cashier's drawer should hold, line by line, for the shift report.
 *
 * Mirrors cashier_shift_expected() in 0029_cashier_shifts.sql, which is what
 * the close actually records; this breakdown is for showing the cashier where
 * the figure comes from. Keep the two in step.
 */
export interface ShiftInputs {
  openingFloat: number;
  folio: { kind: string; method: string | null; amount: number; voided_at: string | null }[];
  pos: { kind: string; amount: number; voided_at: string | null }[];
  movements: { kind: CashMovementKind; amount: number }[];
}

export interface ShiftBreakdown {
  openingFloat: number;
  folioCash: number;
  folioCashRefunds: number;
  outletCash: number;
  payIns: number;
  paidOuts: number;
  safeDrops: number;
  /** Non-cash takings on the shift, by method — shown, not counted. */
  otherByMethod: Record<string, number>;
  expected: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function shiftBreakdown(input: ShiftInputs): ShiftBreakdown {
  let folioCash = 0;
  let folioCashRefunds = 0;
  let outletCash = 0;
  const otherByMethod: Record<string, number> = {};

  for (const e of input.folio) {
    if (e.voided_at || (e.kind !== "payment" && e.kind !== "refund")) continue;
    const amount = Number(e.amount);
    if (e.method === "cash") {
      if (e.kind === "payment") folioCash += amount;
      else folioCashRefunds += amount;
    } else {
      const key = e.method ?? "other";
      otherByMethod[key] = round2((otherByMethod[key] ?? 0) + (e.kind === "payment" ? amount : -amount));
    }
  }
  for (const p of input.pos) {
    if (p.voided_at || p.kind === "room_charge" || p.kind === "loyalty_points") continue;
    if (p.kind === "cash") outletCash += Number(p.amount);
    else otherByMethod[`outlet_${p.kind}`] = round2((otherByMethod[`outlet_${p.kind}`] ?? 0) + Number(p.amount));
  }

  const sum = (kind: CashMovementKind) =>
    round2(input.movements.filter((m) => m.kind === kind).reduce((s, m) => s + Number(m.amount), 0));
  const payIns = sum("pay_in");
  const paidOuts = sum("paid_out");
  const safeDrops = sum("safe_drop");

  const expected = round2(
    Number(input.openingFloat) + folioCash - folioCashRefunds + outletCash + payIns - paidOuts - safeDrops,
  );

  return {
    openingFloat: round2(Number(input.openingFloat)),
    folioCash: round2(folioCash),
    folioCashRefunds: round2(folioCashRefunds),
    outletCash: round2(outletCash),
    payIns,
    paidOuts,
    safeDrops,
    otherByMethod,
    expected,
  };
}

/** How a variance reads on the report: short, over or balanced. */
export function varianceLabel(variance: number | null): { text: string; tone: "green" | "red" | "amber" | "neutral" } {
  if (variance === null) return { text: "Open", tone: "neutral" };
  const v = Number(variance);
  if (v === 0) return { text: "Balanced", tone: "green" };
  return v < 0 ? { text: `Short ${Math.abs(v).toFixed(2)}`, tone: "red" } : { text: `Over ${v.toFixed(2)}`, tone: "amber" };
}
