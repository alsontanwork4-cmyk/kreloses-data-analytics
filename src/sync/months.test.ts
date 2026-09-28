import { describe, expect, it } from "vitest";

import { describeSyncResult, monthLabel, monthRange, syncMonthOptions } from "./months";

describe("Sync now: months and messages", () => {
  it("turns a month into its clinic days", () => {
    expect(monthRange("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("2026-9")).toBeNull();
    expect(monthRange("drop table")).toBeNull();
    expect(monthLabel("2026-09")).toBe("September 2026");
  });

  it("offers the current clinic month first, back to January 2024", () => {
    const options = syncMonthOptions(new Date("2026-08-31T17:00:00Z")); // 1 Sep 2026 01:00 in KL
    expect(options[0]).toEqual({ value: "2026-09", label: "September 2026" });
    expect(options[1]).toEqual({ value: "2026-08", label: "August 2026" });
    expect(options.at(-1)).toEqual({ value: "2024-01", label: "January 2024" });
    expect(options).toHaveLength(33);
  });

  it("says what a sync did", () => {
    const counts = { pages: 1, invoicesSeen: 11, inserted: 11, updated: 0, unchanged: 0 };
    expect(describeSyncResult({ status: "succeeded", runId: "1", counts }, "September 2026")).toEqual({
      tone: "ok",
      message: "Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged).",
    });
    expect(
      describeSyncResult({ status: "failed", runId: "1", counts, error: { code: "transient", message: "Kreloses could not be reached." } }, "September 2026"),
    ).toEqual({ tone: "error", message: "Sync of September 2026 failed. Kreloses could not be reached." });
    expect(describeSyncResult({ status: "busy", heldFor: "sync", until: new Date() }, "x").message).toMatch(/already running/);
  });
});
