/**
 * Turns the database's guard errors into sentences for the desk.
 *
 * enforce_booking_inventory() raises messages prefixed OVERBOOKED:,
 * ROOM_CONFLICT: and ROOM_BLOCKED:, which carry the detail after the colon.
 */
export function friendlyDbError(message: string | undefined | null): string {
  if (!message) return "Something went wrong. Please try again.";

  if (message.startsWith("OVERBOOKED:")) {
    return `No availability — ${message.slice("OVERBOOKED:".length).trim()}. Waitlist the guest, choose other dates or room type, or (with permission) override with a reason.`;
  }
  if (message.startsWith("ROOM_CONFLICT:")) {
    return `Room clash — ${message.slice("ROOM_CONFLICT:".length).trim()} for overlapping nights.`;
  }
  if (message.startsWith("ROOM_BLOCKED:")) {
    return `Room unavailable — ${message.slice("ROOM_BLOCKED:".length).trim()}.`;
  }
  if (message.startsWith("INVOICE_IMMUTABLE")) {
    return "An issued invoice cannot be changed or deleted. Cancel it and issue a new one.";
  }
  if (message.startsWith("INVOICE_CANCELLED")) {
    return "That invoice is already cancelled.";
  }
  // GST invoicing (0036): each carries its own sentence after the colon.
  for (const code of [
    "INVOICE_HAS_CREDIT_NOTE:",
    "INVOICE_CANCEL_WINDOW:",
    "CREDIT_NOTE_",
    "ALLOWANCE_",
    // Timesheets (0038).
    "TIMESHEET_",
    // Interconnection guards (0039).
    "FOLIO_INVOICED:",
    "REFUND_EXCEEDS_PAID:",
    "EVENT_REFUND_EXCEEDS_PAID:",
    "POS_DAY_CLOSED:",
  ]) {
    if (message.startsWith(code)) {
      const detail = message.slice(message.indexOf(":") + 1).trim();
      if (detail) return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
    }
  }
  if (message.startsWith("REFUND_SELF_APPROVAL")) {
    return "A refund must be approved by someone other than the person who requested it.";
  }
  if (message.startsWith("FOLIO_BOOKING_MISMATCH")) {
    return "That folio belongs to a different booking.";
  }
  if (message.startsWith("EVENT_EQUIPMENT_CLASH:")) {
    return `Not enough equipment — ${message.slice("EVENT_EQUIPMENT_CLASH:".length).trim()} across the confirmed functions that overlap this one.`;
  }
  if (message.startsWith("INVENTORY_")) {
    const detail = message.split(":").slice(1).join(":").trim();
    if (message.startsWith("INVENTORY_IMMUTABLE")) return "Stock movements are never changed. Record a count adjustment instead.";
    return detail ? detail.charAt(0).toUpperCase() + detail.slice(1) + "." : "That stock movement is not valid.";
  }
  if (message.startsWith("ROOM_IN_USE:")) {
    return `A guest is assigned to this room — ${message.slice("ROOM_IN_USE:".length).trim()}. Move them first.`;
  }
  if (message.startsWith("HK_NO_ROOM")) {
    return "That room is not at this property.";
  }
  if (message.startsWith("HK_BAD_OUTLET")) {
    return "Only minibar and laundry are posted from housekeeping.";
  }
  if (message.startsWith("COMP_NOT_PERMITTED")) {
    return "Only a manager can make a stay complimentary or house use.";
  }
  if (message.startsWith("COMP_REASON")) {
    return "Give a reason for the complimentary or house-use stay.";
  }
  if (message.startsWith("CASHIER_NO_SHIFT")) {
    return message.includes("before taking")
      ? "Open your cash shift before taking or refunding cash (Front desk → Cash shift)."
      : "You have no open cash shift. Open one first.";
  }
  if (message.startsWith("CASHIER_SHIFT_OPEN")) {
    return "You already have an open cash shift. Close it before opening another.";
  }
  if (message.startsWith("CASHIER_SHIFT_CLOSED")) {
    return "That shift is already closed.";
  }
  if (message.startsWith("CASHIER_REASON")) {
    return "Give a reason for this cash movement.";
  }
  if (message.startsWith("CASHIER_NOT_IN_HOUSE")) {
    return "A paid-out can only be charged to a guest who is checked in.";
  }
  if (message.startsWith("CASHIER_BAD_AMOUNT:")) {
    return `Check the amount — ${message.slice("CASHIER_BAD_AMOUNT:".length).trim()}.`;
  }
  if (message.startsWith("FOLIO_DAY_CLOSED:")) {
    return `Night audit has closed ${message.slice("FOLIO_DAY_CLOSED:".length).split(" is closed")[0].trim()}, so this line can no longer be voided. Post an allowance today instead (Folio → Allowance).`;
  }
  if (message.startsWith("FOLIO_VOID_REASON")) {
    return "Give a reason for the void.";
  }
  if (message.startsWith("FOLIO_IMMUTABLE")) {
    return "A posted folio line cannot be changed or deleted. Void it the same day, or post an allowance.";
  }

  // City ledger (Module 7)
  if (message.startsWith("CITY_LEDGER_CREDIT_LIMIT:")) {
    return `Over the credit limit — ${message.slice("CITY_LEDGER_CREDIT_LIMIT:".length).trim()}. Take a payment on account, or raise the limit under Companies.`;
  }
  if (message.startsWith("CITY_LEDGER_ALREADY_TRANSFERRED")) {
    return "This bill is already on a company account. Open a new folio for anything charged since.";
  }
  if (message.startsWith("CITY_LEDGER_NOTHING_OWED")) {
    return "There is nothing left to bill on this folio.";
  }
  if (message.startsWith("CITY_LEDGER_INACTIVE")) {
    return "That company account is closed. Reactivate it under Companies first.";
  }
  if (message.startsWith("CITY_LEDGER_INVOICED")) {
    return "This charge has been invoiced. Cancel the invoice before voiding the transfer.";
  }
  if (message.startsWith("CITY_LEDGER_ALREADY_VOID")) {
    return "That entry is already voided.";
  }
  if (message.startsWith("CITY_LEDGER_VOID_REASON")) {
    return "Give a reason for voiding this entry.";
  }
  if (message.startsWith("CITY_LEDGER_NO_COMPANY")) {
    return "Choose a company to bill.";
  }
  if (message.startsWith("CITY_LEDGER_NO_FOLIO") || message.startsWith("CITY_LEDGER_NO_ENTRY")) {
    return "That record no longer exists. Refresh the page.";
  }
  if (message.startsWith("CURRENCY_BASE_RATE")) {
    return "The property's own currency is always held at a rate of 1.";
  }

  // Loyalty (Module 8)
  if (message.startsWith("LOYALTY_INSUFFICIENT:")) {
    return `Not enough points — ${message.slice("LOYALTY_INSUFFICIENT:".length).trim()}.`;
  }
  if (message.startsWith("LOYALTY_BELOW_MINIMUM:")) {
    return `Too few points — ${message.slice("LOYALTY_BELOW_MINIMUM:".length).trim()}.`;
  }
  if (message.startsWith("LOYALTY_OVER_BALANCE:")) {
    return `Worth more than the bill — ${message.slice("LOYALTY_OVER_BALANCE:".length).trim()}. Redeem fewer points.`;
  }
  if (message.startsWith("LOYALTY_NOT_A_MEMBER")) {
    return "Enrol the guest in the loyalty programme first.";
  }
  if (message.startsWith("LOYALTY_NO_REDEEM_RATE")) {
    return "This tier has no redemption rate set. Set one under Guests → Loyalty.";
  }
  if (message.startsWith("LOYALTY_NOTHING_OWED")) {
    return "There is nothing left to settle on this folio.";
  }
  if (message.startsWith("LOYALTY_POINTS_INVALID")) {
    return "Enter a whole number of points.";
  }
  if (message.startsWith("LOYALTY_REASON_REQUIRED")) {
    return "Give a reason for the correction.";
  }
  if (message.startsWith("LOYALTY_NO_TIERS")) {
    return "Set up at least one membership tier before enrolling guests.";
  }

  // Events and banquets (Module 10)
  if (message.startsWith("EVENT_SPACE_CLASH:")) {
    return `That space is already taken — ${message.slice("EVENT_SPACE_CLASH:".length).trim()}. Choose another time, another day, or hold this one as an enquiry.`;
  }
  if (message.startsWith("EVENT_OVERPAYMENT:")) {
    return `More than is owed — ${message.slice("EVENT_OVERPAYMENT:".length).trim()}. Take the balance, or record the rest as a separate payment once the event is repriced.`;
  }
  if (message.startsWith("EVENT_NOT_FOUND")) {
    return "That event no longer exists. Refresh the page.";
  }
  if (message.startsWith("EVENT_NOT_QUOTED")) {
    return "Send a quotation first, so there is a price both sides have agreed.";
  }
  if (message.startsWith("EVENT_NOTHING_QUOTED")) {
    return "Price the space, the catering or the equipment before sending a quotation.";
  }
  if (message.startsWith("EVENT_ALREADY_CONFIRMED")) {
    return "This event is past the quotation stage. Reprice it on a new event, or cancel this one.";
  }
  if (message.startsWith("EVENT_NEEDS_APPROVAL")) {
    return "This quotation is above the approval threshold. It needs a manager's approval before the date can be held.";
  }
  if (message.startsWith("EVENT_NO_APPROVAL_NEEDED")) {
    return "This quotation is below the approval threshold, so it can be confirmed as it stands.";
  }
  if (message.startsWith("EVENT_ALREADY_APPROVED")) {
    return "This quotation is already approved.";
  }
  if (message.startsWith("EVENT_SELF_APPROVAL")) {
    return "A quotation must be approved by someone other than the person who prepared it.";
  }
  if (message.startsWith("EVENT_ALREADY_BILLED")) {
    return "This event has already been billed, so its price cannot change. Cancel the bill first.";
  }
  if (message.startsWith("EVENT_INVOICED")) {
    return "This event has been invoiced. Cancel the invoice first.";
  }
  if (message.startsWith("EVENT_NOT_CONFIRMED")) {
    return "Confirm the event before billing it or closing it off.";
  }
  if (message.startsWith("EVENT_BOOKING_NOT_RESIDENT")) {
    return "An event can only be billed to a stay the guest has actually checked into.";
  }
  if (message.startsWith("EVENT_NO_BOOKING")) {
    return "Choose the stay to bill this event to.";
  }
  if (message.startsWith("EVENT_NOTHING_OWED")) {
    return "This event is already settled.";
  }
  if (message.startsWith("EVENT_CANCELLED")) {
    return "This event is cancelled. Only a refund can be recorded against it.";
  }
  if (message.startsWith("EVENT_ALREADY_CANCELLED")) {
    return "This event is already cancelled.";
  }
  if (message.startsWith("EVENT_CANCEL_REASON")) {
    return "Give a reason for cancelling.";
  }
  if (message.startsWith("EVENT_PAX_INVALID")) {
    return "Enter how many people actually attended.";
  }
  if (message.startsWith("EVENT_PAYMENT_KIND")) {
    return "Choose a deposit, a payment or a refund.";
  }
  if (message.startsWith("EVENT_PAYMENT_AMOUNT")) {
    return "Enter an amount greater than zero.";
  }
  if (message.includes("event_hold_covers_event")) {
    return "The space has to be held from before the event starts until after it ends.";
  }
  if (message.includes("event_times_ordered")) {
    return "The event has to finish after it starts.";
  }
  if (message.includes("event_has_a_client")) {
    return "Say who the event is for: a guest, a company, or a contact name.";
  }

  if (/row-level security/i.test(message)) {
    return "Your role does not allow that change.";
  }
  if (/duplicate key/i.test(message)) {
    return "That already exists.";
  }
  return message;
}

export function isOverbooked(message: string | undefined | null) {
  return Boolean(message?.startsWith("OVERBOOKED:"));
}
