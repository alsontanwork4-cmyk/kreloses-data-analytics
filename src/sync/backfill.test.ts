import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDataFreshness, getOverviewKpis } from "@/analytics";
import { saveConnection, testConnection } from "@/connections/service";
import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS, readFixture } from "@/kreloses/testing/fake-kreloses";

import { BACKFILL_ACTIVE_SALE_IDS, backfillFake } from "./__fixtures__/backfill-sales";
import { getSyncAlerts } from "./alerts";
import { backfillMonths, runBackfill, runBackfillChunk, type BackfillChunkResult } from "./backfill";
import { parseNightWindow, type BackfillConfig } from "./backfill-config";
import { getBackfillProgress } from "./backfill-progress";
import { pauseBackfill, readBackfill, startBackfill } from "./backfill-store";
import { handleBackfillCron } from "./cron";
import { runSync, type SyncResult } from "./engine";
import { listSyncRuns } from "./runs";
import { clearSyncTables, createSyncHarness, snapshotSyncedData, type SyncHarness } from "./test-support";

/**
 * Seam 1 (#8): the history backfill against the fake Kreloses serving `__fixtures__/backfill-sales.ts`
 * (sales in Sep 2026, Mar 2025, Dec 2024 and Jan 2024; every other month empty), writing to a
 * throwaway database. The clock starts at 00:30 on 2 Oct 2026 in Kuala Lumpur, inside the default
 * night window (00:00–06:00), so a backfill loads 1 Jan 2024 – 2 Oct 2026: 34 months, newest first.
 * Sale List pages hold 3 sales, so March 2025's seven sales take three pages.
 */
const { both, north, south } = SYNTHETIC_ACCOUNTS;
const NIGHT = new Date("2026-10-01T16:30:00Z"); // 2 Oct 2026, 00:30 in KL
const MINUTE = 60_000;
const CONFIG: BackfillConfig = { requestDelayMs: 0, maxRequestsPerNight: 2_500, nightWindow: parseNightWindow("00:00-06:00")! };
const MONTHS = backfillMonths("2024-01-01", "2026-10-02").map((month) => month.month);

function ran(result: BackfillChunkResult) {
  if (result.status !== "ran") throw new Error(`expected the chunk to run, got ${JSON.stringify(result)}`);
  return result;
}

