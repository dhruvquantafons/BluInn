import { describe, it, expect } from "vitest";
import { occasionInStay, depositState } from "../app/lib/front-desk";

describe("occasionInStay", () => {
  it("matches a birthday during the stay, whatever the birth year", () => {
    expect(occasionInStay("1980-11-06", "2026-11-05", "2026-11-08")).toBe(true);
  });
  it("counts departure day but not the day after", () => {
    expect(occasionInStay("1990-11-08", "2026-11-05", "2026-11-08")).toBe(true);
    expect(occasionInStay("1990-11-09", "2026-11-05", "2026-11-08")).toBe(false);
  });
  it("handles a stay over New Year", () => {
    expect(occasionInStay("1975-01-01", "2026-12-30", "2027-01-02")).toBe(true);
  });
  it("takes 29 February as 28 February in a common year", () => {
    expect(occasionInStay("2000-02-29", "2027-02-27", "2027-02-28")).toBe(true);
  });
  it("is false with no date", () => {
    expect(occasionInStay(null, "2026-11-05", "2026-11-08")).toBe(false);
  });
});

describe("depositState", () => {
  it("reads none, received, due, part and overdue", () => {
    expect(depositState(0, 0, null, "2026-11-05")).toBe("none");
    expect(depositState(5000, 5000, "2026-11-01", "2026-11-05")).toBe("received");
    expect(depositState(5000, 0, "2026-11-10", "2026-11-05")).toBe("due");
    expect(depositState(5000, 1000, "2026-11-10", "2026-11-05")).toBe("part");
    expect(depositState(5000, 1000, "2026-11-01", "2026-11-05")).toBe("overdue");
  });
});
