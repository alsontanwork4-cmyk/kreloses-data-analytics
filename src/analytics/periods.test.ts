import { describe, expect, it } from "vitest";

import { comparisonPeriods } from "./periods";

describe("comparisonPeriods", () => {
  it("compares with the same number of days just before, and the same dates last year", () => {
    expect(comparisonPeriods({ dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toEqual({
      previousPeriod: { dateFrom: "2026-08-02", dateTo: "2026-08-31" },
      lastYear: { dateFrom: "2025-09-01", dateTo: "2025-09-30" },
    });
    // Month to date on 28 Sep: 28 days.
    expect(comparisonPeriods({ dateFrom: "2026-09-01", dateTo: "2026-09-28" }).previousPeriod).toEqual({
      dateFrom: "2026-08-04",
      dateTo: "2026-08-31",
    });
    // One day: the day before.
    expect(comparisonPeriods({ dateFrom: "2026-03-01", dateTo: "2026-03-01" }).previousPeriod).toEqual({
      dateFrom: "2026-02-28",
      dateTo: "2026-02-28",
    });
  });

  it("handles leap days", () => {
    expect(comparisonPeriods({ dateFrom: "2028-02-29", dateTo: "2028-03-01" }).lastYear).toEqual({
      dateFrom: "2027-02-28",
      dateTo: "2027-03-01",
    });
    expect(comparisonPeriods({ dateFrom: "2024-03-01", dateTo: "2024-03-31" }).previousPeriod).toEqual({
      dateFrom: "2024-01-30",
      dateTo: "2024-02-29",
    });
  });
});
