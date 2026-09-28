import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getDataFreshness, getOverviewKpis } from "./index";

/**
 * Seam 1: the Sync Engine reads the synthetic Sale List (src/kreloses/__fixtures__/sale-list-rows.json)
 * through the real Reader from the fake Kreloses into a throwaway database; the Analytics Service
 * must then return exactly these HAND-COMPUTED figures.
 *
 * Active sales, September 2026 (KL days), net amounts:
 *   North: 700101 C1 1,200.00 (1 Sep 00:30 KL = 31 Aug 16:30 UTC) · 700102 C2 380.50 · 700104 C3 2,300.00
 *          · 700105 C2 99.90 (30 Sep 23:59 KL)                      → 3,980.40 · 4 invoices · 3 customers
 *   South: 700201 C4 600.00 · 700202 C5 1,100.00 · 700203 C1 250.00 · 700205 walk-in 45.00
 *          · 700206 C4 (120.00) return                              → 1,875.00 · 5 invoices · 3 customers
 *   Not counted: 700103 (North, 900.00) and 700204 (South, 75.00) are cancelled.
 *   Total: 5,855.40 · 9 invoices · 5 customers (C1 bought at both branches; the walk-in is nobody)
 *   AOV per customer = revenue ÷ distinct customers: 1,171.08 · North 1,326.80 · South 625.00
 *
 * Previous period (same 30 days immediately before: 2 Aug – 31 Aug 2026):
 *   North: 700090 C1 500.00 (31 Aug 23:50 KL) · 700091 C7 1,000.00  → 1,500.00 · 2 · 2 · AOV 750.00
 *   South: 700092 C4 800.00                                          →   800.00 · 1 · 1 · AOV 800.00
 *   Not counted: 700093 (1 Aug: outside the 30 days), 700094 (cancelled).
 *   Total: 2,300.00 · 3 · 3 · AOV 766.67 (766.666… rounded half up)
 *
 * Same period last year (1 Sep – 30 Sep 2025):
 *   North: 600001 C1 12,345.60 → 12,345.60 · 1 · 1 · AOV 12,345.60
 *   South: 600002 C5 654.40 · 600003 C5 100.00 → 754.40 · 2 · 1 · AOV 754.40
 *   Not counted: 600004 (1 Oct 2025 00:10 KL = 30 Sep 16:10 UTC).
 *   Total: 13,100.00 · 3 · 2 · AOV 6,550.00
 *
 * Changes are value − base; percentages are change ÷ |base| × 100, rounded half away from zero to
 * one decimal, null when the base is zero.
 */
const { both, north } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

