/**
 * Stock arithmetic for the inventory screens (0033). The database holds the
 * movements; these turn them into what a storekeeper reads.
 */

export interface StockRow {
  item_id: string;
  location_id: string;
  qty: number;
}

/** Total on hand per item, across every location. */
export function totalsByItem(rows: StockRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.item_id, round3((out.get(r.item_id) ?? 0) + Number(r.qty)));
  return out;
}

export type StockState = "out" | "reorder" | "below_par" | "ok";

/** Out, at or under the re-order level, under par, or fine. */
export function stockState(onHand: number, reorderLevel: number, parLevel: number): StockState {
  if (onHand <= 0) return "out";
  if (reorderLevel > 0 && onHand <= reorderLevel) return "reorder";
  if (parLevel > 0 && onHand < parLevel) return "below_par";
  return "ok";
}

/** How many to order to bring stock back to par (never negative). */
export function toOrder(onHand: number, parLevel: number): number {
  return Math.max(0, round3(parLevel - Math.max(0, onHand)));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
