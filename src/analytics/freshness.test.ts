import { beforeEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getDataFreshness } from "./index";

/**
 * "Data as of" per branch: the latest succeeded run that read the period's last day — as far as
 * the run could, i.e. up to the day it started. Syncing an old month never makes the current
 * month look fresh.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const DAY = 86_400_000;

describe("Analytics Service: data as of", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let id: string;

  beforeEach(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: new Date("2026-10-01T02:00:00Z") }); // 1 Oct 2026, 10:00 KL
    id = await h.connect(both);
  });

  const asOf = async (filter: { dateFrom?: string; dateTo?: string } = {}) =>
    Object.fromEntries((await getDataFreshness(db.sql, filter)).map((branch) => [branch.branchName, branch.dataAsOf]));

  it("counts only runs that read the period's last day (syncing an old month does not refresh the current one)", async () => {
    await runSync(h.deps(), id, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    const september2026 = h.clock.now;
    h.clock.advance(30 * DAY); // 31 Oct 2026
    await runSync(h.deps(), id, "manual", { dateRange: { from: "2025-09-01", to: "2025-09-30" } });
    const september2025 = h.clock.now;

    expect(await asOf({ dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toEqual({
      "Branch North": september2026,
      "Branch South": september2026,
    });
    expect(await asOf({ dateFrom: "2025-09-01", dateTo: "2025-09-30" })).toEqual({
      "Branch North": september2025,
      "Branch South": september2025,
    });
    // October 2026 was never synced.
    expect(await asOf({ dateFrom: "2026-10-01", dateTo: "2026-10-31" })).toEqual({ "Branch North": null, "Branch South": null });
    // Without dates: data for "now", i.e. runs that read the day they ran. Neither did.
    expect(await asOf()).toEqual({ "Branch North": null, "Branch South": null });
  });

  it("a run vouches for its days only up to the day it started", async () => {
    h.clock.now = new Date("2026-10-10T02:00:00Z"); // 10 Oct 2026
    await runSync(h.deps(), id, "manual", { dateRange: { from: "2026-10-01", to: "2026-10-31" } });
    const tenth = h.clock.now;

    // Month to date on 10 Oct and the whole of October: the run read up to 10 Oct.
    expect(await asOf({ dateFrom: "2026-10-01", dateTo: "2026-10-10" })).toMatchObject({ "Branch North": tenth });
    expect(await asOf({ dateFrom: "2026-10-01", dateTo: "2026-10-31" })).toMatchObject({ "Branch North": tenth });
    expect(await asOf()).toMatchObject({ "Branch North": tenth });
    // A range ending before the run's range: not covered.
    expect(await asOf({ dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toMatchObject({ "Branch North": null });
  });
});
