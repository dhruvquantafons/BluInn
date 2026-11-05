/**
 * Small rules the front desk screens share: which guests have a birthday or
 * anniversary during their stay, and where a booking stands on its deposit.
 */

/**
 * Whether the day and month of `date` (a birthday or anniversary, any year)
 * falls on a night of the stay or on departure day. Handles a stay over New
 * Year, and a 29 February birthday in a non-leap year (taken as 28 Feb).
 */
export function occasionInStay(date: string | null | undefined, checkIn: string, checkOut: string): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return false;
  const md = date.slice(5, 10);
  const startYear = Number(checkIn.slice(0, 4));
  const endYear = Number(checkOut.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    let day = `${year}-${md}`;
    if (md === "02-29" && !isLeap(year)) day = `${year}-02-28`;
    if (day >= checkIn && day <= checkOut) return true;
  }
  return false;
}

function isLeap(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export type DepositState = "none" | "received" | "due" | "overdue" | "part";

/**
 * Where a booking stands on its deposit. "due" means a due date is set and
 * not yet passed; "overdue" that it has; "part" that some has come in but
 * not all, with the due date still ahead.
 */
export function depositState(
  required: number,
  received: number,
  dueOn: string | null | undefined,
  today: string,
): DepositState {
  if (!(required > 0)) return "none";
  if (received >= required) return "received";
  if (dueOn && dueOn < today) return "overdue";
  return received > 0 ? "part" : "due";
}
