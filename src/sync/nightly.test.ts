import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDataFreshness, getOverviewKpis } from "@/analytics";
import { listConnections } from "@/connections/service";
import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS, readFixture, type SaleListRow } from "@/kreloses/testing/fake-kreloses";

import newSale from "./__fixtures__/nightly-new-sale.json";
import { getSyncAlerts } from "./alerts";
import { nightlyWindow, runSync, type SyncResult } from "./engine";
import { listPermanentlyMissingInvoices, MAX_PAGE_MISSING_ATTEMPTS } from "./lines";
import { runNightlySync, nightlyWindowDays } from "./nightly";
import { LEASE_LOST_MESSAGE, listSyncRuns } from "./runs";
import { clearSyncTables, createSyncHarness, snapshotSyncedData, type SyncHarness } from "./test-support";

/**
 * Seam 1 (#6): the nightly sync against the fake Kreloses (synthetic Sale List and invoice pages,
 * `src/kreloses/__fixtures__/`), writing to a throwaway database.
 *
 * The harness clock starts at 1 Oct 2026 02:00 UTC (10:00 in KL), so the default 45-day window is
 * 17 Aug – 1 Oct 2026: 13 synthetic sales (700101–700105, 700201–700206, 700090, 700092), 11 of
 * them active (700103 and 700204 are cancelled). 700091 (15 Aug), 700093, 700094 and the 2025
 * sales are outside it.
 */
const { both, north, south } = SYNTHETIC_ACCOUNTS;
const WINDOW_ACTIVE = ["700105", "700205", "700104", "700203", "700202", "700206", "700102", "700201", "700101", "700090", "700092"];

