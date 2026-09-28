import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getConnectionSyncStatus } from "./index";

/** The latest sync run of every connection (MCP `data_freshness`), whatever happened to it. */
const { both, north, south } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };

describe("Analytics Service: sync status per connection", () => {
  const db = useTestDatabase();
  let h: SyncHarness;

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: new Date("2026-10-01T02:00:00Z") });
  });

  it("lists every connection by name with its login status and its latest run's outcome", async () => {
    const bothId = await h.connect(both, "Both branches");
    const northId = await h.connect(north, "North login");
    const southId = await h.connect(south, "South login");
    await h.connect(SYNTHETIC_ACCOUNTS.oneTimeCode, "Two-step login");
    expect(await getConnectionSyncStatus(db.sql)).toEqual([
      expect.objectContaining({ connectionId: bothId, label: "Both branches", loginStatus: "ok", loginError: null, lastRun: null }),
      expect.objectContaining({ connectionId: northId, label: "North login", loginStatus: "ok", lastRun: null }),
      expect.objectContaining({ connectionId: southId, label: "South login", loginStatus: "ok", lastRun: null }),
      expect.objectContaining({ label: "Two-step login", loginStatus: "failed", loginError: expect.stringMatching(/.+/), lastRun: null }),
    ]);

    // Both branches: an older run, then a successful one (the latest counts).
    await runSync(h.deps(), bothId, "manual", { dateRange: { from: "2026-08-01", to: "2026-08-31" } });
    h.clock.advance(60_000);
    const bothStarted = h.clock.now;
    await runSync(h.deps(), bothId, "manual", { dateRange: SEPTEMBER });
    const bothFinished = h.clock.now;

    // North: Kreloses is down for the sale list.
    h.clock.advance(60_000);
    let saleListDown = true;
    h.fake.intercept((request) => (saleListDown && request.url.pathname === "/Sale/Get" ? new Response("down", { status: 503 }) : undefined));
    await runSync(h.deps(), northId, "nightly", { dateRange: SEPTEMBER, maxRetries: 0 });
    saleListDown = false;

    // South: a sale is refunded in Kreloses, and its invoice page is missing; everything else is read.
    h.clock.advance(60_000);
    h.fake.saleRows.find((row) => row.SaleId === 700202)!.TotalRefunds = "150.00";
    h.fake.intercept((request) => (request.url.pathname === "/Sale/Overview/700202" ? new Response("gone", { status: 404 }) : undefined));
    await runSync(h.deps(), southId, "manual", { dateRange: SEPTEMBER });

    const [bothStatus, northStatus, southStatus] = await getConnectionSyncStatus(db.sql);
    expect(bothStatus!.lastRun).toEqual({
      mode: "manual",
      outcome: "succeeded",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      startedAt: bothStarted,
      finishedAt: bothFinished,
      error: null,
      warnings: [],
    });
    expect(northStatus!.lastRun).toMatchObject({ mode: "nightly", outcome: "failed", error: expect.stringMatching(/.+/), warnings: [] });
    expect(southStatus!.lastRun).toMatchObject({
      mode: "manual",
      outcome: "invoice_pages_missing",
      error: null,
      warnings: [expect.stringMatching(/invoice page/i)],
    });
  });

  it("says when the latest run stopped at its time limit (it did not read everything)", async () => {
    const bothId = (await getConnectionSyncStatus(db.sql)).find((status) => status.label === "Both branches")!.connectionId;
    h.fake.intercept((request) => {
      if (request.url.pathname === "/Sale/Get") h.clock.advance(10_000);
      return undefined;
    });
    expect(await runSync(h.deps(), bothId, "backfill", { dateRange: SEPTEMBER, pageSize: 4, timeBudgetMs: 15_000 })).toMatchObject({ status: "partial" });
    expect((await getConnectionSyncStatus(db.sql))[0]!.lastRun).toMatchObject({ mode: "backfill", outcome: "stopped_at_time_limit", error: null });
  });
});