function synced(result: SyncResult) {
  if (!("runId" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
  return result;
}

describe("History backfill", () => {
  const db = useTestDatabase();
  let h: SyncHarness;

  const harness = () => createSyncHarness(db.sql, { fake: backfillFake(), now: NIGHT });

  beforeEach(async () => {
    await clearSyncTables(db.sql);
    h = harness();
  });

  const chunk = (id: string, options: { config?: Partial<BackfillConfig>; budgetMs?: number } = {}) =>
    runBackfillChunk(h.deps(), id, { config: { ...CONFIG, ...options.config }, pageSize: 3, ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}) });
  /** Sale ids of the invoice pages requested since request number `from`, in order. */
  const pagesOpened = (from = 0) =>
    h.fake.requests
      .slice(from)
      .filter((request) => request.url.pathname.startsWith("/Sale/Overview/"))
      .map((request) => request.url.pathname.split("/").pop()!);
  /** The Sale List requests since `from`: page and date range asked for. */
  const listRequests = (from = 0) =>
    h.fake.requests
      .slice(from)
      .filter((request) => request.url.pathname === "/Sale/Get")
      .map((request) => {
        const body = JSON.parse(request.body!) as { request: { RequestingPage: number }; filter: { Filters: { Name: string; From?: string; To?: string }[] } };
        const date = body.filter.Filters.find((filter) => filter.Name === "Date")!;
        return { page: body.request.RequestingPage, from: date.From, to: date.To };
      });
  /** Every Kreloses request takes 10 s (Sale List and invoice pages; logging in is instant). */
  const slowKreloses = () =>
    h.fake.intercept((request) => {
      if (request.url.pathname === "/Sale/Get" || request.url.pathname.startsWith("/Sale/Overview/")) h.clock.advance(10_000);
      return undefined;
    });
  /** The next trigger, 15 minutes later — or the next night's first one once the window is over. */
  const nextSlot = () => {
    h.clock.advance(15 * MINUTE);
    const kl = new Date(h.clock.now.getTime() + 8 * 60 * MINUTE);
    if (kl.getUTCHours() >= 6) h.clock.now = new Date(Date.UTC(kl.getUTCFullYear(), kl.getUTCMonth(), kl.getUTCDate() + 1, 0, 5) - 8 * 60 * MINUTE);
  };
  const revenue = async (dateFrom: string, dateTo: string) => (await getOverviewKpis(db.sql, { dateFrom, dateTo })).total.revenue.value;

  /** One uninterrupted chunk loads everything; returns every synced row. */
  async function uninterrupted() {
    const id = await h.connect(both, "Both branches");
    expect(ran(await chunk(id))).toMatchObject({ stoppedBy: "complete", monthsCompleted: 34 });
    return snapshotSyncedData(db.sql);
  }

  it("loads every month from 1 Jan 2024 in one chunk when time allows: exact revenue per month, each invoice page read once", async () => {
    const id = await h.connect(both, "Both branches");
    const result = ran(await chunk(id));
    expect(result).toMatchObject({ stoppedBy: "complete", monthsCompleted: 34 });
    expect(result.runs.map((run) => run.month)).toEqual(MONTHS);
    expect(MONTHS.slice(0, 3)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(MONTHS.at(-1)).toBe("2024-01");
    expect(pagesOpened().sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());

    // Hand-computed in __fixtures__/backfill-sales.ts.
    expect(await revenue("2026-09-01", "2026-09-30")).toBe("1440.50");
    expect(await revenue("2025-03-01", "2025-03-31")).toBe("1952.40");
    expect(await revenue("2024-12-01", "2024-12-31")).toBe("125.50");
    expect(await revenue("2024-01-01", "2024-01-31")).toBe("168.20");
    expect(await revenue("2023-12-01", "2026-10-02")).toBe("3686.60"); // 802003 (31 Dec 2023) is not loaded
    expect(await db.sql`select count(*)::int as n from invoices`).toEqual([{ n: 16 }]);

    expect(await readBackfill(db.sql, id)).toMatchObject({ status: "complete", dateFrom: "2024-01-01", dateTo: "2026-10-02", completedAt: NIGHT, startedAt: NIGHT });
    // One run per month; Sync status lists them apart from the nightly and Sync now runs.
    expect(await listSyncRuns(db.sql, { limit: 100, modes: ["backfill"] })).toHaveLength(34);
    expect(await listSyncRuns(db.sql, { modes: ["nightly", "manual"] })).toEqual([]);
    // Idempotent: a complete backfill does nothing more, and running a month again changes nothing.
    const before = h.fake.requests.length;
    expect(await chunk(id)).toEqual({ status: "idle", reason: "complete" });
    expect(h.fake.requests.length).toBe(before);
    const snapshot = await snapshotSyncedData(db.sql);
    synced(await runSync(h.deps(), id, "backfill", { dateRange: { from: "2025-03-01", to: "2025-03-31" }, pageSize: 3 }));
    expect(pagesOpened(before)).toEqual([]);
    expect(await snapshotSyncedData(db.sql)).toEqual(snapshot);
  });

  it("completes across SEVERAL chunks (small time budget), newest month first, each month carrying on from its checkpoint — identical to one uninterrupted load", async () => {
    const expected = await uninterrupted();
    await clearSyncTables(db.sql);
    h = harness();
    const id = await h.connect(both, "Both branches");
    slowKreloses();

    const results: Extract<BackfillChunkResult, { status: "ran" }>[] = [];
    for (let invocation = 0; invocation < 60; invocation += 1) {
      const result = ran(await chunk(id, { budgetMs: 60_000 }));
      results.push(result);
      if (result.stoppedBy === "complete") break;
      expect(result.stoppedBy).toBe("time_limit");
      nextSlot();
    }
    expect(results.at(-1)!.stoppedBy).toBe("complete");
    expect(results.length).toBeGreaterThan(5);
    // Newest month first: the order in which months were started.
    expect([...new Set(results.flatMap((result) => result.runs.map((run) => run.month)))]).toEqual(MONTHS);

    // March 2025 (three Sale List pages) spanned several chunks, each carrying on from the page it
    // stopped at: a carried-on run lists its checkpoint page again (a no-op for headers), never page 1
    // again once page 1 was done — at most one extra listing per run.
    const march = (await listSyncRuns(db.sql, { limit: 500 })).filter((run) => run.dateFrom === "2025-03-01").reverse();
    expect(march.length).toBeGreaterThan(1);
    expect(march.slice(1).every((run, index) => run.resumedFromRunId === march[index]!.id && run.chainStartedAt?.getTime() === march[0]!.startedAt.getTime())).toBe(true);
    expect(listRequests().filter((request) => request.from === "01/03/2025").length).toBeLessThanOrEqual(3 + march.length - 1);

    // Nothing read twice, nothing missing: the same rows as one uninterrupted load.
    expect(pagesOpened().sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());
    expect(await snapshotSyncedData(db.sql)).toEqual(expected);
    expect(await revenue("2023-12-01", "2026-10-02")).toBe("3686.60");

    // "Data as of" for March 2025 is when its chain of runs started (pages read then were not read again).
    const freshness = await getDataFreshness(db.sql, { dateFrom: "2025-03-01", dateTo: "2025-03-31" });
    expect(freshness.map((branch) => branch.dataAsOf)).toEqual([march[0]!.startedAt, march[0]!.startedAt]);
  });

  it.each([
    ["the server is killed while reading an invoice page (the run stays 'running', its lease runs out)", "killed"],
    ["Kreloses fails an invoice page (the run ends 'failed' part-way)", "failed"],
  ] as const)("resumes after a crash mid-month — %s — and ends identical, nothing counted twice", async (_label, crash) => {
    const expected = await uninterrupted();
    await clearSyncTables(db.sql);
    h = harness();
    const id = await h.connect(both, "Both branches");

    // 802504 is the first sale of March 2025's second Sale List page.
    let release!: () => void;
    const hung = new Promise<void>((resolve) => (release = resolve));
    // "failed": Kreloses answers 503 to it twice (the backfill retries a request once), then works again.
    let failures = crash === "failed" ? 2 : 1;
    h.fake.intercept(async (request) => {
      if (failures === 0 || request.url.pathname !== "/Sale/Overview/802504") return undefined;
      failures -= 1;
      if (crash === "failed") return new Response("down", { status: 503 });
      await hung;
      return undefined;
    });
    const crashed = chunk(id);
    let crashedRunId: string;
    if (crash === "killed") {
      await vi.waitFor(() => expect(pagesOpened()).toContain("802504"));
      const [running] = await db.sql<{ id: string }[]>`select id::text from sync_runs where status = 'running'`;
      crashedRunId = running!.id;
      await db.sql`update connection_locks set acquired_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'`;
    } else {
      const result = ran(await crashed);
      expect(result).toMatchObject({ stoppedBy: "failed", runs: expect.arrayContaining([expect.objectContaining({ month: "2025-03", status: "failed" })]) });
      crashedRunId = result.runs.at(-1)!.runId;
    }
    // Page 1 of March was done (its invoices read), so the run stopped with page 2 as its checkpoint.
    expect(await db.sql`select checkpoint from sync_runs where id = ${crashedRunId}`).toEqual([{ checkpoint: { nextPage: 2, pageSize: 3 } }]);

    h.clock.advance(15 * MINUTE);
    const listed = h.fake.requests.length;
    const rest = ran(await chunk(id));
    expect(rest.stoppedBy).toBe("complete");
    expect(rest.runs[0]).toMatchObject({ month: "2025-03", status: "succeeded" });
    expect((await listSyncRuns(db.sql, { limit: 500 })).find((run) => run.id === rest.runs[0]!.runId)).toMatchObject({ resumedFromRunId: crashedRunId });
    expect(listRequests(listed).filter((request) => request.from === "01/03/2025").map((request) => request.page)).toEqual([2, 3]);
    // Only the page that failed (or was in flight) is opened again.
    const opened = pagesOpened();
    const again = crash === "failed" ? 2 : 1;
    expect(opened.filter((saleId) => saleId === "802504")).toHaveLength(1 + again);
    expect([...new Set(opened)].sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());
    expect(opened).toHaveLength(BACKFILL_ACTIVE_SALE_IDS.length + again);
    expect(await snapshotSyncedData(db.sql)).toEqual(expected);

    if (crash === "killed") {
      // The dead chunk's request finally comes back: its run lost the lease, so it writes nothing.
      release();
      expect(ran(await crashed)).toMatchObject({ stoppedBy: "failed" });
      expect(await snapshotSyncedData(db.sql)).toEqual(expected);
    }
  });

  describe("politeness: the night window and the per-night request budget", () => {
    it("does nothing outside the night window — not a single Kreloses request, no run — and works inside it", async () => {
      const id = await h.connect(both);
      h.clock.now = new Date("2026-10-02T02:00:00Z"); // 10:00 in KL
      const before = h.fake.requests.length;
      expect(await chunk(id)).toEqual({ status: "idle", reason: "outside_window" });
      expect(await runBackfill(h.deps(), { config: CONFIG, pageSize: 3 })).toMatchObject({ connections: [], window: { inWindow: false, nextStart: new Date("2026-10-02T16:00:00Z") } });
      // The endpoint, called with the right secret outside the window: 200, nothing done.
      const secret = "synthetic-cron-secret-0123456789";
      const response = await handleBackfillCron(new Request("http://localhost/api/cron/backfill", { headers: { Authorization: `Bearer ${secret}` } }), {
        secret,
        run: () => runBackfill(h.deps(), { config: CONFIG, pageSize: 3 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, inWindow: false, connections: [] });
      expect(h.fake.requests.length).toBe(before);
      expect(await listSyncRuns(db.sql)).toEqual([]);
      expect(await readBackfill(db.sql, id)).toMatchObject({ status: "active", dateTo: null, startedAt: null });

      // A configured window that includes 10:00 (e.g. 09:00–11:00) lets it run.
      expect(ran(await chunk(id, { config: { nightWindow: parseNightWindow("09:00-11:00")! } })).stoppedBy).toBe("complete");
    });

    it("stops at tonight's request budget, does nothing more that night, and carries on the next night", async () => {
      const id = await h.connect(both);
      // 11 requests: logging in (4) and the Location/Staff filter (1), October's Sale List page, then
      // September's first page, two of its invoice pages, its second page and one more invoice page.
      const budget = 11;
      const before = h.fake.requests.length;
      const first = ran(await chunk(id, { config: { maxRequestsPerNight: budget } }));
      const sent = h.fake.requests.length - before;
      // Every HTTP request is counted, the login's too, and none is sent past the budget.
      expect(first).toMatchObject({ stoppedBy: "request_limit", requests: budget });
      expect(sent).toBe(budget);
      expect(first.runs.map((run) => [run.month, run.status, run.counts.requests])).toEqual([
        ["2026-10", "succeeded", 6],
        ["2026-09", "partial", 5],
      ]);
      const stopped = first.runs.at(-1)!;
      expect((await listSyncRuns(db.sql)).find((run) => run.id === stopped.runId)!.warnings).toMatchObject([{ code: "backfill_request_budget" }]);

      h.clock.advance(15 * MINUTE);
      const spent = h.fake.requests.length;
      expect(await chunk(id, { config: { maxRequestsPerNight: budget } })).toEqual({ status: "idle", reason: "budget_spent" });
      expect(h.fake.requests.length).toBe(spent);

      // The next night: a fresh budget; the month it stopped in carries on from its checkpoint.
      h.clock.advance(24 * 60 * MINUTE - 15 * MINUTE);
      const next = ran(await chunk(id, { config: { maxRequestsPerNight: budget } }));
      expect(next.runs[0]).toMatchObject({ month: stopped.month });
      expect((await listSyncRuns(db.sql)).find((run) => run.id === next.runs[0]!.runId)).toMatchObject({ resumedFromRunId: stopped.runId });
    });

    it("never retries a failing login every 15 minutes, and after Kreloses asks it to slow down it waits for the next night", async () => {
      const id = await h.connect(both);
      await db.sql`update connections set status = 'failed', last_error_code = 'bad_credentials', last_error = 'Kreloses rejected this email or password.'`;
      const before = h.fake.requests.length;
      expect(await chunk(id)).toEqual({ status: "idle", reason: "login_failed" });
      expect(h.fake.requests.length).toBe(before);
      await db.sql`update connections set status = 'ok', last_error_code = null, last_error = null`;

      // Kreloses answers 429 to the Sale List: the run fails (rate_limited) …
      let limited = true;
      h.fake.intercept((request) => (limited && request.url.pathname === "/Sale/Get" ? new Response("slow down", { status: 429 }) : undefined));
      const failed = ran(await chunk(id));
      expect(failed).toMatchObject({ stoppedBy: "failed", error: expect.stringMatching(/asked the app to slow down/) });
      // … and the backfill waits for the next night, not the next chunk.
      h.clock.advance(15 * MINUTE);
      const waited = h.fake.requests.length;
      expect(await chunk(id)).toEqual({ status: "idle", reason: "failed_tonight" });
      expect(h.fake.requests.length).toBe(waited);
      limited = false;
      h.clock.advance(24 * 60 * MINUTE);
      expect(ran(await chunk(id)).stoppedBy).toBe("complete");
    });

    it("a passing problem (Kreloses down for a moment) is tried again by the next chunk", async () => {
      const id = await h.connect(both);
      let down = true;
      h.fake.intercept((request) => (down && request.url.pathname === "/Sale/Get" ? new Response("down", { status: 503 }) : undefined));
      expect(ran(await chunk(id))).toMatchObject({ stoppedBy: "failed", error: expect.stringMatching(/could not be reached or had a problem/) });
      down = false;
      h.clock.advance(15 * MINUTE);
      expect(ran(await chunk(id)).stoppedBy).toBe("complete");
    });

    it("when Kreloses asks to slow down it never waits holding the connection (even for a long Retry-After): the run stops and the backfill waits for the next night", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) =>
        request.url.pathname === "/Sale/Overview/802505" ? new Response("slow down", { status: 429, headers: { "Retry-After": "90" } }) : undefined,
      );
      const result = ran(await chunk(id));
      expect(result).toMatchObject({ stoppedBy: "failed", error: expect.stringMatching(/asked the app to slow down/) });
      expect(h.sleeps).toEqual([]);
      expect(pagesOpened().filter((saleId) => saleId === "802505")).toHaveLength(1);
      h.clock.advance(15 * MINUTE);
      expect(await chunk(id)).toEqual({ status: "idle", reason: "failed_tonight" });
    });
  });

  describe("invoice pages the app cannot read (Kreloses changed a page)", () => {
    /** These sales' pages come back in a layout the Reader does not know; returns "the app is fixed". */
    const unreadable = (...saleIds: string[]) => {
      let active = true;
      h.fake.intercept((request) => {
        const saleId = /^\/Sale\/Overview\/(\d+)$/.exec(request.url.pathname)?.[1];
        return active && saleId && saleIds.includes(saleId)
          ? new Response(readFixture("sale-overview-changed.html"), { headers: { "Content-Type": "text/html" } })
          : undefined;
      });
      return () => (active = false);
    };
    const pending = () => db.sql`select kreloses_sale_id, detail_missing_count from invoices where status = 'active' and not lines_current order by 1`;

    it("one old page it cannot read is skipped with a warning: the month and the backfill complete, that sale stays 'not synced yet' and the nightly sweep reads it once the app can", async () => {
      const id = await h.connect(both);
      const fixed = unreadable("802504");
      const result = ran(await chunk(id));
      expect(result.stoppedBy).toBe("complete");
      const march = result.runs.find((run) => run.month === "2025-03")!;
      expect(march).toMatchObject({ status: "partial", counts: { lineItemsRead: 5, lineItemsUnreadable: 1, lineItemsFailed: 0 } });
      expect((await listSyncRuns(db.sql, { limit: 100 })).find((run) => run.id === march.runId)).toMatchObject({
        warnings: [{ code: "invoice_pages_unreadable", message: expect.stringMatching(/^1 older invoice page could not be read/) }],
        coveredLocationIds: ["1101", "1102"],
      });
      expect(await readBackfill(db.sql, id)).toMatchObject({ status: "complete" });
      // Still counted at its revenue base; a page that could not be READ never uses up "missing" attempts.
      expect(await pending()).toEqual([{ krelosesSaleId: "802504", detailMissingCount: 0 }]);
      expect(await revenue("2025-03-01", "2025-03-31")).toBe("1952.40");

      fixed();
      h.clock.advance(150 * MINUTE);
      expect(synced(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "succeeded", counts: { lineItemsSwept: 1 } });
      expect(await pending()).toEqual([]);
    });

    it("still fails loudly when the first three pages it tries for the first time are all unreadable (Kreloses changed its invoice pages); pages already seen unreadable do not count again", async () => {
      const id = await h.connect(both, "Both");
      // March 2025's first three active sales: 802507 and 802505 (page 1), 802504 (page 2).
      unreadable("802507", "802505", "802504");
      const first = ran(await chunk(id));
      expect(first).toMatchObject({ stoppedBy: "failed", error: expect.stringMatching(/Kreloses answered in a way the app does not recognise/) });
      expect(first.runs.at(-1)).toMatchObject({ month: "2025-03", status: "failed", counts: { lineItemsRead: 0, lineItemsUnreadable: 3 } });
      h.clock.advance(15 * MINUTE);
      expect(await chunk(id)).toEqual({ status: "idle", reason: "failed_tonight" });

      // The next night the same three are known to be unreadable: they are skipped, the rest is read.
      h.clock.advance(24 * 60 * MINUTE);
      const next = ran(await chunk(id));
      expect(next.stoppedBy).toBe("complete");
      // (It carries on from page 2: 802504 is tried again and skipped; page 1's two are not listed again.)
      expect(next.runs[0]).toMatchObject({ month: "2025-03", status: "partial", counts: { lineItemsRead: 3, lineItemsUnreadable: 1 } });
      expect((await pending()).map((row) => row.krelosesSaleId)).toEqual(["802504", "802505", "802507"]);
    });

    it("a Sale List it cannot read still fails the run", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) =>
        request.url.pathname === "/Sale/Get" ? new Response(readFixture("sale-get-changed.json"), { headers: { "Content-Type": "application/json" } }) : undefined,
      );
      expect(ran(await chunk(id))).toMatchObject({ stoppedBy: "failed", runs: [{ month: "2026-10", status: "failed" }] });
    });
  });

  it("a Sale List whose server ignores the date filter never gives a month's total (its TotalCount would be every sale)", async () => {
    h = createSyncHarness(db.sql, { fake: { ...backfillFake(), saleList: { ...backfillFake().saleList, ignoreDateFilter: true } }, now: NIGHT });
    const id = await h.connect(both);
    // The budget runs out in March 2025, part-way through its listing.
    const result = ran(await chunk(id, { config: { maxRequestsPerNight: 45 } }));
    expect(result.stoppedBy).toBe("request_limit");
    const runs = await listSyncRuns(db.sql, { limit: 100 });
    expect(runs.filter((run) => run.counts.saleListTotal !== undefined)).toEqual([]);
    // Every sale is still stored once, on its own day (the Reader drops rows outside the month).
    const progress = (await getBackfillProgress(db.sql, { now: h.clock.now, config: CONFIG })).find((row) => row.connectionId === id)!;
    expect(progress.invoices.total).not.toBeNull();
    expect(progress.invoices.total!).toBeLessThanOrEqual(16);
  });

  describe("the nightly sync keeps priority and nothing is read twice", () => {
    it("a nightly sync in the middle of the backfill: no invoice page is opened twice by the two", async () => {
      const expected = await uninterrupted();
      await clearSyncTables(db.sql);
      h = harness();
      const id = await h.connect(both, "Both branches");
      const pending = () => db.sql`select kreloses_sale_id from invoices where status = 'active' and not lines_current order by 1`;
      // Tonight's budget (30 requests) runs out just after March 2025's first Sale List page: its
      // sales are stored, their line items not read yet.
      expect(ran(await chunk(id, { config: { maxRequestsPerNight: 30 } }))).toMatchObject({ stoppedBy: "request_limit", requests: 30 });
      expect(await pending()).toEqual([{ krelosesSaleId: "802505" }, { krelosesSaleId: "802507" }]);

      // The nightly sync (03:00 KL): its window (Sep–Oct 2026) is current already, so it opens nothing
      // there; its sweep reads the older sales left waiting.
      h.clock.advance(150 * MINUTE);
      const before = h.fake.requests.length;
      const night = synced(await runSync(h.deps(), id, "nightly"));
      expect(night).toMatchObject({ status: "succeeded", counts: { lineItemsRead: 2, lineItemsSwept: 2 } });
      expect(pagesOpened(before)).toEqual(["802507", "802505"]);
      expect(await pending()).toEqual([]);

      // The next night the backfill carries on: March's first page needs nothing more.
      h.clock.advance(24 * 60 * MINUTE);
      const rest = ran(await chunk(id));
      expect(rest).toMatchObject({ stoppedBy: "complete" });
      expect(rest.runs[0]).toMatchObject({ month: "2025-03", counts: { lineItemsRead: 4 } });
      expect(await readBackfill(db.sql, id)).toMatchObject({ status: "complete" });
      expect(pagesOpened().sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());
      expect(await snapshotSyncedData(db.sql)).toEqual(expected);
    });

    it("a backfill chunk steps aside when the nightly sync starts: it stops cleanly at its next request, the nightly runs, the next chunk carries on", async () => {
      const expected = await uninterrupted();
      await clearSyncTables(db.sql);
      h = harness();
      const id = await h.connect(both, "Both branches");
      let release!: () => void;
      const hung = new Promise<void>((resolve) => (release = resolve));
      let holding = true;
      h.fake.intercept(async (request) => {
        if (holding && request.url.pathname === "/Sale/Overview/802504") {
          holding = false;
          await hung;
        }
        return undefined;
      });
      const backfill = chunk(id);
      await vi.waitFor(() => expect(pagesOpened()).toContain("802504"));

      // The nightly cron starts while the backfill holds the connection: it asks it to yield and waits.
      const waitsForReal = async (ms: number) => {
        h.clock.advance(ms);
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      const nightly = runSync(h.deps({ sleep: waitsForReal }), id, "nightly");
      await vi.waitFor(async () => expect(await db.sql`select yield_requested_at from connection_locks`).toEqual([{ yieldRequestedAt: expect.any(Date) }]));
      release();

      const stepped = ran(await backfill);
      expect(stepped).toMatchObject({ stoppedBy: "yielded" });
      const yielded = stepped.runs.at(-1)!;
      expect(yielded).toMatchObject({ month: "2025-03", status: "partial" });
      expect((await listSyncRuns(db.sql, { limit: 100 })).find((run) => run.id === yielded.runId)).toMatchObject({
        status: "partial",
        warnings: [{ code: "backfill_yielded" }],
        checkpoint: { nextPage: 2 },
      });
      expect(synced(await nightly)).toMatchObject({ status: "succeeded" });

      h.clock.advance(15 * MINUTE);
      expect(ran(await chunk(id)).stoppedBy).toBe("complete");
      expect(pagesOpened().sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());
      expect(await snapshotSyncedData(db.sql)).toEqual(expected);
    });

    it("a chunk that finds another sync holding the connection exits at once, without a run", async () => {
      const id = await h.connect(both);
      await db.sql`insert into connection_locks (connection_id, holder, acquired_at, expires_at) values (${id}, 'sync:nightly', now(), now() + interval '4 minutes')`;
      const before = h.fake.requests.length;
      expect(await chunk(id)).toMatchObject({ status: "ran", stoppedBy: "busy", runs: [], requests: 0 });
      expect(h.fake.requests.length).toBe(before);
      expect(await listSyncRuns(db.sql)).toEqual([]);
    });

    it("backfill runs never hide a failed nightly sync (they read old months, not the nightly window)", async () => {
      const id = await h.connect(both, "Both");
      let broken = true;
      h.fake.intercept((request) =>
        broken && request.url.pathname === "/Sale/Get" && JSON.parse(request.body!).filter.Filters.find((filter: { Name: string }) => filter.Name === "Date").To === "02/10/2026"
          ? new Response(readFixture("sale-get-changed.json"), { headers: { "Content-Type": "application/json" } })
          : undefined,
      );
      expect(synced(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "failed" });
      broken = false;
      h.clock.advance(15 * MINUTE);
      const done = ran(await chunk(id));
      expect(done.runs.filter((run) => run.status === "succeeded").length).toBeGreaterThan(30);
      expect((await getSyncAlerts(db.sql)).map((alert) => alert.kind)).toEqual(["nightly_failed"]);
      h.clock.advance(15 * MINUTE);
      synced(await runSync(h.deps(), id, "nightly"));
      expect(await getSyncAlerts(db.sql)).toEqual([]);
    });
  });

  describe("starting, pausing and progress", () => {
    it("starts by itself on a connection's first successful login test (not after a failed one); a paused backfill stays paused", async () => {
      const failed = await saveConnection(h.context, { label: "North", email: north.email, password: "wrong-password" });
      expect(failed).toMatchObject({ ok: true, connection: { status: "failed" } });
      const northId = failed.ok ? failed.connection.id : "";
      expect(await readBackfill(db.sql, northId)).toBeNull();

      // The owner fixes the password: the login works, and the history backfill is asked for.
      await saveConnection(h.context, { id: northId, label: "North", email: north.email, password: north.password });
      expect(await readBackfill(db.sql, northId)).toMatchObject({ status: "active", dateFrom: "2024-01-01", dateTo: null, startedAt: null });

      await pauseBackfill(db.sql, northId);
      await testConnection(h.context, northId);
      expect(await readBackfill(db.sql, northId)).toMatchObject({ status: "paused", pausedAt: expect.any(Date) });
      expect(await chunk(northId)).toEqual({ status: "idle", reason: "paused" });
    });

    it("pause keeps its progress; start carries on from where it stopped", async () => {
      const id = await h.connect(both);
      const first = ran(await chunk(id, { config: { maxRequestsPerNight: 11 } }));
      expect(first.stoppedBy).toBe("request_limit");
      await pauseBackfill(db.sql, id);
      h.clock.advance(24 * 60 * MINUTE);
      const before = h.fake.requests.length;
      expect(await chunk(id)).toEqual({ status: "idle", reason: "paused" });
      expect(h.fake.requests.length).toBe(before);

      expect(await startBackfill(db.sql, id)).toMatchObject({ status: "active", pausedAt: null, dateTo: "2026-10-02" });
      const rest = ran(await chunk(id));
      expect(rest).toMatchObject({ stoppedBy: "complete" });
      expect(rest.runs[0]).toMatchObject({ month: first.runs.at(-1)!.month });
      // A complete backfill cannot be started again.
      expect(await startBackfill(db.sql, id)).toMatchObject({ status: "complete" });
      // One never asked for can be started by the owner.
      const southId = await h.connect(south);
      await db.sql`delete from connection_backfills where connection_id = ${southId}`;
      expect(await startBackfill(db.sql, southId)).toMatchObject({ status: "active" });
      expect(await startBackfill(db.sql, "999999")).toBeNull();
    });

    it("reports progress per connection: months, invoices done / (estimated) total, line items, requests tonight, nights left, last error", async () => {
      const id = await h.connect(both, "Both branches");
      await h.connect(north, "North only");
      await db.sql`delete from connection_backfills where connection_id <> ${id}`;
      const progress = async () => (await getBackfillProgress(db.sql, { now: h.clock.now, config: CONFIG })).find((row) => row.connectionId === id)!;

      // Not run yet: nothing known, planned up to today.
      expect(await progress()).toMatchObject({
        status: "active",
        started: false,
        dateFrom: "2024-01-01",
        dateTo: "2026-10-02",
        months: { done: 0, total: 34, current: "2026-10" },
        invoices: { done: 0, total: null, estimated: true, percent: null },
        estimatedNightsLeft: null,
        // Not started yet: nothing is "missing" (the page says it runs once the trigger is set up).
        noChunkLastNight: false,
        lastRunAt: null,
        lastError: null,
      });

      // Kreloses fails 802505's page (March 2025, page 1): the chunk stops there.
      let failing = true;
      h.fake.intercept((request) => (failing && request.url.pathname === "/Sale/Overview/802505" ? new Response("down", { status: 503 }) : undefined));
      const before = h.fake.requests.length;
      const stopped = ran(await chunk(id));
      expect(stopped.stoppedBy).toBe("failed");
      const sent = h.fake.requests.length - before;

      // Months done: Oct 2026 back to Apr 2025 (19). Invoices done: September's five (four read + one
      // cancelled), March's 802507 and 802506 (cancelled) = 7. Totals known: the 19 complete months
      // (5 stored) and March's Sale List TotalCount (7) = 12 over 20 months; the 14 months not listed
      // yet are estimated at 12 / 20 each = 8.4 → 8: total 20, 35% done.
      expect(await progress()).toMatchObject({
        status: "active",
        started: true,
        months: { done: 19, total: 34, current: "2025-03" },
        invoices: { done: 7, total: 20, estimated: true, percent: 35 },
        lineItemsRead: 5,
        night: { inWindow: true, requestsUsed: sent, requestBudget: 2_500, start: new Date("2026-10-01T16:00:00Z"), end: new Date("2026-10-01T22:00:00Z") },
        // A night does at most min(budget, what its chunks can send in time): with no pause between
        // requests (this test's settings) the budget, 2,500, binds (the defaults give 2,160: see
        // backfill-config.test.ts).
        requestsPerNight: 2_500,
        // Requests still needed: 13 invoices + one Sale List page for each of the 15 months not done = 28.
        estimatedNightsLeft: 1,
        noChunkLastNight: false,
        lastRunAt: NIGHT,
        // It failed after its one retry, 5 s later.
        lastError: { message: expect.stringMatching(/Kreloses could not be reached or had a problem/), at: new Date(NIGHT.getTime() + 5_000) },
      });
      // 28 requests at 5 a night → 6 nights.
      expect((await getBackfillProgress(db.sql, { now: h.clock.now, config: { ...CONFIG, maxRequestsPerNight: 5 } })).find((row) => row.connectionId === id)).toMatchObject({
        requestsPerNight: 5,
        estimatedNightsLeft: 6,
      });
      // The next day at noon: that night's window had a chunk. A day later, one whole night went by
      // without any chunk (is the trigger set up?).
      const stoppedAt = h.clock.now;
      h.clock.now = new Date("2026-10-02T04:00:00Z"); // 2 Oct, 12:00 KL
      expect((await progress()).noChunkLastNight).toBe(false);
      h.clock.now = new Date("2026-10-03T04:00:00Z"); // 3 Oct, 12:00 KL
      expect((await progress()).noChunkLastNight).toBe(true);
      h.clock.now = stoppedAt;

      failing = false;
      h.clock.advance(15 * MINUTE);
      expect(ran(await chunk(id)).stoppedBy).toBe("complete");
      expect(await progress()).toMatchObject({
        status: "complete",
        months: { done: 34, total: 34, current: null },
        invoices: { done: 16, total: 16, estimated: false, percent: 100 },
        lineItemsRead: 14,
        estimatedNightsLeft: 0,
        lastError: null,
      });
      // During the day: "last night's" requests.
      h.clock.now = new Date("2026-10-02T04:00:00Z"); // 12:00 KL
      expect((await progress()).night).toMatchObject({ inWindow: false, requestsUsed: expect.any(Number), nextStart: new Date("2026-10-02T16:00:00Z") });
      expect((await progress()).night.requestsUsed).toBeGreaterThan(sent);

      // A connection with no backfill.
      expect((await getBackfillProgress(db.sql, { now: h.clock.now, config: CONFIG })).find((row) => row.connectionId !== id)).toMatchObject({
        connectionLabel: "North only",
        status: "not_started",
        started: false,
      });
    });

    it("runs every active connection's chunk side by side; months another sync already read completely are skipped", async () => {
      const northId = await h.connect(north, "North");
      const southId = await h.connect(south, "South");
      // South's September 2026 was read by Sync now: the backfill does not list it again.
      synced(await runSync(h.deps(), southId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, pageSize: 3 }));
      await pauseBackfill(db.sql, northId);

      const paused = await runBackfill(h.deps(), { config: CONFIG, pageSize: 3 });
      expect(paused.connections.map((connection) => [connection.connectionLabel, connection.result.status])).toEqual([["South", "ran"]]);
      const southRuns = ran(paused.connections[0]!.result).runs.map((run) => run.month);
      expect(southRuns).not.toContain("2026-09");
      expect(southRuns).toHaveLength(33);

      await startBackfill(db.sql, northId);
      h.clock.advance(15 * MINUTE);
      const outcome = await runBackfill(h.deps(), { config: CONFIG, pageSize: 3 });
      expect(outcome.connections.map((connection) => [connection.connectionLabel, connection.result.status === "ran" && connection.result.stoppedBy])).toEqual([["North", "complete"]]);
      expect(await revenue("2023-12-01", "2026-10-02")).toBe("3686.60");
      expect(await revenue("2025-03-01", "2025-03-31")).toBe("1952.40");
    });

    it("logins that see a common branch take turns, so no invoice page is opened twice", async () => {
      const bothId = await h.connect(both, "Both");
      const northId = await h.connect(north, "North");
      const before = h.fake.requests.length;
      const outcome = await runBackfill(h.deps(), { config: CONFIG, pageSize: 3 });
      expect(outcome.connections.map((connection) => [connection.connectionId, connection.result.status === "ran" && connection.result.stoppedBy])).toEqual([
        [bothId, "complete"],
        [northId, "complete"],
      ]);
      expect(pagesOpened(before).sort()).toEqual([...BACKFILL_ACTIVE_SALE_IDS].sort());
    });
  });
});
