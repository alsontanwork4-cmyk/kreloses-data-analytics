import { describe, expect, it } from "vitest";

import {
  BACKFILL_CHUNK_BUDGET_MS,
  backfillConfigFromEnv,
  estimatedNights,
  formatNightWindow,
  nightWindowAt,
  parseNightWindow,
} from "./backfill-config";
import { backfillMonths } from "./backfill";

/** The backfill's politeness settings and the night window maths (#8, spec story 11). */
describe("backfill settings", () => {
  it("defaults: 2 s between requests, 2,500 requests a night per login, 00:00–06:00 Kuala Lumpur time", () => {
    expect(backfillConfigFromEnv({})).toEqual({ requestDelayMs: 2_000, maxRequestsPerNight: 2_500, nightWindow: { startMinute: 0, endMinute: 360 } });
  });

  it("reads the environment, clamps out-of-range numbers and ignores unreadable values", () => {
    expect(
      backfillConfigFromEnv({ BACKFILL_REQUEST_DELAY_SECONDS: "3.5", BACKFILL_MAX_REQUESTS_PER_NIGHT: "1200", BACKFILL_NIGHT_WINDOW: "22:30-05:00" }),
    ).toEqual({ requestDelayMs: 3_500, maxRequestsPerNight: 1_200, nightWindow: { startMinute: 1350, endMinute: 300 } });
    expect(backfillConfigFromEnv({ BACKFILL_REQUEST_DELAY_SECONDS: "0", BACKFILL_MAX_REQUESTS_PER_NIGHT: "1" })).toMatchObject({ requestDelayMs: 500, maxRequestsPerNight: 50 });
    expect(backfillConfigFromEnv({ BACKFILL_REQUEST_DELAY_SECONDS: "999", BACKFILL_MAX_REQUESTS_PER_NIGHT: "9999999" })).toMatchObject({ requestDelayMs: 30_000, maxRequestsPerNight: 50_000 });
    expect(backfillConfigFromEnv({ BACKFILL_REQUEST_DELAY_SECONDS: "gentle", BACKFILL_MAX_REQUESTS_PER_NIGHT: "", BACKFILL_NIGHT_WINDOW: "night" })).toEqual(backfillConfigFromEnv({}));
    for (const bad of ["06:00-06:00", "25:00-06:00", "00:60-06:00", "24:00-06:00", "0-6", ""]) expect(parseNightWindow(bad), bad).toBeNull();
    expect(parseNightWindow("20:00-24:00")).toEqual({ startMinute: 1200, endMinute: 1440 });
    expect(formatNightWindow({ startMinute: 1350, endMinute: 300 })).toBe("22:30–05:00");
  });

  it("knows whether a moment is inside the night window (in Kuala Lumpur, whatever the server's zone), and when the next one starts", () => {
    const window = parseNightWindow("00:00-06:00")!;
    // 2 Oct 2026 00:30 KL = 1 Oct 16:30 UTC.
    expect(nightWindowAt(new Date("2026-10-01T16:30:00Z"), window)).toEqual({
      start: new Date("2026-10-01T16:00:00Z"),
      end: new Date("2026-10-01T22:00:00Z"),
      inWindow: true,
      nextStart: new Date("2026-10-01T16:00:00Z"),
    });
    // 06:00 KL: the window is over (the end is exclusive); last night's is reported, the next starts at midnight.
    expect(nightWindowAt(new Date("2026-10-01T22:00:00Z"), window)).toMatchObject({ inWindow: false, start: new Date("2026-10-01T16:00:00Z"), nextStart: new Date("2026-10-02T16:00:00Z") });
    expect(nightWindowAt(new Date("2026-10-01T15:59:59Z"), window)).toMatchObject({ inWindow: false, nextStart: new Date("2026-10-01T16:00:00Z") });

    // A window across midnight: 22:00–05:00.
    const late = parseNightWindow("22:00-05:00")!;
    expect(nightWindowAt(new Date("2026-10-01T15:00:00Z"), late)).toMatchObject({ inWindow: true, start: new Date("2026-10-01T14:00:00Z"), end: new Date("2026-10-01T21:00:00Z") }); // 23:00 KL
    expect(nightWindowAt(new Date("2026-10-01T20:59:00Z"), late)).toMatchObject({ inWindow: true, start: new Date("2026-10-01T14:00:00Z") }); // 04:59 KL next day
    expect(nightWindowAt(new Date("2026-10-02T04:00:00Z"), late)).toMatchObject({ inWindow: false, start: new Date("2026-10-01T14:00:00Z"), nextStart: new Date("2026-10-02T14:00:00Z") }); // noon KL
  });

  it("the defaults spread ~35,000 invoice pages over about a week of nights", () => {
    const { maxRequestsPerNight, requestDelayMs } = backfillConfigFromEnv({});
    // Two branch logins, ~17,500 invoice pages each, in 2,500-request nights: 7 nights at the budget.
    expect(estimatedNights(17_500, maxRequestsPerNight)).toBe(7);
    // The time limit caps a night lower: 24 chunks of 240 s at about 2.5 s a request (2 s pause +
    // ~0.5 s answer) ≈ 2,300 requests, so ~8 nights in practice.
    const chunks = (6 * 60) / 15;
    const perNightByTime = Math.floor((chunks * BACKFILL_CHUNK_BUDGET_MS) / (requestDelayMs + 500));
    expect(perNightByTime).toBe(2_304);
    expect(estimatedNights(17_500, Math.min(perNightByTime, maxRequestsPerNight))).toBe(8);
    expect(estimatedNights(0, 2_500)).toBe(0);
    expect(estimatedNights(1, 2_500)).toBe(1);
  });

  it("plans months newest first, clipped to the backfill's dates", () => {
    expect(backfillMonths("2024-01-01", "2024-03-10")).toEqual([
      { month: "2024-03", from: "2024-03-01", to: "2024-03-10" },
      { month: "2024-02", from: "2024-02-01", to: "2024-02-29" },
      { month: "2024-01", from: "2024-01-01", to: "2024-01-31" },
    ]);
    expect(backfillMonths("2024-01-01", "2026-10-02")).toHaveLength(34);
    expect(backfillMonths("2024-01-15", "2024-01-20")).toEqual([{ month: "2024-01", from: "2024-01-15", to: "2024-01-20" }]);
  });
});
