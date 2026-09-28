import { describe, expect, it } from "vitest";

import { formatClinicDateTime } from "./dates";

describe("formatClinicDateTime", () => {
  it("shows an instant as the clinic's local date and 24-hour time", () => {
    expect(formatClinicDateTime(new Date("2026-09-28T01:05:00Z"))).toBe("28 Sep 2026, 09:05");
  });

  it("uses the clinic's date, not UTC's, around midnight", () => {
    expect(formatClinicDateTime(new Date("2026-12-31T16:30:00Z"))).toBe("1 Jan 2027, 00:30");
  });
});
