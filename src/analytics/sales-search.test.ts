import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { SALES_SEARCH_MAX_PAGE_SIZE, searchSales, type SaleCredit } from "./index";

/**
 * Seam 1: the Sync Engine reads the synthetic Sale List and invoice pages from the fake Kreloses;
 * `searchSales` must then find exactly these invoices, with these HAND-COMPUTED credited splits
 * (the same credited lines as src/analytics/doctors.test.ts). Active sales, September 2026, newest
 * first (KL clinic days):
 *
 *   700105 INV-N-0105 30 Sep  North  Customer 0002    99.90  no staff 54.90 (1 line) · Charlie Chen 45.00 (1)
 *   700205 INV-S-0205 28 Sep  South  walk-in          45.00  Branch South General 45.00 (1)
 *   700104 INV-N-0104 20 Sep  North  Customer 0003 2,300.00  Dr Bravo Brown 2,075.85 (2) · no staff 175.42 (1)
 *                                                           · Branch North General 48.73 (1)
 *   700203 INV-S-0203 18 Sep  South  Customer 0001   250.00  Dr Alpha Anderson 153.85 (1) · Dr Bravo Brown 96.15 (1)
 *   700202 INV-S-0202 15 Sep  South  Customer 0005 1,100.00  Dr Bravo Brown 1,100.00 (2)
 *   700206 INV-S-0206 10 Sep  South  Customer 0004  (120.00) Dr Delta (120.00) (1: a return)
 *   700102 INV-N-0102  5 Sep  North  Customer 0002   380.50  Dr Alpha Anderson 300.50 (2) · Dr Bravo Brown 80.00 (1)
 *   700201 INV-S-0201  2 Sep  South  Customer 0004   600.00  Dr Delta 600.00 (2)
 *   700101 INV-N-0101  1 Sep  North  Customer 0001 1,200.00  Dr Alpha Anderson 1,200.00 (3)
 *   Cancelled 700103 and 700204 are never found.                                  Total 5,855.40
 *
 * Items: "Consultation" is on 700203, 700102, 700201 and 700101; 700101 also sells
 * `Antibiotic tablets "Amoxi" {250mg}`; "Dental scaling" is on 700104 only (in September).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

describe("Analytics Service: sales search (fed by the Sync Engine, line items included)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: new Date("2026-10-01T02:00:00Z") });
    connectionId = await h.connect(both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2025-09-01", to: "2026-09-30" }, pageSize: 7 })).toMatchObject({
      status: "succeeded",
    });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  const credit = (name: string, revenue: string, lines: number, creditGroup: SaleCredit["creditGroup"] = "doctor"): SaleCredit => ({
    staffId: staff[name]!,
    name,
    creditGroup,
    revenue,
    lines,
  });
  const noStaff = (revenue: string, lines: number): SaleCredit => ({ staffId: null, name: "No staff on line", creditGroup: "no_staff", revenue, lines });
  const numbers = async (criteria: Parameters<typeof searchSales>[2], filter: Parameters<typeof searchSales>[1] = SEPTEMBER) =>
    (await searchSales(db.sql, filter, criteria)).sales.map((sale) => sale.saleNumber);

  it("lists every active sale in the period, newest first, paged, with each invoice's credited split per staff", async () => {
    const first = await searchSales(db.sql, SEPTEMBER, { pageSize: 4 });
    expect(first).toMatchObject({ period: SEPTEMBER, page: 1, pageSize: 4, totalMatches: 9, totalPages: 3, totalRevenue: "5855.40" });
    expect(first.sales).toEqual([
      {
        invoiceId: expect.any(String),
        saleNumber: "INV-N-0105",
        saleDate: "2026-09-30",
        branchId: branch.north,
        branchName: "Branch North",
        customerName: "Customer 0002",
        revenue: "99.90",
        lineItemsSynced: true,
        credits: [noStaff("54.90", 1), credit("Charlie Chen", "45.00", 1, "other")],
      },
      {
        invoiceId: expect.any(String),
        saleNumber: "INV-S-0205",
        saleDate: "2026-09-28",
        branchId: branch.south,
        branchName: "Branch South",
        customerName: null,
        revenue: "45.00",
        lineItemsSynced: true,
        credits: [credit("Branch South General", "45.00", 1, "generic")],
      },
      {
        invoiceId: expect.any(String),
        saleNumber: "INV-N-0104",
        saleDate: "2026-09-20",
        branchId: branch.north,
        branchName: "Branch North",
        customerName: "Customer 0003",
        revenue: "2300.00",
        lineItemsSynced: true,
        credits: [credit("Dr Bravo Brown", "2075.85", 2), noStaff("175.42", 1), credit("Branch North General", "48.73", 1, "generic")],
      },
      {
        invoiceId: expect.any(String),
        saleNumber: "INV-S-0203",
        saleDate: "2026-09-18",
        branchId: branch.south,
        branchName: "Branch South",
        customerName: "Customer 0001",
        revenue: "250.00",
        lineItemsSynced: true,
        credits: [credit("Dr Alpha Anderson", "153.85", 1), credit("Dr Bravo Brown", "96.15", 1)],
      },
    ]);

    const second = await searchSales(db.sql, SEPTEMBER, { pageSize: 4, page: 2 });
    expect(second.sales.map((sale) => [sale.saleNumber, sale.revenue])).toEqual([
      ["INV-S-0202", "1100.00"],
      ["INV-S-0206", "-120.00"],
      ["INV-N-0102", "380.50"],
      ["INV-S-0201", "600.00"],
    ]);
    expect(second.sales.find((sale) => sale.saleNumber === "INV-S-0206")!.credits).toEqual([credit("Dr Delta", "-120.00", 1)]);
    expect(second.sales.find((sale) => sale.saleNumber === "INV-N-0102")!.credits).toEqual([
      credit("Dr Alpha Anderson", "300.50", 2),
      credit("Dr Bravo Brown", "80.00", 1),
    ]);
    const third = await searchSales(db.sql, SEPTEMBER, { pageSize: 4, page: 3 });
    expect(third.sales.map((sale) => sale.saleNumber)).toEqual(["INV-N-0101"]);
    expect(third.sales[0]!.credits).toEqual([credit("Dr Alpha Anderson", "1200.00", 3)]);

    // Past the last page: no rows, but the totals still say what matched.
    expect(await searchSales(db.sql, SEPTEMBER, { pageSize: 4, page: 4 })).toMatchObject({ page: 4, totalMatches: 9, totalPages: 3, totalRevenue: "5855.40", sales: [] });
  });

  it("caps the page size and starts at page 1", async () => {
    const huge = await searchSales(db.sql, { dateFrom: "2025-01-01", dateTo: "2026-12-31" }, { pageSize: 5000, page: 0 });
    expect(SALES_SEARCH_MAX_PAGE_SIZE).toBe(100);
    expect(huge).toMatchObject({ page: 1, pageSize: 100, totalMatches: 17, totalPages: 1 });
    expect(huge.sales).toHaveLength(17);
    expect((await searchSales(db.sql, SEPTEMBER)).pageSize).toBe(20);
  });

  it("searches by customer name (case-insensitive part of the name; walk-ins never match)", async () => {
    const result = await searchSales(db.sql, SEPTEMBER, { customer: "customer 0001" });
    expect(result).toMatchObject({ totalMatches: 2, totalRevenue: "1450.00" });
    expect(result.sales.map((sale) => sale.saleNumber)).toEqual(["INV-S-0203", "INV-N-0101"]);
    expect(await searchSales(db.sql, SEPTEMBER, { customer: "CUSTOMER" })).toMatchObject({ totalMatches: 8, totalRevenue: "5810.40" });
  });

  it("searches by item name (any sold line; wildcard characters are taken literally)", async () => {
    const result = await searchSales(db.sql, SEPTEMBER, { item: "consult" });
    expect(result).toMatchObject({ totalMatches: 4, totalRevenue: "2430.50" });
    expect(result.sales.map((sale) => sale.saleNumber)).toEqual(["INV-S-0203", "INV-N-0102", "INV-S-0201", "INV-N-0101"]);
    expect(await numbers({ item: '"amoxi" {250' })).toEqual(["INV-N-0101"]);
    expect(await numbers({ item: "%" })).toEqual([]);
    expect(await numbers({ item: "_" })).toEqual([]);
    // Discount lines are not items.
    expect(await numbers({ item: "LOYALTY" })).toEqual([]);
  });

  it("searches by doctor: invoices with at least one line credited to them, shown with the whole invoice's split", async () => {
    const alpha = await searchSales(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(alpha).toMatchObject({ totalMatches: 3, totalRevenue: "1830.50" });
    expect(alpha.sales.map((sale) => sale.saleNumber)).toEqual(["INV-S-0203", "INV-N-0102", "INV-N-0101"]);
    expect(alpha.sales[1]!.credits).toEqual([credit("Dr Alpha Anderson", "300.50", 2), credit("Dr Bravo Brown", "80.00", 1)]);
    // Ids that cannot be a staff member match nothing (never "everyone").
    expect(await searchSales(db.sql, { ...SEPTEMBER, doctorIds: ["not-an-id"] })).toMatchObject({ totalMatches: 0, totalRevenue: "0.00" });
  });

  it("filters by branch and by the invoice's revenue (inclusive), sorted by amount", async () => {
    expect(await numbers({ minRevenue: "0", sort: "largest" }, { ...SEPTEMBER, branchIds: [branch.south] })).toEqual([
      "INV-S-0202",
      "INV-S-0201",
      "INV-S-0203",
      "INV-S-0205",
    ]);
    const range = await searchSales(db.sql, SEPTEMBER, { minRevenue: "250", maxRevenue: "1200.00", sort: "smallest" });
    expect(range).toMatchObject({ totalMatches: 5, totalRevenue: "3530.50" });
    expect(range.sales.map((sale) => sale.saleNumber)).toEqual(["INV-S-0203", "INV-N-0102", "INV-S-0201", "INV-S-0202", "INV-N-0101"]);
    expect(await numbers({ maxRevenue: "-0.01" })).toEqual(["INV-S-0206"]);
    expect(await numbers({ sort: "oldest", pageSize: 3 })).toEqual(["INV-N-0101", "INV-S-0201", "INV-N-0102"]);
    // Criteria combine.
    expect(await numbers({ customer: "0004", item: "x-ray" })).toEqual(["INV-S-0201"]);
  });

  it("shows a sale whose line items are not synced yet at its net amount; doctor and item searches cannot find it", async () => {
    // 700104's header changes in Kreloses and its invoice page cannot be read this time.
    const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700104)!;
    row.PaymentStatusName = "Paid";
    row.TotalPayments = "2,438.00";
    h.clock.advance(3_600_000);
    let pageDown = true;
    h.fake.intercept((request) =>
      pageDown && request.url.pathname === "/Sale/Overview/700104" ? new Response("down", { status: 503 }) : undefined,
    );
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, maxRetries: 0 });

    const byCustomer = await searchSales(db.sql, SEPTEMBER, { customer: "Customer 0003" });
    expect(byCustomer.sales).toEqual([
      expect.objectContaining({
        saleNumber: "INV-N-0104",
        revenue: "2300.00",
        lineItemsSynced: false,
        credits: [{ staffId: null, name: "Line items not synced yet", creditGroup: "pending", revenue: "2300.00", lines: 0 }],
      }),
    ]);
    expect(await searchSales(db.sql, SEPTEMBER)).toMatchObject({ totalMatches: 9, totalRevenue: "5855.40" });
    expect(await numbers({ item: "dental" })).toEqual([]);
    expect(await numbers({}, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] })).toEqual(["INV-S-0203", "INV-S-0202", "INV-N-0102"]);

    pageDown = false;
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    expect(await numbers({ item: "dental" })).toEqual(["INV-N-0104"]);
  });
});
