import { describe, expect, it } from "vitest";

import { addDays, addYears, daysBetween, endOfMonth, formatClinicDateTime, isIsoDate } from "./dates";

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

  it("keeps years below 100 as they are (Date.UTC would read 99 as 1999)", () => {
    expect(addYears("0100-06-15", -1)).toBe("0099-06-15");
    expect(addYears("0099-06-15", 1)).toBe("0100-06-15");
    // 104 is a leap year and 103 is not: the 29 Feb clamp still applies.
    expect(addYears("0104-02-29", -1)).toBe("0103-02-28");
    expect(addYears("0096-02-29", 8)).toBe("0104-02-29");
    expect(isIsoDate("0050-01-01")).toBe(true);
    expect(isIsoDate("0099-02-29")).toBe(false);
    expect(addDays("0100-01-01", -1)).toBe("0099-12-31");
    expect(endOfMonth("0096-02-10")).toBe("0096-02-29");
  });

  it("counts the days from one date to another", () => {
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(29);
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(0);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });
});