describe("Analytics Service: Overview KPIs (fed by the Sync Engine)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branchId: { north: string; south: string };
  const syncedAt = new Date("2026-10-01T02:00:00Z");

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: syncedAt });
    connectionId = await h.connect(both, "Both branches");
    const result = await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2025-09-01", to: "2026-09-30" }, pageSize: 7 });
    expect(result).toMatchObject({ status: "succeeded", counts: { invoicesSeen: 20, inserted: 20 } });
    const rows = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branchId = {
      north: rows.find((row) => row.krelosesLocationId === "1101")!.id,
      south: rows.find((row) => row.krelosesLocationId === "1102")!.id,
    };
  });

  it("totals and per-branch KPIs equal the hand-computed figures, to the sen", async () => {
    const kpis = await getOverviewKpis(db.sql, SEPTEMBER);

    expect(kpis.period).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(kpis.previousPeriod).toEqual({ dateFrom: "2026-08-02", dateTo: "2026-08-31" });
    expect(kpis.lastYear).toEqual({ dateFrom: "2025-09-01", dateTo: "2025-09-30" });

    expect(kpis.total).toEqual({
      revenue: {
        value: "5855.40",
        previousPeriod: { base: "2300.00", change: "3555.40", changePercent: 154.6 },
        lastYear: { base: "13100.00", change: "-7244.60", changePercent: -55.3 },
      },
      invoices: {
        value: 9,
        previousPeriod: { base: 3, change: 6, changePercent: 200 },
        lastYear: { base: 3, change: 6, changePercent: 200 },
      },
      customers: {
        value: 5,
        previousPeriod: { base: 3, change: 2, changePercent: 66.7 },
        lastYear: { base: 2, change: 3, changePercent: 150 },
      },
      aovPerCustomer: {
        value: "1171.08",
        previousPeriod: { base: "766.67", change: "404.41", changePercent: 52.7 },
        lastYear: { base: "6550.00", change: "-5378.92", changePercent: -82.1 },
      },
    });

    expect(kpis.branches.map((branch) => branch.branchName)).toEqual(["Branch North", "Branch South"]);
    const [northKpis, southKpis] = kpis.branches;
    expect(northKpis).toEqual({
      branchId: branchId.north,
      branchName: "Branch North",
      revenue: {
        value: "3980.40",
        previousPeriod: { base: "1500.00", change: "2480.40", changePercent: 165.4 },
        lastYear: { base: "12345.60", change: "-8365.20", changePercent: -67.8 },
      },
      invoices: {
        value: 4,
        previousPeriod: { base: 2, change: 2, changePercent: 100 },
        lastYear: { base: 1, change: 3, changePercent: 300 },
      },
      customers: {
        value: 3,
        previousPeriod: { base: 2, change: 1, changePercent: 50 },
        lastYear: { base: 1, change: 2, changePercent: 200 },
      },
      aovPerCustomer: {
        value: "1326.80",
        previousPeriod: { base: "750.00", change: "576.80", changePercent: 76.9 },
        lastYear: { base: "12345.60", change: "-11018.80", changePercent: -89.3 },
      },
    });
    expect(southKpis).toEqual({
      branchId: branchId.south,
      branchName: "Branch South",
      revenue: {
        value: "1875.00",
        previousPeriod: { base: "800.00", change: "1075.00", changePercent: 134.4 },
        lastYear: { base: "754.40", change: "1120.60", changePercent: 148.5 },
      },
      invoices: {
        value: 5,
        previousPeriod: { base: 1, change: 4, changePercent: 400 },
        lastYear: { base: 2, change: 3, changePercent: 150 },
      },
      customers: {
        value: 3,
        previousPeriod: { base: 1, change: 2, changePercent: 200 },
        lastYear: { base: 1, change: 2, changePercent: 200 },
      },
      aovPerCustomer: {
        value: "625.00",
        // −21.875 % rounds half away from zero to −21.9.
        previousPeriod: { base: "800.00", change: "-175.00", changePercent: -21.9 },
        lastYear: { base: "754.40", change: "-129.40", changePercent: -17.2 },
      },
    });
  });

  it("respects the branch filter", async () => {
    const kpis = await getOverviewKpis(db.sql, { ...SEPTEMBER, branchIds: [branchId.north] });
    expect(kpis.branches.map((branch) => branch.branchId)).toEqual([branchId.north]);
    expect(kpis.total.revenue).toEqual({
      value: "3980.40",
      previousPeriod: { base: "1500.00", change: "2480.40", changePercent: 165.4 },
      lastYear: { base: "12345.60", change: "-8365.20", changePercent: -67.8 },
    });
    expect(kpis.total.customers.value).toBe(3);

    const both = await getOverviewKpis(db.sql, { ...SEPTEMBER, branchIds: [branchId.south, branchId.north] });
    expect(both.total.revenue.value).toBe("5855.40");
    expect(both.total.customers.value).toBe(5);

    for (const unknown of [["999999"], ["not-a-branch"]]) {
      const none = await getOverviewKpis(db.sql, { ...SEPTEMBER, branchIds: unknown });
      expect(none.branches).toEqual([]);
      expect(none.total.revenue.value).toBe("0.00");
      expect(none.total.invoices.value).toBe(0);
      expect(none.total.aovPerCustomer.value).toBeNull();
    }
  });

  it("counts a sale on its clinic day in Kuala Lumpur, not its UTC date", async () => {
    const day = async (date: string) => (await getOverviewKpis(db.sql, { dateFrom: date, dateTo: date })).total;
    // 00:30 on 1 Sep in KL (16:30 UTC on 31 Aug) is a September sale.
    expect(await day("2026-09-01")).toMatchObject({ revenue: { value: "1200.00" }, invoices: { value: 1 } });
    // 23:50 on 31 Aug in KL is an August sale; the 1 Sep 00:30 sale is not on 31 Aug.
    expect(await day("2026-08-31")).toMatchObject({ revenue: { value: "500.00" }, invoices: { value: 1 } });
    // 23:59 on 30 Sep in KL is still 30 Sep.
    expect(await day("2026-09-30")).toMatchObject({ revenue: { value: "99.90" }, invoices: { value: 1 } });
    expect(await day("2025-10-01")).toMatchObject({ revenue: { value: "999.00" }, invoices: { value: 1 } });
  });

  it("has no percentage change when the comparison had no sales", async () => {
    const kpis = await getOverviewKpis(db.sql, { dateFrom: "2025-09-01", dateTo: "2025-09-30" });
    expect(kpis.total.revenue).toEqual({
      value: "13100.00",
      previousPeriod: { base: "0.00", change: "13100.00", changePercent: null },
      lastYear: { base: "0.00", change: "13100.00", changePercent: null },
    });
    expect(kpis.total.aovPerCustomer).toEqual({
      value: "6550.00",
      previousPeriod: { base: null, change: null, changePercent: null },
      lastYear: { base: null, change: null, changePercent: null },
    });
    expect(kpis.total.invoices.previousPeriod).toEqual({ base: 0, change: 3, changePercent: null });
  });

  it("stays the same after an identical re-sync, and follows a cancellation made in Kreloses", async () => {
    const again = await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    expect(again).toMatchObject({ status: "succeeded", counts: { inserted: 0, updated: 0, unchanged: 11 } });
    expect((await getOverviewKpis(db.sql, SEPTEMBER)).total.revenue.value).toBe("5855.40");

    h.fake.saleRows.find((row) => row.SaleId === 700102)!.SaleStatusName = "Cancelled";
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    const after = await getOverviewKpis(db.sql, SEPTEMBER);
    expect(after.total.revenue.value).toBe("5474.90"); // 5,855.40 − 380.50
    expect(after.total.invoices.value).toBe(8);
    expect(after.total.customers.value).toBe(5); // C2 still bought 700105

    h.fake.saleRows.find((row) => row.SaleId === 700102)!.SaleStatusName = "Active";
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
  });

  it("reports 'data as of' per branch: the latest succeeded run covering it", async () => {
    const asOf = async () =>
      Object.fromEntries((await getDataFreshness(db.sql, SEPTEMBER)).map((branch) => [branch.branchName, branch.dataAsOf?.toISOString() ?? null]));

    const later = new Date("2026-10-01T05:00:00Z");
    h.clock.now = later;
    const northOnly = await h.connect(north, "North only");
    expect(await runSync(h.deps(), northOnly, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } })).toMatchObject({
      status: "succeeded",
    });
    const freshness = await asOf();
    expect(freshness["Branch North"]).toBe(later.toISOString());
    expect(freshness["Branch South"]).not.toBe(later.toISOString());

    // A failed run does not make data fresher.
    h.clock.now = new Date("2026-10-01T06:00:00Z");
    h.fake.intercept((request) => (request.url.pathname === "/Sale/Get" ? new Response("down", { status: 500 }) : undefined));
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, maxRetries: 0 })).toMatchObject({
      status: "failed",
    });
    expect(await asOf()).toEqual(freshness);

    expect(await getDataFreshness(db.sql, { ...SEPTEMBER, branchIds: [branchId.south] })).toEqual([
      { branchId: branchId.south, branchName: "Branch South", dataAsOf: expect.any(Date) },
    ]);
  });
});
