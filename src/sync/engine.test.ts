import { beforeEach, describe, expect, it, vi } from "vitest";

import { acquireConnectionLease } from "@/connections/lock";
import { deleteConnection, listConnections } from "@/connections/service";
import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS, readFixture } from "@/kreloses/testing/fake-kreloses";

import { runSync, type SyncResult } from "./engine";
import { listSyncRuns } from "./runs";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "./test-support";

/**
 * Seam 1 (Sync Engine): the real Reader against the fake Kreloses serving the synthetic Sale List
 * (`src/kreloses/__fixtures__/sale-list-rows.json`), writing to a throwaway database.
 */
const { north, both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };

function ran(result: SyncResult) {
  if (!("runId" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
  return result;
}

describe("Sync Engine", () => {
  const db = useTestDatabase();
  let h: SyncHarness;

  beforeEach(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql);
  });

  const invoiceRows = () => db.sql`select * from invoices order by kreloses_sale_id`;

  it("reads a month of the Sale List into invoices, branches and customers, and records the run", async () => {
    const id = await h.connect(both, "Both branches");
    const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, pageSize: 4 }));

    expect(result).toMatchObject({
      status: "succeeded",
      counts: { pages: 3, invoicesSeen: 11, inserted: 11, updated: 0, unchanged: 0 },
    });

    const branches = await db.sql`select kreloses_location_id, name, connection_id::text from branches order by kreloses_location_id`;
    expect(branches).toEqual([
      { krelosesLocationId: "1101", name: "Branch North", connectionId: id },
      { krelosesLocationId: "1102", name: "Branch South", connectionId: id },
    ]);
    const customers = await db.sql`select kreloses_customer_id, name, first_seen_date from customers order by kreloses_customer_id`;
    expect(customers).toEqual([
      { krelosesCustomerId: "90001", name: "Customer 0001", firstSeenDate: "2026-09-01" },
      { krelosesCustomerId: "90002", name: "Customer 0002", firstSeenDate: "2026-09-05" },
      { krelosesCustomerId: "90003", name: "Customer 0003", firstSeenDate: "2026-09-20" },
      { krelosesCustomerId: "90004", name: "Customer 0004", firstSeenDate: "2026-09-02" },
      { krelosesCustomerId: "90005", name: "Customer 0005", firstSeenDate: "2026-09-15" },
      { krelosesCustomerId: "90006", name: "Customer 0006", firstSeenDate: "2026-09-25" },
    ]);

    const [first] = await db.sql`
      select i.kreloses_sale_id, i.sale_number, b.kreloses_location_id, c.kreloses_customer_id, i.sale_at, i.sale_date,
        i.status, i.status_name, i.gross_amount, i.discount_amount, i.net_amount, i.tax_amount, i.total_amount,
        i.payment_status, i.total_payments, i.total_refunds, i.raw_header ->> 'SaleDate' as raw_sale_date,
        i.sync_run_id::text, i.fetched_at, i.detail_fetched_at
      from invoices i join branches b on b.id = i.branch_id left join customers c on c.id = i.customer_id
      where i.kreloses_sale_id = '700101'
    `;
    expect(first).toEqual({
      krelosesSaleId: "700101",
      saleNumber: "INV-N-0101",
      krelosesLocationId: "1101",
      krelosesCustomerId: "90001",
      saleAt: new Date("2026-08-31T16:30:00Z"),
      saleDate: "2026-09-01",
      status: "active",
      statusName: "Active",
      grossAmount: "1250.00",
      discountAmount: "50.00",
      netAmount: "1200.00",
      taxAmount: "0.00",
      totalAmount: "1200.00",
      paymentStatus: "Paid",
      totalPayments: "1200.00",
      totalRefunds: "0.00",
      rawSaleDate: "/Date(1788193800000)/",
      syncRunId: result.runId,
      fetchedAt: h.clock.now,
      detailFetchedAt: null,
    });
    const [returned] = await db.sql`select net_amount, total_refunds, customer_id from invoices where kreloses_sale_id = '700206'`;
    expect(returned).toMatchObject({ netAmount: "-120.00", totalRefunds: "120.00" });
    const [walkIn] = await db.sql`select customer_id from invoices where kreloses_sale_id = '700205'`;
    expect(walkIn).toEqual({ customerId: null });

    const [run] = await listSyncRuns(db.sql);
    expect(run).toEqual({
      id: result.runId,
      connectionId: id,
      connectionLabel: "Both branches",
      mode: "manual",
      status: "succeeded",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      startedAt: h.clock.now,
      finishedAt: h.clock.now,
      counts: { pages: 3, invoicesSeen: 11, inserted: 11, updated: 0, unchanged: 0 },
      checkpoint: null,
      coveredLocationIds: ["1101", "1102"],
      errorCode: null,
      error: null,
    });
  });

  it("syncs the current clinic month by default (in Kuala Lumpur time, not UTC)", async () => {
    const id = await h.connect(both);
    h.clock.now = new Date("2026-08-31T17:00:00Z"); // 1 Sep 2026, 01:00 in KL
    const result = ran(await runSync(h.deps(), id, "manual"));
    expect(result.counts.invoicesSeen).toBe(11);
    const [run] = await listSyncRuns(db.sql);
    expect(run).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  });

  it("is idempotent: running the same sync again changes nothing", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, pageSize: 4 }));
    const before = await invoiceRows();
    const customersBefore = await db.sql`select * from customers order by id`;
    const branchesBefore = await db.sql`select * from branches order by id`;

    h.clock.advance(60_000);
    const again = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, pageSize: 4 }));
    expect(again).toMatchObject({
      status: "succeeded",
      counts: { pages: 3, invoicesSeen: 11, inserted: 0, updated: 0, unchanged: 11 },
    });
    expect(await invoiceRows()).toEqual(before);
    expect(await db.sql`select * from customers order by id`).toEqual(customersBefore);
    expect(await db.sql`select * from branches order by id`).toEqual(branchesBefore);
  });

  it("picks up edited, cancelled and refunded invoices on the next run", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));

    const row = (saleId: number) => h.fake.saleRows.find((candidate) => candidate.SaleId === saleId)!;
    row(700102).SaleStatusName = "Cancelled";
    row(700202).TotalRefunds = "200.00";
    h.clock.advance(3_600_000);
    const next = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));

    expect(next.counts).toEqual({ pages: 1, invoicesSeen: 11, inserted: 0, updated: 2, unchanged: 9 });
    const changed = await db.sql`
      select kreloses_sale_id, status, total_refunds, sync_run_id::text, fetched_at from invoices
      where kreloses_sale_id in ('700102', '700202') order by kreloses_sale_id
    `;
    expect(changed).toEqual([
      { krelosesSaleId: "700102", status: "cancelled", totalRefunds: "0.00", syncRunId: next.runId, fetchedAt: h.clock.now },
      { krelosesSaleId: "700202", status: "active", totalRefunds: "200.00", syncRunId: next.runId, fetchedAt: h.clock.now },
    ]);
  });

  it("shares rows between connections that see the same branch (Kreloses ids are global)", async () => {
    const northId = await h.connect(north, "North only");
    const bothId = await h.connect(both, "Both");
    expect(ran(await runSync(h.deps(), northId, "manual", { dateRange: SEPTEMBER })).counts).toMatchObject({ inserted: 5 });
    expect(ran(await runSync(h.deps(), bothId, "manual", { dateRange: SEPTEMBER })).counts).toMatchObject({
      inserted: 6,
      unchanged: 5,
    });
    expect(await db.sql`select 1 from invoices`).toHaveLength(11);
    expect(await db.sql`select 1 from branches`).toHaveLength(2);
  });

  describe("failures are recorded as failed runs", () => {
    it("a Sale List layout change fails the run loudly and writes nothing", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) =>
        request.url.pathname === "/Sale/Get" ? new Response(readFixture("sale-get-changed.json"), { headers: { "Content-Type": "application/json" } }) : undefined,
      );
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "failed", error: { code: "layout_changed" } });
      expect(result.error!.message).toMatch(/Kreloses answered in a way the app does not recognise \(Sale\/Get: no Results list/);

      const [run] = await listSyncRuns(db.sql);
      expect(run).toMatchObject({ status: "failed", errorCode: "layout_changed", finishedAt: h.clock.now, coveredLocationIds: [] });
      expect(run!.error).toBe(result.error!.message);
      expect(await db.sql`select 1 from invoices`).toHaveLength(0);
      // The login itself worked, so the connection is still Connected.
      expect((await listConnections(db.sql))[0]).toMatchObject({ status: "ok" });
    });

    it("a rejected login fails the run and marks the connection failed", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) =>
        request.method === "POST" && request.url.pathname === "/account/login"
          ? new Response(readFixture("login-failed.html"), { headers: { "Content-Type": "text/html" } })
          : undefined,
      );
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "failed", error: { code: "auth_failed" } });
      expect(result.error!.message).toMatch(/Kreloses rejected this email or password/);
      expect((await listConnections(db.sql))[0]).toMatchObject({ status: "failed", lastErrorCode: "bad_credentials", visibleLocations: [] });
      expect(await listSyncRuns(db.sql)).toMatchObject([{ status: "failed", errorCode: "auth_failed" }]);
    });

    it("logs in again once when the session expires mid-run", async () => {
      const id = await h.connect(both);
      let saleGets = 0;
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get" && ++saleGets === 2) h.fake.expireSessions();
        return undefined;
      });
      const loginsBefore = h.fake.requests.filter((request) => request.method === "POST" && request.url.pathname === "/account/login").length;
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, pageSize: 4 }));
      expect(result).toMatchObject({ status: "succeeded", counts: { pages: 3, inserted: 11 } });
      const logins = h.fake.requests.filter((request) => request.method === "POST" && request.url.pathname === "/account/login").length;
      expect(logins - loginsBefore).toBe(2);
    });

    it("gives up, and marks the connection failed, when the session keeps expiring", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get") h.fake.expireSessions();
        return undefined;
      });
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "failed", error: { code: "auth_failed" } });
      expect((await listConnections(db.sql))[0]).toMatchObject({ status: "failed", lastErrorCode: "session_expired" });
    });

    it("retries Kreloses's temporary trouble with backoff, honouring Retry-After", async () => {
      const id = await h.connect(both);
      let saleGets = 0;
      h.fake.intercept((request) => {
        if (request.url.pathname !== "/Sale/Get") return undefined;
        saleGets += 1;
        if (saleGets === 1) return new Response("Service Unavailable", { status: 503 });
        if (saleGets === 2) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "7" } });
        return undefined;
      });
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "succeeded", counts: { inserted: 11 } });
      expect(h.sleeps).toEqual([5_000, 7_000]);
    });

    it("fails, to be retried by the next sync, when Kreloses stays unreachable", async () => {
      const id = await h.connect(both);
      let saleGets = 0;
      h.fake.intercept((request) => (request.url.pathname === "/Sale/Get" && ++saleGets ? new Response("down", { status: 502 }) : undefined));
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, maxRetries: 2 }));
      expect(result).toMatchObject({ status: "failed", error: { code: "transient" } });
      expect(result.error!.message).toMatch(/HTTP 502.*The next sync will try again/);
      expect(saleGets).toBe(3);
      expect((await listConnections(db.sql))[0]).toMatchObject({ status: "ok" });
    });

    it("an unexpected error is recorded too", async () => {
      const id = await h.connect(both);
      const result = ran(
        await runSync(
          h.deps({
            reader: {
              listLocations: async () => [{ id: "1101", name: "Branch North" }],
              listInvoices: async () => {
                throw new TypeError("a bug");
              },
            },
          }),
          id,
          "manual",
          { dateRange: SEPTEMBER },
        ),
      );
      expect(result).toMatchObject({ status: "failed", error: { code: "internal" } });
      expect(await listSyncRuns(db.sql)).toMatchObject([{ status: "failed", errorCode: "internal" }]);
    });
  });

  describe("one Kreloses session per connection", () => {
    it("refuses to start while another sync or a login test holds the connection", async () => {
      const id = await h.connect(both);
      await acquireConnectionLease(db.sql, id, { purpose: "sync", ttlMs: 60_000, now: h.clock.now });
      const requests = h.fake.requests.length;
      expect(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER })).toEqual({
        status: "busy",
        heldFor: "sync",
        until: new Date(h.clock.now.getTime() + 60_000),
      });
      expect(h.fake.requests.length).toBe(requests);
      expect(await listSyncRuns(db.sql)).toEqual([]);
    });

    it("turns away a second sync while one runs, and runs again once it has finished", async () => {
      const id = await h.connect(both);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      h.fake.intercept(async (request) => {
        if (request.url.pathname === "/Sale/Get") await gate;
        return undefined;
      });

      const first = runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER });
      await vi.waitFor(async () => expect(await db.sql`select 1 from sync_runs where status = 'running'`).toHaveLength(1));
      expect(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER })).toMatchObject({ status: "busy", heldFor: "sync" });

      open();
      expect(ran(await first).status).toBe("succeeded");
      expect(ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER })).status).toBe("succeeded");
      expect(await listSyncRuns(db.sql)).toHaveLength(2);
    });

    it("marks a run that never finished (the server died) as interrupted", async () => {
      const id = await h.connect(both);
      await db.sql`
        insert into sync_runs (connection_id, connection_label, mode, date_from, date_to, started_at)
        values (${id}, 'Both', 'nightly', '2026-09-01', '2026-09-30', ${new Date(h.clock.now.getTime() - 3_600_000)})
      `;
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      const runs = await listSyncRuns(db.sql);
      expect(runs.map((run) => [run.mode, run.status, run.errorCode])).toEqual([
        ["manual", "succeeded", null],
        ["nightly", "failed", "interrupted"],
      ]);
    });

    it("says so for a connection that does not exist", async () => {
      expect(await runSync(h.deps(), "424242", "manual", { dateRange: SEPTEMBER })).toEqual({ status: "not_found" });
    });
  });

  it("stops cleanly at its time budget and records where to carry on", async () => {
    const id = await h.connect(both);
    h.fake.intercept((request) => {
      if (request.url.pathname === "/Sale/Get") h.clock.advance(10_000);
      return undefined;
    });
    const result = ran(await runSync(h.deps(), id, "backfill", { dateRange: SEPTEMBER, pageSize: 4, timeBudgetMs: 15_000 }));
    expect(result).toMatchObject({ status: "partial", counts: { pages: 2, invoicesSeen: 8, inserted: 8 } });
    const [run] = await listSyncRuns(db.sql);
    expect(run).toMatchObject({ status: "partial", checkpoint: { nextPage: 3, pageSize: 4 }, errorCode: null, coveredLocationIds: [] });
    expect(await db.sql`select 1 from invoices`).toHaveLength(8);

    // Carrying on from the checkpoint reads the rest.
    const rest = ran(await runSync(h.deps(), id, "backfill", { dateRange: SEPTEMBER, pageSize: 4, startPage: 3 }));
    expect(rest).toMatchObject({ status: "succeeded", counts: { pages: 1, inserted: 3 } });
    expect(await db.sql`select 1 from invoices`).toHaveLength(11);
  });

  it("keeps synced sales when the connection is deleted", async () => {
    const id = await h.connect(both, "Both branches");
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect(await deleteConnection(db.sql, id)).toBe(true);

    expect(await db.sql`select 1 from invoices`).toHaveLength(11);
    expect(await db.sql`select connection_id from branches`).toEqual([{ connectionId: null }, { connectionId: null }]);
    expect(await listSyncRuns(db.sql)).toMatchObject([{ connectionId: null, connectionLabel: "Both branches", status: "succeeded" }]);
  });

  it("brings a connection back to Connected when a sync logs in fine", async () => {
    const id = await h.connect(both);
    await db.sql`
      update connections set status = 'failed', last_error_code = 'unreachable', last_error = 'was down', visible_locations = '[]'
      where id = ${id}
    `;
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect((await listConnections(db.sql))[0]).toMatchObject({
      status: "ok",
      lastError: null,
      visibleLocations: [
        { id: "1101", name: "Branch North" },
        { id: "1102", name: "Branch South" },
      ],
    });
  });
});
