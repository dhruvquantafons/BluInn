/**
 * Checks on rate set-up that the pricing engine cannot catch at quote time
 * (0043). A room is never legitimately sold at ₹0: a complimentary stay uses
 * the booking's stay type, not a zero rate.
 */

/** A rate plan's adjustment that would price a room at ₹0 or below. Returns a sentence, or null. */
export function planAdjustmentProblem(kind: "percent" | "amount" | "fixed", value: number): string | null {
  if (kind === "percent" && value <= -100) return "A discount must be less than 100%.";
  if (kind === "fixed" && value <= 0) return "A fixed rate must be above ₹0.";
  return null;
}

export interface SeasonShape {
  id: string | null;
  name: string;
  start_date: string;
  end_date: string;
  room_type_id: string | null;
  priority: number;
  days_of_week: number[];
  is_active: boolean;
}

/**
 * Another active season that covers the same nights, for the same room types,
 * at the same priority. Only that overlap is ambiguous: a higher priority
 * already wins (seasonFor, lib/pricing.ts). Returns the season, or null.
 */
export function overlappingSeason<T extends SeasonShape>(candidate: SeasonShape, others: T[]): T | null {
  if (!candidate.is_active) return null;
  const days = new Set(candidate.days_of_week);
  return (
    others.find(
      (s) =>
        s.id !== candidate.id &&
        s.is_active &&
        s.priority === candidate.priority &&
        (s.room_type_id ?? null) === (candidate.room_type_id ?? null) &&
        s.start_date <= candidate.end_date &&
        candidate.start_date <= s.end_date &&
        s.days_of_week.some((d) => days.has(d)),
    ) ?? null
  );
}