function ran(result: SyncResult) {
  if (!("runId" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
  return result;
}

describe("Nightly sync", () => {
  const db = useTestDatabase();
  let h: SyncHarness;

  beforeEach(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql);
  });

  /** Sale ids of the invoice pages requested since request number `from`, in order. */
  const pagesOpened = (from = 0) =>
    h.fake.requests
      .slice(from)
      .filter((request) => request.url.pathname.startsWith("/Sale/Overview/"))
      .map((request) => request.url.pathname.split("/").pop()!);
  /** The Sale List requests since `from`: page number and date range asked for. */
  const listRequests = (from = 0) =>
    h.fake.requests
      .slice(from)
      .filter((request) => request.url.pathname === "/Sale/Get")
      .map((request) => {
        const body = JSON.parse(request.body!) as { request: { RequestingPage: number }; filter: { Filters: { Name: string; From?: string; To?: string }[] } };
        const date = body.filter.Filters.find((filter) => filter.Name === "Date")!;
        return { page: body.request.RequestingPage, from: date.From, to: date.To };
      });
  const row = (saleId: number) => h.fake.saleRows.find((candidate) => candidate.SaleId === saleId)!;
  const pendingSales = () => db.sql`select kreloses_sale_id from invoices where status = 'active' and not lines_current order by 1`;

  it("reads the last 45 days (cancelled sales included) and every new invoice's page; unchanged invoices cost no request next time", async () => {
    const id = await h.connect(both, "Both branches");
    expect(nightlyWindow(h.clock.now)).toEqual({ from: "2026-08-17", to: "2026-10-01" });

    const first = ran(await runSync(h.deps(), id, "nightly"));
    expect(first).toMatchObject({ status: "succeeded", counts: { pages: 1, invoicesSeen: 13, inserted: 13, lineItemsRead: 11, lineItemsSwept: 0 } });
    expect(listRequests()).toEqual([{ page: 1, from: "17/08/2026", to: "01/10/2026" }]);
    expect(pagesOpened().sort()).toEqual([...WINDOW_ACTIVE].sort());
    expect((await listSyncRuns(db.sql))[0]).toMatchObject({ mode: "nightly", status: "succeeded", dateFrom: "2026-08-17", dateTo: "2026-10-01", coveredLocationIds: ["1101", "1102"] });

    h.clock.advance(24 * 3_600_000);
    const before = h.fake.requests.length;
    const second = ran(await runSync(h.deps(), id, "nightly"));
    expect(second).toMatchObject({ status: "succeeded", counts: { invoicesSeen: 13, inserted: 0, updated: 0, unchanged: 13, lineItemsRead: 0 } });
    expect(listRequests(before)).toEqual([{ page: 1, from: "18/08/2026", to: "02/10/2026" }]);
    expect(pagesOpened(before)).toEqual([]);
  });

  it("re-reads only what changed: an edited total, a cancellation, a refund and a new sale (not a sale that was merely paid), and the figures follow", async () => {
    const id = await h.connect(both, "Both branches");
    ran(await runSync(h.deps(), id, "nightly"));
    const september = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    expect((await getOverviewKpis(db.sql, september)).total.revenue.value).toBe("5755.40");

    // Overnight in Kreloses:
    // 700203 edited: its second line removed, net 250.00 → 95.00.
    Object.assign(row(700203), { GrossAmount: "100.00", NetAmount: "95.00", Total: "95.00", TotalPayments: "95.00" });
    const model = h.fake.saleOverviews["700203"] as { Items: unknown[]; Totals: Record<string, string> };
    model.Items = model.Items.slice(0, 1);
    model.Totals.NetAmount = "95.00";
    // 700102 (380.50) cancelled.
    row(700102).SaleStatusName = "Cancelled";
    // 700201 (net = total = 600.00) refunded 60.00.
    row(700201).TotalRefunds = "60.00";
    // A new sale, 700207 (1 Oct, 80.00).
    h.fake.saleRows.push(structuredClone(newSale.row) as SaleListRow);
    h.fake.saleOverviews["700207"] = structuredClone(newSale.model);
    // 700105 paid: only its payment status and payments change.
    Object.assign(row(700105), { PaymentStatusName: "Paid", TotalPayments: "99.90" });

    h.clock.advance(24 * 3_600_000);
    const before = h.fake.requests.length;
    const next = ran(await runSync(h.deps(), id, "nightly"));
    expect(next).toMatchObject({ status: "succeeded", counts: { invoicesSeen: 14, inserted: 1, updated: 4, unchanged: 9, lineItemsRead: 3 } });
    // Only the edited, the refunded and the new invoice are opened; the cancelled one needs no page, the paid one no re-read.
    expect(pagesOpened(before).sort()).toEqual(["700201", "700203", "700207"]);

    // The paid sale's new payment details are stored all the same.
    expect(await db.sql`select payment_status, total_payments, lines_current from invoices where kreloses_sale_id = '700105'`).toEqual([
      { paymentStatus: "Paid", totalPayments: "99.90", linesCurrent: true },
    ]);
    // 5,755.40 − 380.50 (cancelled) − 155.00 (edited) − 60.00 (refunded) = 5,159.90; the new sale is on 1 Oct.
    expect((await getOverviewKpis(db.sql, september)).total.revenue.value).toBe("5159.90");
    expect((await getOverviewKpis(db.sql, { dateFrom: "2026-10-01", dateTo: "2026-10-01" })).total.revenue.value).toBe("80.00");
    // The refund comes off 700201's lines in proportion to what each charged (90.00 / 550.00): 843.75 / 5,156.25
    // sen → 8.44 / 51.56 (the sen left to the larger remainder). What they were charged is unchanged.
    expect(
      await db.sql`
        select l.line_no, c.credited_amount, c.refund_amount, c.revenue_amount from credited_lines c
        join invoices i on i.id = c.invoice_id join invoice_lines l on l.id = c.invoice_line_id
        where i.kreloses_sale_id = '700201' order by l.line_no
      `,
    ).toEqual([
      { lineNo: 1, creditedAmount: "84.37", refundAmount: "8.44", revenueAmount: "75.93" },
      { lineNo: 2, creditedAmount: "515.63", refundAmount: "51.56", revenueAmount: "464.07" },
    ]);

    // And nothing is opened the night after.
    h.clock.advance(24 * 3_600_000);
    const after = h.fake.requests.length;
    expect(ran(await runSync(h.deps(), id, "nightly")).counts).toMatchObject({ lineItemsRead: 0, updated: 0 });
    expect(pagesOpened(after)).toEqual([]);
  });

  it("the window is configurable (SYNC_NIGHTLY_WINDOW_DAYS, 1–366, default 45)", async () => {
    expect(nightlyWindowDays({})).toBe(45);
    expect(nightlyWindowDays({ SYNC_NIGHTLY_WINDOW_DAYS: "10" })).toBe(10);
    expect(nightlyWindowDays({ SYNC_NIGHTLY_WINDOW_DAYS: "0" })).toBe(1);
    expect(nightlyWindowDays({ SYNC_NIGHTLY_WINDOW_DAYS: "9999" })).toBe(366);
    expect(nightlyWindowDays({ SYNC_NIGHTLY_WINDOW_DAYS: "soon" })).toBe(45);

    const id = await h.connect(both);
    const result = ran(await runSync(h.deps(), id, "nightly", { windowDays: 10 }));
    // 21 Sep – 1 Oct: 700105, 700205, 700204 (cancelled).
    expect(result.counts).toMatchObject({ invoicesSeen: 3, lineItemsRead: 2 });
  });

  describe("the sweep: older invoices whose line items are not current", () => {
    it("reads them after the window, newest first, whatever their date", async () => {
      const id = await h.connect(both);
      // September 2025 synced with 600003's page missing (still pending, one failed attempt) …
      h.fake.intercept((request) => (request.url.pathname === "/Sale/Overview/600003" ? new Response("gone", { status: 404 }) : undefined));
      ran(await runSync(h.deps(), id, "manual", { dateRange: { from: "2025-09-01", to: "2025-09-30" } }));
      // … and 600001/600002 synced before their refunds or line items counted (as the #6 migration leaves them).
      await db.sql`update invoices set header_version = header_version + 1 where kreloses_sale_id in ('600001', '600002')`;
      expect(await pendingSales()).toEqual([{ krelosesSaleId: "600001" }, { krelosesSaleId: "600002" }, { krelosesSaleId: "600003" }]);

      h.clock.advance(60_000);
      const before = h.fake.requests.length;
      const result = ran(await runSync(h.deps(), id, "nightly"));
      expect(result).toMatchObject({ status: "partial", counts: { lineItemsRead: 13, lineItemsSwept: 2, lineItemsFailed: 1 } });
      // The window's 11 first, then the older ones, newest first.
      expect(pagesOpened(before).slice(11)).toEqual(["600003", "600002", "600001"]);
      expect(await pendingSales()).toEqual([{ krelosesSaleId: "600003" }]);
    });

    it("only ever opens invoices of the branches the connection's own login can see (never another login's)", async () => {
      const northId = await h.connect(north, "North");
      const southId = await h.connect(south, "South");
      const LAST_AUTUMN = { from: "2025-09-01", to: "2025-10-31" };
      ran(await runSync(h.deps(), northId, "manual", { dateRange: LAST_AUTUMN })); // 600001, 600004
      ran(await runSync(h.deps(), southId, "manual", { dateRange: LAST_AUTUMN })); // 600002, 600003
      ran(await runSync(h.deps(), northId, "nightly"));
      ran(await runSync(h.deps(), southId, "nightly"));
      // Older invoices of both branches are left without current line items (as the #6 migration leaves refunded ones).
      await db.sql`update invoices set header_version = header_version + 1 where kreloses_sale_id in ('600001', '600004', '600002')`;
      const southSales = (await db.sql<{ saleId: string }[]>`
        select i.kreloses_sale_id as sale_id from invoices i join branches b on b.id = i.branch_id where b.kreloses_location_id = '1102'
      `).map((row) => row.saleId);

      // North's nightly runs out of time after one older North invoice: the rest left is North's own one.
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get" || request.url.pathname.startsWith("/Sale/Overview/")) h.clock.advance(10_000);
        return undefined;
      });
      h.clock.advance(24 * 3_600_000);
      let before = h.fake.requests.length;
      const northNight = ran(await runSync(h.deps(), northId, "nightly", { timeBudgetMs: 15_000 }));
      expect(pagesOpened(before)).toEqual(["600004"]);
      expect(northNight).toMatchObject({
        status: "succeeded",
        counts: { lineItemsSwept: 1 },
        warnings: [{ code: "line_items_left", message: expect.stringMatching(/^1 older sale still waits/) }],
      });
      before = h.fake.requests.length;
      expect(ran(await runSync(h.deps(), northId, "nightly"))).toMatchObject({ status: "succeeded", counts: { lineItemsSwept: 1 }, warnings: [] });
      // Neither of North's nights opened a South page (600002 is South's, and older than 600004).
      expect(pagesOpened(before)).toEqual(["600001"]);
      expect(await pendingSales()).toEqual([{ krelosesSaleId: "600002" }]);
      expect(southSales).toContain("600002");

      // South's own nightly reads it.
      before = h.fake.requests.length;
      expect(ran(await runSync(h.deps(), southId, "nightly"))).toMatchObject({ status: "succeeded", counts: { lineItemsSwept: 1 } });
      expect(pagesOpened(before)).toEqual(["600002"]);
      expect(await pendingSales()).toEqual([]);
    });

    it("stops when the time budget runs out, says how many are left, and the next night carries on", async () => {
      const id = await h.connect(both);
      ran(await runSync(h.deps(), id, "manual", { dateRange: { from: "2025-09-01", to: "2025-10-31" } }));
      await db.sql`update invoices set header_version = header_version + 1 where kreloses_sale_id like '6%'`; // 600001–600004 pending
      // Every invoice page takes 10 s: the window's 11 take 110 s; with 125 s the sweep reads two (at 110 s and 120 s).
      h.fake.intercept((request) => {
        if (request.url.pathname.startsWith("/Sale/Overview/")) h.clock.advance(10_000);
        return undefined;
      });
      h.clock.advance(60_000);
      const result = ran(await runSync(h.deps(), id, "nightly", { timeBudgetMs: 125_000 }));
      expect(result).toMatchObject({
        status: "succeeded",
        counts: { lineItemsRead: 13, lineItemsSwept: 2 },
        warnings: [{ code: "line_items_left", message: expect.stringMatching(/^2 older sales still wait for their line items/) }],
      });
      expect(await pendingSales()).toEqual([{ krelosesSaleId: "600001" }, { krelosesSaleId: "600002" }]);

      h.clock.advance(24 * 3_600_000);
      expect(ran(await runSync(h.deps(), id, "nightly", { timeBudgetMs: 125_000 }))).toMatchObject({ status: "succeeded", counts: { lineItemsSwept: 2 }, warnings: [] });
      expect(await pendingSales()).toEqual([]);
    });
  });

  describe("an older invoice page the app cannot read, met by the sweep", () => {
    /** Autumn 2025 synced, the window synced, then these older invoices left without current lines. */
    async function olderPending(id: string, saleIds: string[]) {
      ran(await runSync(h.deps(), id, "manual", { dateRange: { from: "2025-09-01", to: "2025-10-31" } }));
      ran(await runSync(h.deps(), id, "nightly"));
      await db.sql`update invoices set header_version = header_version + 1 where kreloses_sale_id = any(${saleIds}::text[])`;
    }
    /** These invoices' pages come back in a layout the Reader does not know (LayoutChanged). */
    const unreadable = (...saleIds: string[]) =>
      h.fake.intercept((request) => {
        const saleId = /^\/Sale\/Overview\/(\d+)$/.exec(request.url.pathname)?.[1];
        return saleId && saleIds.includes(saleId)
          ? new Response(readFixture("sale-overview-changed.html"), { headers: { "Content-Type": "text/html" } })
          : undefined;
      });

    it("is a warning and skipped, not a failed night: the listing still counts for 'data as of', the rest of the sweep goes on", async () => {
      const id = await h.connect(both);
      await olderPending(id, ["600001", "600002"]);
      unreadable("600002");
      h.clock.advance(24 * 3_600_000);
      const before = h.fake.requests.length;
      const night = ran(await runSync(h.deps(), id, "nightly"));
      expect(night).toMatchObject({
        status: "partial",
        stoppedAtTimeLimit: false,
        counts: { lineItemsRead: 1, lineItemsSwept: 1, lineItemsUnreadable: 1, lineItemsFailed: 0 },
        warnings: [{ code: "invoice_pages_unreadable", message: expect.stringMatching(/^1 older invoice page could not be read.*no Items list/) }],
      });
      expect(night.error).toBeUndefined();
      expect(pagesOpened(before)).toEqual(["600002", "600001"]);
      expect((await getDataFreshness(db.sql)).map((branch) => branch.dataAsOf)).toEqual([h.clock.now, h.clock.now]);
      expect(await pendingSales()).toEqual([{ krelosesSaleId: "600002" }]);
    });

    it("never fails the night, even when every page it sweeps is unreadable; after three tries it stops asking", async () => {
      const id = await h.connect(both);
      await olderPending(id, ["600002", "600003", "600004"]);
      unreadable("600002", "600003", "600004");
      for (let night = 1; night <= 3; night += 1) {
        h.clock.advance(24 * 3_600_000);
        expect(ran(await runSync(h.deps(), id, "nightly")), `night ${night}`).toMatchObject({
          status: "partial",
          counts: { lineItemsRead: 0, lineItemsUnreadable: 3 },
        });
      }
      h.clock.advance(24 * 3_600_000);
      const before = h.fake.requests.length;
      expect(ran(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "succeeded", counts: { lineItemsUnreadable: 0 } });
      expect(pagesOpened(before)).toEqual([]);
      expect((await listPermanentlyMissingInvoices(db.sql)).total).toBe(3);
    });

    it("a page the app cannot read in the nightly WINDOW (a new or changed sale) still fails the run loudly", async () => {
      const id = await h.connect(both);
      unreadable("700202");
      expect(ran(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "failed", error: { code: "layout_changed" } });
    });
  });

  describe("the time budget covers logging in too", () => {
    const logins = (from = 0) => h.fake.requests.slice(from).filter((request) => request.method === "POST" && request.url.pathname === "/account/login").length;

    it("does not go on to read anything when the login itself used up the budget", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) => {
        if (request.method === "POST" && request.url.pathname === "/account/login") h.clock.advance(20_000);
        return undefined;
      });
      const before = h.fake.requests.length;
      const result = ran(await runSync(h.deps(), id, "nightly", { timeBudgetMs: 15_000 }));
      expect(result).toMatchObject({ status: "partial", stoppedAtTimeLimit: true, counts: { pages: 0 } });
      expect(h.fake.requests.slice(before).filter((request) => /^\/(Report|Sale)\//.test(request.url.pathname))).toEqual([]);
    });

    it("does not start a login (nor a second one after the session expires) with too little time left", async () => {
      const id = await h.connect(both);
      // The Sale List takes 50 s of a 60 s budget and the session expires meanwhile: logging in again
      // with 10 s left could run past the function's limit, so the run stops cleanly instead.
      let saleGets = 0;
      h.fake.intercept((request) => {
        if (request.url.pathname !== "/Sale/Get" || ++saleGets !== 1) return undefined;
        h.clock.advance(50_000);
        h.fake.expireSessions();
        return undefined;
      });
      const before = h.fake.requests.length;
      const result = ran(await runSync(h.deps(), id, "nightly", { timeBudgetMs: 60_000 }));
      expect(result).toMatchObject({ status: "partial", stoppedAtTimeLimit: true });
      expect(logins(before)).toBe(1);

      // With too little time for even the first login, nothing is requested at all.
      h.clock.advance(60_000);
      const none = h.fake.requests.length;
      expect(ran(await runSync(h.deps(), id, "nightly", { timeBudgetMs: 5_000 }))).toMatchObject({ status: "partial", stoppedAtTimeLimit: true });
      expect(h.fake.requests.length).toBe(none);
    });
  });

  describe("invoice pages that stay missing (#5 review)", () => {
    /** 700091, 700092 and 700093 (August 2026) answer 404 for good. */
    const missingForGood = () =>
      h.fake.intercept((request) =>
        /^\/Sale\/Overview\/70009[123]$/.test(request.url.pathname) ? new Response("<html>404</html>", { status: 404, headers: { "Content-Type": "text/html" } }) : undefined,
      );
    const AUGUST = { from: "2026-08-01", to: "2026-08-31" };

    it("a month with three permanently missing pages: run 1 partial, run 2 still partial (not failed), and after three tries they are left alone", async () => {
      const id = await h.connect(both);
      missingForGood();
      // 700090 read first (newest), then the three missing ones.
      const first = ran(await runSync(h.deps(), id, "manual", { dateRange: AUGUST }));
      expect(first).toMatchObject({ status: "partial", counts: { lineItemsRead: 1, lineItemsFailed: 3 } });

      // Run 2: nothing to read but the three missing pages. They were missing before, so they do not
      // count as "the first pages tried are all missing" (that would say Kreloses changed): partial.
      h.clock.advance(60_000);
      const second = ran(await runSync(h.deps(), id, "manual", { dateRange: AUGUST }));
      expect(second).toMatchObject({ status: "partial", stoppedAtTimeLimit: false, counts: { lineItemsRead: 0, lineItemsFailed: 3 } });
      expect(second.error).toBeUndefined();
      // Still a complete listing: it counts for "data as of".
      expect((await getDataFreshness(db.sql, { dateFrom: "2026-08-01", dateTo: "2026-08-31" })).map((branch) => branch.dataAsOf)).toEqual([h.clock.now, h.clock.now]);

      h.clock.advance(60_000);
      ran(await runSync(h.deps(), id, "manual", { dateRange: AUGUST })); // third try
      expect(MAX_PAGE_MISSING_ATTEMPTS).toBe(3);
      h.clock.advance(60_000);
      const before = h.fake.requests.length;
      expect(ran(await runSync(h.deps(), id, "manual", { dateRange: AUGUST }))).toMatchObject({ status: "succeeded", counts: { lineItemsFailed: 0 } });
      expect(pagesOpened(before)).toEqual([]);
      expect(ran(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "succeeded", counts: { lineItemsSwept: 0 } });

      // Listed on Sync status; still counted at their revenue base as "not synced yet".
      expect(await listPermanentlyMissingInvoices(db.sql)).toEqual({
        total: 3,
        invoices: [
          { saleNumber: "INV-S-0092", saleDate: "2026-08-20", branchName: "Branch South", attempts: 3 },
          { saleNumber: "INV-N-0091", saleDate: "2026-08-15", branchName: "Branch North", attempts: 3 },
          { saleNumber: "INV-S-0093", saleDate: "2026-08-01", branchName: "Branch South", attempts: 3 },
        ],
      });
      expect((await getOverviewKpis(db.sql, { dateFrom: "2026-08-01", dateTo: "2026-08-31" })).total.revenue.value).toBe("2600.00");

      // An edit in Kreloses gives one a fresh set of tries.
      Object.assign(row(700092), { NetAmount: "790.00", Total: "790.00", Discounts: "60.00" });
      h.clock.advance(60_000);
      const edited = h.fake.requests.length;
      ran(await runSync(h.deps(), id, "manual", { dateRange: AUGUST }));
      expect(pagesOpened(edited)).toEqual(["700092"]);
    });

    it("still fails loudly when the first three pages tried for the first time are all missing", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) => (request.url.pathname.startsWith("/Sale/Overview/") ? new Response("<html>404</html>", { status: 404 }) : undefined));
      const result = ran(await runSync(h.deps(), id, "nightly"));
      expect(result).toMatchObject({ status: "failed", error: { code: "layout_changed" }, counts: { lineItemsRead: 0, lineItemsFailed: 3 } });
    });
  });

  describe("resuming after a crash (spec story 16)", () => {
    /** Syncs the window without interruption and returns what is stored. */
    async function uninterrupted() {
      const id = await h.connect(both, "Both branches");
      expect(ran(await runSync(h.deps(), id, "nightly", { pageSize: 4 }))).toMatchObject({ status: "succeeded", counts: { lineItemsRead: 11 } });
      return snapshotSyncedData(db.sql);
    }

    it.each([
      ["the server is killed while reading the 6th invoice page (the run stays 'running', its lease runs out)", "killed"],
      ["Kreloses fails the 6th invoice page (the run ends 'failed' part-way)", "failed"],
    ] as const)("crash, then rerun: the database is IDENTICAL to an uninterrupted run, nothing counted twice — %s", async (_label, crash) => {
      const expected = await uninterrupted();
      await clearSyncTables(db.sql);
      h = createSyncHarness(db.sql);
      const id = await h.connect(both, "Both branches");

      // Crash after K = 5 invoices' lines (page 1's three active ones and two of page 2's).
      let opened = 0;
      let release!: () => void;
      const hung = new Promise<void>((resolve) => (release = resolve));
      let crashing = true;
      h.fake.intercept(async (request) => {
        if (!request.url.pathname.startsWith("/Sale/Overview/") || !crashing) return undefined;
        opened += 1;
        if (opened !== 6) return undefined;
        crashing = false;
        if (crash === "failed") return new Response("down", { status: 503 });
        await hung; // the request never comes back while the "server" is dead
        return undefined;
      });

      const crashed = runSync(h.deps(), id, "nightly", { pageSize: 4, maxRetries: 0 });
      let crashedRunId: string;
      if (crash === "killed") {
        await vi.waitFor(async () => expect(await db.sql`select 1 from credited_lines`).not.toHaveLength(0));
        await vi.waitFor(() => expect(opened).toBe(6));
        const [running] = await db.sql<{ id: string }[]>`select id::text from sync_runs where status = 'running'`;
        crashedRunId = running!.id;
        // Its lease runs out (database clock) …
        await db.sql`update connection_locks set acquired_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'`;
      } else {
        const result = ran(await crashed);
        expect(result).toMatchObject({ status: "failed", error: { code: "transient" }, counts: { lineItemsRead: 5 } });
        crashedRunId = result.runId;
      }
      const stopped = await db.sql`select checkpoint from sync_runs where id = ${crashedRunId}`;
      // Page 1 done: everything newer than its oldest sale (700104, 20 Sep 09:45 KL) is stored with its lines.
      expect(stopped[0]!.checkpoint).toMatchObject({ processedAfter: "2026-09-20T01:45:00.000Z", pageSize: 4 });

      // … and the next run carries on from the checkpoint.
      h.clock.advance(5 * 60_000);
      const listed = h.fake.requests.length;
      const rerun = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, resume: true }));
      expect(rerun).toMatchObject({ status: "succeeded", resumedFromRunId: crashedRunId });
      // Only the days up to 20 Sep are listed again (3 pages instead of 4), and only the 6 invoices left are opened.
      expect(listRequests(listed).map((request) => [request.page, request.to])).toEqual([
        [1, "20/09/2026"],
        [2, "20/09/2026"],
        [3, "20/09/2026"],
      ]);
      expect(pagesOpened(listed)).toHaveLength(6);
      expect(await listSyncRuns(db.sql)).toMatchObject([
        { id: rerun.runId, status: "succeeded", resumedFromRunId: crashedRunId, chainStartedAt: expect.any(Date) },
        { id: crashedRunId, status: "failed", errorCode: crash === "killed" ? "interrupted" : "transient" },
      ]);

      expect(await snapshotSyncedData(db.sql)).toEqual(expected);

      if (crash === "killed") {
        // The dead run's request finally comes back: it lost its lease, so it writes nothing.
        release();
        expect(ran(await crashed)).toMatchObject({ status: "failed", error: { code: "interrupted", message: LEASE_LOST_MESSAGE } });
        expect(await snapshotSyncedData(db.sql)).toEqual(expected);
      }
    });

    it("a run that lost its lease mid-run stops writing at once (fencing)", async () => {
      const id = await h.connect(both);
      let release!: () => void;
      const hung = new Promise<void>((resolve) => (release = resolve));
      h.fake.intercept(async (request) => {
        if (request.url.pathname === "/Sale/Overview/700104") await hung;
        return undefined;
      });
      const run = runSync(h.deps(), id, "nightly");
      await vi.waitFor(async () => expect(h.fake.requests.some((request) => request.url.pathname === "/Sale/Overview/700104")).toBe(true));
      const linesBefore = await db.sql`select count(*)::int as n from invoice_lines`;

      // Its lease expired and someone else took the connection.
      await db.sql`update connection_locks set holder = 'sync:someone-else', expires_at = now() + interval '4 minutes'`;
      release();
      const result = ran(await run);
      expect(result).toMatchObject({ status: "failed", error: { code: "interrupted", message: LEASE_LOST_MESSAGE } });
      expect(await db.sql`select count(*)::int as n from invoice_lines`).toEqual(linesBefore);
      expect(await db.sql`select 1 from invoices i where i.kreloses_sale_id = '700104' and i.lines_current`).toEqual([]);
      expect(await listSyncRuns(db.sql)).toMatchObject([{ status: "failed", errorCode: "interrupted", error: LEASE_LOST_MESSAGE }]);
      // The other holder keeps the connection (the stopped run did not release it).
      expect(await db.sql`select holder from connection_locks`).toEqual([{ holder: "sync:someone-else" }]);
    });

    it("carries on by DATE, not page number: a sale deleted in Kreloses between the runs shifts the pages but loses nothing", async () => {
      const id = await h.connect(both);
      // The Sale List page takes 10 s and each invoice page 10 s: with a 35 s budget page 1 (4 sales,
      // 3 active) is done at 40 s and the run stops before page 2.
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get" || request.url.pathname.startsWith("/Sale/Overview/")) h.clock.advance(10_000);
        return undefined;
      });
      const first = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, timeBudgetMs: 35_000 }));
      expect(first).toMatchObject({ status: "partial", stoppedAtTimeLimit: true, counts: { pages: 1, lineItemsRead: 3 } });

      // 700205 (on page 1) is deleted in Kreloses: every later sale moves up one place, so "page 2"
      // would now start one sale later — 700203 would be skipped by a page-number checkpoint.
      h.fake.saleRows.splice(h.fake.saleRows.indexOf(row(700205)), 1);
      h.clock.advance(60_000);
      const rest = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, resume: true }));
      expect(rest).toMatchObject({ status: "succeeded", resumedFromRunId: first.runId });
      expect(await db.sql`select lines_current from invoices where kreloses_sale_id = '700203'`).toEqual([{ linesCurrent: true }]);
      expect(await pendingSales()).toEqual([]);
    });
  });

  describe("resume is bounded, and a resumed chain is only as fresh as its first run", () => {
    const stopAfterFirstPage = () =>
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get") h.clock.advance(10_000);
        return undefined;
      });

    it("carries on a run stopped a few hours ago; 'data as of' is when the FIRST run of the chain started", async () => {
      const id = await h.connect(both);
      stopAfterFirstPage();
      const first = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, timeBudgetMs: 15_000 }));
      expect(first).toMatchObject({ status: "partial", stoppedAtTimeLimit: true });
      const [firstRun] = await listSyncRuns(db.sql);

      h.clock.advance(60 * 60_000);
      const second = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, resume: true }));
      expect(second).toMatchObject({ status: "succeeded", resumedFromRunId: first.runId });
      const [secondRun] = await listSyncRuns(db.sql);
      expect(secondRun).toMatchObject({ dateFrom: firstRun!.dateFrom, dateTo: firstRun!.dateTo, chainStartedAt: firstRun!.startedAt });
      const freshness = await getDataFreshness(db.sql);
      expect(freshness.map((branch) => branch.dataAsOf)).toEqual([firstRun!.startedAt, firstRun!.startedAt]);
      expect(secondRun!.finishedAt!.getTime()).toBeGreaterThan(firstRun!.startedAt.getTime());
    });

    it("starts afresh when the stopped run is more than a few hours old", async () => {
      const id = await h.connect(both);
      stopAfterFirstPage();
      ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, timeBudgetMs: 15_000 }));

      h.clock.advance(7 * 60 * 60_000);
      const before = h.fake.requests.length;
      const fresh = ran(await runSync(h.deps(), id, "nightly", { pageSize: 4, resume: true }));
      expect(fresh.resumedFromRunId).toBeUndefined();
      expect(listRequests(before)[0]).toMatchObject({ page: 1, to: "01/10/2026" });
      const [latest] = await listSyncRuns(db.sql);
      expect(latest).toMatchObject({ chainStartedAt: null, resumedFromRunId: null });
      expect((await getDataFreshness(db.sql)).map((branch) => branch.dataAsOf)).toEqual([latest!.finishedAt, latest!.finishedAt]);
    });

    it("never resumes a run that read its whole listing (some invoice pages missing): the next run starts afresh", async () => {
      const id = await h.connect(both);
      h.fake.intercept((request) => (request.url.pathname === "/Sale/Overview/700202" ? new Response("gone", { status: 404 }) : undefined));
      expect(ran(await runSync(h.deps(), id, "nightly"))).toMatchObject({ status: "partial", stoppedAtTimeLimit: false });
      h.clock.advance(60_000);
      expect(ran(await runSync(h.deps(), id, "nightly", { resume: true })).resumedFromRunId).toBeUndefined();
    });
  });

  it("is polite: one request at a time per connection, with the configured delay between them", async () => {
    h = createSyncHarness(db.sql, { requestDelayMs: 30 });
    const id = await h.connect(both);
    const inner = h.context.reader.transport!;
    let inFlight = 0;
    let maxInFlight = 0;
    const timings: { path: string; start: number; end: number }[] = [];
    h.context.reader.transport = async (url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const start = performance.now();
      try {
        return await inner(url, init);
      } finally {
        inFlight -= 1;
        timings.push({ path: new URL(url).pathname, start, end: performance.now() });
      }
    };
    ran(await runSync(h.deps(), id, "nightly"));
    expect(maxInFlight).toBe(1);
    const app = timings.filter((timing) => /^\/(Sale|Report)\//.test(timing.path));
    expect(app.length).toBeGreaterThan(10);
    for (let i = 1; i < app.length; i += 1) expect(app[i]!.start - app[i - 1]!.end, app[i]!.path).toBeGreaterThanOrEqual(28);
  });

  describe("every connection, every night (runNightlySync)", () => {
    it("runs each connection in turn, sharing the time budget so none is starved", async () => {
      const northId = await h.connect(north, "North");
      const southId = await h.connect(south, "South");
      const results = await runNightlySync(h.deps(), { totalBudgetMs: 240_000, maxRunBudgetMs: 200_000 });
      expect(results.map((result) => [result.connectionLabel, result.timeBudgetMs, result.outcome.status])).toEqual([
        ["North", 120_000, "succeeded"],
        ["South", 200_000, "succeeded"], // the whole of what North left, capped at the per-run budget
      ]);
      expect((await listSyncRuns(db.sql)).map((run) => [run.connectionId, run.mode, run.status])).toEqual([
        [southId, "nightly", "succeeded"],
        [northId, "nightly", "succeeded"],
      ]);
      expect(await db.sql`select 1 from invoices`).toHaveLength(13);
    });

    it("includes failed connections: a login that works again recovers on its own; one that still fails stays failed with the new error (and a banner)", async () => {
      const northId = await h.connect(north, "North");
      const southId = await h.connect(south, "South");
      await db.sql`
        update connections set status = 'failed', last_error_code = 'bad_credentials', last_error = 'Kreloses rejected this email or password.', visible_locations = '[]'
      `;
      expect((await getSyncAlerts(db.sql)).map((alert) => [alert.connectionLabel, alert.kind])).toEqual([
        ["North", "login_failed"],
        ["South", "login_failed"],
      ]);

      // South's login is now refused for another reason (an extra login step); North's works again.
      h.fake.intercept((request) =>
        request.method === "POST" && request.url.pathname === "/account/login" && new URLSearchParams(request.body).get("Email") === south.email
          ? new Response(null, { status: 302, headers: { Location: "/Account/VerifyCode" } })
          : undefined,
      );
      const results = await runNightlySync(h.deps());
      expect(results.map((result) => [result.connectionId, result.outcome.status])).toEqual([
        [northId, "succeeded"],
        [southId, "failed"],
      ]);
      const connections = Object.fromEntries((await listConnections(db.sql)).map((connection) => [connection.label, connection]));
      expect(connections.North).toMatchObject({ status: "ok", lastError: null });
      expect(connections.South).toMatchObject({ status: "failed", lastErrorCode: "unexpected_step" });
      const alerts = await getSyncAlerts(db.sql);
      expect(alerts).toEqual([{ connectionId: southId, connectionLabel: "South", kind: "login_failed", message: connections.South!.lastError, since: expect.any(Date) }]);
    });

    it("skips a connection another sync is using, and carries on with the rest", async () => {
      const northId = await h.connect(north, "North");
      await h.connect(south, "South");
      await db.sql`insert into connection_locks (connection_id, holder, acquired_at, expires_at) values (${northId}, 'sync:manual', now(), now() + interval '4 minutes')`;
      const results = await runNightlySync(h.deps());
      expect(results.map((result) => [result.connectionLabel, result.outcome.status])).toEqual([
        ["North", "busy"],
        ["South", "succeeded"],
      ]);
    });

    it("gives a connection at least 20 s, and does not start one with less than that left", async () => {
      await h.connect(north, "North");
      await h.connect(south, "South");
      expect((await runNightlySync(h.deps(), { totalBudgetMs: 10_000 })).map((result) => result.outcome.status)).toEqual(["skipped", "skipped"]);
      expect(await listSyncRuns(db.sql)).toEqual([]);

      // 30 s for two: North gets 20 s (not 15) and uses 15 of them; the 15 s left are too few for South.
      h.fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Get") h.clock.advance(15_000);
        return undefined;
      });
      const results = await runNightlySync(h.deps(), { totalBudgetMs: 30_000 });
      expect(results.map((result) => [result.connectionLabel, result.timeBudgetMs, result.outcome.status])).toEqual([
        ["North", 20_000, "succeeded"],
        ["South", 15_000, "skipped"],
      ]);
    });
  });

  describe("failure banner data (getSyncAlerts)", () => {
    it("is empty while every connection works", async () => {
      expect(await getSyncAlerts(db.sql)).toEqual([]);
      const id = await h.connect(both, "Both");
      ran(await runSync(h.deps(), id, "nightly"));
      expect(await getSyncAlerts(db.sql)).toEqual([]);
    });

    it("shows a failed nightly run with its error until a later run of any kind succeeds (a later failed Sync now does not hide it)", async () => {
      const id = await h.connect(both, "Both");
      let broken = true;
      h.fake.intercept((request) =>
        broken && request.url.pathname === "/Sale/Get"
          ? new Response(readFixture("sale-get-changed.json"), { headers: { "Content-Type": "application/json" } })
          : undefined,
      );
      const september = { dateRange: { from: "2026-09-01", to: "2026-09-30" } };
      // A failed Sync now alone is no banner: the owner saw it fail on the Connections page.
      expect(ran(await runSync(h.deps(), id, "manual", september))).toMatchObject({ status: "failed" });
      expect(await getSyncAlerts(db.sql)).toEqual([]);

      h.clock.advance(60_000);
      const failed = ran(await runSync(h.deps(), id, "nightly"));
      expect(failed).toMatchObject({ status: "failed", error: { code: "layout_changed" } });
      const alert = { connectionId: id, connectionLabel: "Both", kind: "nightly_failed", message: failed.error!.message, since: h.clock.now };
      expect(await getSyncAlerts(db.sql)).toEqual([alert]);
      expect((await listConnections(db.sql))[0]).toMatchObject({ status: "ok" }); // the login itself works

      // The owner tries "Sync now", which fails the same way: the nightly failure still shows.
      h.clock.advance(60_000);
      expect(ran(await runSync(h.deps(), id, "manual", september))).toMatchObject({ status: "failed" });
      expect(await getSyncAlerts(db.sql)).toEqual([alert]);

      // Fixed: a later run that reads its whole listing (here a Sync now) clears it.
      broken = false;
      h.clock.advance(60_000);
      expect(ran(await runSync(h.deps(), id, "manual", september))).toMatchObject({ status: "succeeded" });
      expect(await getSyncAlerts(db.sql)).toEqual([]);

      // So does a later successful nightly after another failed one.
      broken = true;
      h.clock.advance(60_000);
      ran(await runSync(h.deps(), id, "nightly"));
      expect(await getSyncAlerts(db.sql)).toHaveLength(1);
      broken = false;
      h.clock.advance(60_000);
      ran(await runSync(h.deps(), id, "nightly"));
      expect(await getSyncAlerts(db.sql)).toEqual([]);
    });

    it("a later run that stopped at its time limit does not clear it (it did not read its whole listing)", async () => {
      const id = await h.connect(both, "Both");
      let broken = true;
      h.fake.intercept((request) => {
        if (request.url.pathname !== "/Sale/Get") return undefined;
        if (broken) return new Response(readFixture("sale-get-changed.json"), { headers: { "Content-Type": "application/json" } });
        h.clock.advance(10_000);
        return undefined;
      });
      ran(await runSync(h.deps(), id, "nightly"));
      broken = false;
      h.clock.advance(60_000);
      expect(ran(await runSync(h.deps(), id, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, pageSize: 4, timeBudgetMs: 15_000 }))).toMatchObject({
        status: "partial",
        stoppedAtTimeLimit: true,
      });
      expect(await getSyncAlerts(db.sql)).toMatchObject([{ kind: "nightly_failed" }]);
    });
  });
});
