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
    const counts = { pages: 1, invoicesSeen: 11, inserted: 11, updated: 0, unchanged: 0, lineItemsRead: 9, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0, lineItemsUnreadable: 0 };
    expect(describeSyncResult({ status: "succeeded", runId: "1", counts, warnings: [] }, "September 2026")).toEqual({
      tone: "ok",
      message: "Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged); line items read for 9 invoices.",
    });
    expect(
      describeSyncResult(
        { status: "failed", runId: "1", counts, error: { code: "transient", message: "Kreloses could not be reached." }, warnings: [] },
        "September 2026",
      ),
    ).toEqual({ tone: "error", message: "Sync of September 2026 failed. Kreloses could not be reached." });
    expect(describeSyncResult({ status: "busy", heldFor: "sync", until: new Date() }, "x").message).toMatch(/already running/);
    // "Sync now" resumes a stopped month, so this is what really happens next.
    expect(
      describeSyncResult({ status: "partial", runId: "1", counts: { ...counts, invoicesSeen: 8 }, warnings: [], stoppedAtTimeLimit: true }, "September 2026"),
    ).toEqual({
      tone: "warning",
      message: "Stopped September 2026 at the time limit after 8 invoices. Sync September 2026 again to carry on from where it stopped.",
    });
  });

  it("says so when everything was read but some invoice pages could not be opened, and passes on other warnings", () => {
    const counts = { pages: 1, invoicesSeen: 11, inserted: 11, updated: 0, unchanged: 0, lineItemsRead: 7, lineItemsFailed: 2, lineItemGaps: 0, lineItemsSwept: 0, lineItemsUnreadable: 0 };
    const missing = { code: "invoice_pages_missing" as const, message: "2 invoice pages could not be opened." };
    expect(describeSyncResult({ status: "partial", runId: "1", counts, warnings: [missing], stoppedAtTimeLimit: false }, "September 2026")).toEqual({
      tone: "warning",
      message:
        "Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged); line items read for 7 invoices. 2 invoice pages could not be opened.",
    });
    const staff = { code: "staff_list_unreadable" as const, message: "The staff list could not be read." };
    expect(
      describeSyncResult({ status: "succeeded", runId: "1", counts: { ...counts, lineItemsRead: 9, lineItemsFailed: 0 }, warnings: [staff] }, "September 2026"),
    ).toEqual({
      tone: "warning",
      message: "Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged); line items read for 9 invoices. The staff list could not be read.",
    });
  });
});
