import { describe, expect, it } from "vitest";

import { addYears, daysBetween, formatClinicDateTime } from "./dates";

describe("formatClinicDateTime", () => {
  it("shows an instant as the clinic's local date and 24-hour time", () => {
    expect(formatClinicDateTime(new Date("2026-09-28T01:05:00Z"))).toBe("28 Sep 2026, 09:05");
  });

  it("uses the clinic's date, not UTC's, around midnight", () => {
    expect(formatClinicDateTime(new Date("2026-12-31T16:30:00Z"))).toBe("1 Jan 2027, 00:30");
  });
});

describe("addYears / daysBetween", () => {
  it("moves a date by whole years, clamping 29 February to the 28th", () => {
    expect(addYears("2026-09-28", -1)).toBe("2025-09-28");
    expect(addYears("2024-02-29", -1)).toBe("2023-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
    expect(addYears("2025-12-31", 1)).toBe("2026-12-31");
  });

  it("counts the days from one date to another", () => {
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(29);
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(0);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });
});
