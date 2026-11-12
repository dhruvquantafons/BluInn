import { describe, expect, it } from "vitest";
import { eventRoomDefaults, RELEASE_DAYS_BEFORE } from "../app/lib/events";
import { friendlyDbError } from "../app/lib/db-errors";

// 0042: an event holds a block of guest rooms, released unsold at a cut-off.

describe("eventRoomDefaults — the room block form's starting dates", () => {
  it("covers the night of the event", () => {
    const d = eventRoomDefaults("2026-12-20", "2026-11-12");
    expect(d.checkIn).toBe("2026-12-20");
    expect(d.checkOut).toBe("2026-12-21");
  });
  it("releases unsold rooms 14 days before the event", () => {
    expect(RELEASE_DAYS_BEFORE).toBe(14);
    expect(eventRoomDefaults("2026-12-20", "2026-11-12").releaseOn).toBe("2026-12-06");
  });
  it("never sets a cut-off that has already passed", () => {
    // The event is in 5 days: the cut-off would be 9 days ago, so it is tomorrow.
    expect(eventRoomDefaults("2026-11-17", "2026-11-12").releaseOn).toBe("2026-11-13");
  });
  it("never sets a cut-off after the event itself", () => {
    expect(eventRoomDefaults("2026-11-13", "2026-11-12").releaseOn).toBe("2026-11-13");
  });
});

describe("friendlyDbError — the 0042 guards", () => {
  it("explains an event that already holds rooms", () => {
    expect(friendlyDbError("EVENT_ROOMS_HELD: this event already holds rooms; add more on its group page")).toBe(
      "This event already holds rooms; add more on its group page.",
    );
  });
  it("explains a sold-out item at the till", () => {
    expect(friendlyDbError("INVENTORY_OUT: Cola is sold out at this outlet")).toBe("Cola is sold out at this outlet.");
  });
});
