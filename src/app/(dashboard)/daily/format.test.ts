import { describe, expect, it } from "vitest";

import { dailyChangeSentence, describeDailyChange, formatDayWithWeekday } from "./format";

describe("Daily page wording", () => {
  it("names the day with its weekday", () => {
    expect(formatDayWithWeekday("2026-09-27")).toBe("Sunday 27 Sep 2026");
    expect(formatDayWithWeekday("2025-09-27", "short")).toBe("Sat 27 Sep 2025");
    expect(formatDayWithWeekday("2028-02-29")).toBe("Tuesday 29 Feb 2028");
  });

  it("a change with a percentage: signed amount and percentage, direction from the sign", () => {
    const up = describeDailyChange({ base: "750.00", change: "375.00", changePercent: 50 }, "money", "1125.00", "last week");
    expect(up).toEqual({ direction: "up", amount: "+RM 375.00", percent: "+50.0%", note: null });
    expect(dailyChangeSentence(up, "last week")).toBe("+RM 375.00 (+50.0%) vs last week");
    expect(describeDailyChange({ base: "1000.00", change: "-718.75", changePercent: -71.9 }, "money", "281.25", "last year")).toEqual({
      direction: "down",
      amount: "−RM 718.75",
      percent: "−71.9%",
      note: null,
    });
    expect(describeDailyChange({ base: 1, change: 0, changePercent: 0 }, "count", 1, "last week")).toEqual({ direction: "flat", amount: "0", percent: "0.0%", note: null });
  });

  it("a zero base: the amount, and no percentage of nothing", () => {
    const fromNothing = describeDailyChange({ base: "0.00", change: "585.00", changePercent: null }, "money", "585.00", "last year");
    expect(fromNothing).toEqual({ direction: "up", amount: "+RM 585.00", percent: null, note: "none last year" });
    expect(dailyChangeSentence(fromNothing, "last year")).toBe("+RM 585.00 vs last year (none then)");
    // A return (negative revenue) on a day with nothing to compare with.
    expect(describeDailyChange({ base: "0.00", change: "-120.00", changePercent: null }, "money", "-120.00", "last week").direction).toBe("down");
    const neither = describeDailyChange({ base: 0, change: 0, changePercent: null }, "count", 0, "last week");
    expect(neither).toEqual({ direction: "none", amount: null, percent: null, note: "none on either day" });
    expect(dailyChangeSentence(neither, "last week")).toBe("None on either day");
  });

  it("AOV without customers on one side has no change", () => {
    expect(describeDailyChange({ base: null, change: null, changePercent: null }, "money", "292.50", "last year")).toEqual({
      direction: "none",
      amount: null,
      percent: null,
      note: "no customers last year",
    });
    const none = describeDailyChange({ base: "100.00", change: null, changePercent: null }, "money", null, "last week");
    expect(dailyChangeSentence(none, "last week")).toBe("No customers this day");
  });
});
