import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { syntheticSales, type SyntheticSale } from "@/kreloses/testing/synthetic-sales";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { dailyComparisonDays, defaultDailyDay, getDailySales, getPendingLineItems, resolveDailyDay, type DailyMetric } from "./index";
import { dailyScenario } from "./testing/daily-scenario";

/**
 * Seam 1 for the Daily page (spec stories 53–54): the Sync Engine reads SYNTHETIC sales
 * (`dailyScenario`, src/analytics/testing/daily-scenario.ts, plus the leap-day sales below) from
 * the fake Kreloses into a throwaway database; `getDailySales` must return these HAND-COMPUTED
 * figures. Each line is credited exactly its own amount (no discounts in these sales).
 *
 * Day = Sunday 27 Sep 2026 · same weekday last week = Sunday 20 Sep 2026 · same date last year =
 * Saturday 27 Sep 2025. Customers are C1…C8; the walk-in (810005) is nobody.
 *
 *                      27 Sep 2026                        20 Sep 2026                  27 Sep 2025
 *   North   810001 C1 00:30 Alpha 150 + Bravo 50     810011 C1 Alpha 400          810021 C1 Alpha 1,000
 *           810002 C2 Alpha 300
 *           810003 C3 23:59 no staff 40
 *           → 540.00 · 3 inv · 3 cust · AOV 180.00   → 400.00 · 1 · 1 · 400.00    → 1,000.00 · 1 · 1 · 1,000.00
 *   South   810004 C1 Bravo 500                      810012 C7 Bravo 200 + no staff 50
 *           810005 —  South General 60 (generic)     810013 C7 Dr Delta 100
 *           810006 C4 Charlie 25 (other staff)
 *           → 585.00 · 3 · 2 (C1 C4) · 292.50         → 350.00 · 2 · 1 · 350.00    → 0 (none)
 *   Total   1,125.00 · 6 · 4 (C1 C2 C3 C4) · 281.25    750.00 · 3 · 2 · 375.00      1,000.00 · 1 · 1 · 1,000.00
 *   Not the day: 810007 (cancelled, 999.00), 810008 (26 Sep 23:50 KL, 111.00), 810009 (28 Sep 00:10 KL
 *   = 27 Sep 16:10 UTC, 222.00). 810001 at 00:30 KL is 26 Sep 16:30 UTC and belongs to 27 Sep.
 *
 *   Dr Bravo Brown     550.00 · 2 · 1 (C1) · 550.00    200.00 · 1 · 1 · 200.00      0
 *   Dr Alpha Anderson  450.00 · 2 · 2 · 225.00         400.00 · 1 · 1 · 400.00      1,000.00 · 1 · 1 · 1,000.00
 *   Dr Delta (not in the staff list)  0                100.00 · 1 · 1 · 100.00      0
 *   Other staff        25.00 · 1 · 1 · 25.00           0                            0
 *   Generic accounts   60.00 · 1 · 0 · no AOV          0                            0
 *   No staff on line   40.00 · 1 · 1 · 40.00           50.00 · 1 · 1 · 50.00        0
 *
 * Changes: value − base; % = change ÷ |base| × 100, half away from zero to one decimal, null when
 * the base is 0 (AOV: change and % null when either side has no customers).
 *
 * Leap day: Tue 29 Feb 2028 (820001, 100.00) vs Tue 22 Feb 2028 (820002, 50.00) and — there is no
 * 29 Feb 2027 — Sun 28 Feb 2027 (820003, 80.00). 820004 (1 Mar 2027 00:05 KL = 28 Feb 16:05 UTC,
 * 999.00) is not 28 Feb.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const DAY = "2026-09-27";

const LEAP_SALES: SyntheticSale[] = [
  { saleId: 820001, branch: "north", customer: 1, at: "2028-02-29 10:00", lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "100.00" }] },
  { saleId: 820002, branch: "north", customer: 1, at: "2028-02-22 10:00", lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "50.00" }] },
  { saleId: 820003, branch: "north", customer: 2, at: "2027-02-28 10:00", lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "80.00" }] },
  { saleId: 820004, branch: "north", customer: 2, at: "2027-03-01 00:05", lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "999.00" }] },
];

type Change<T> = [base: T, change: T, changePercent: number | null];
/** A metric with its changes vs the same weekday last week and the same date last year. */
function metric<T>(value: T, lastWeek: Change<T>, lastYear: Change<T>): DailyMetric<T> {
  return {
    value,
    lastWeek: { base: lastWeek[0], change: lastWeek[1], changePercent: lastWeek[2] },
    lastYear: { base: lastYear[0], change: lastYear[1], changePercent: lastYear[2] },
  };
}

describe("Analytics Service: daily sales (fed by the Sync Engine)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    const { rows, overviews } = syntheticSales([...dailyScenario(DAY), ...LEAP_SALES]);
    h = createSyncHarness(db.sql, { now: new Date("2028-03-02T02:00:00Z"), fake: { saleList: { rows }, saleOverviews: overviews } });
    connectionId = await h.connect(both, "Both branches");
    const result = await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2025-01-01", to: "2028-03-31" }, pageSize: 10 });
    expect(result).toMatchObject({ status: "succeeded", counts: { invoicesSeen: 17, inserted: 17, lineItemsRead: 16 } });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows2 = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows2.map((row) => [row.fullName, row.id]));
  });

  it("totals, branches, doctors and groups for the day, each compared with the same weekday last week and the same date last year", async () => {
    const daily = await getDailySales(db.sql, DAY);

    expect(daily.day).toBe(DAY);
    expect(daily.comparisonDays).toEqual({ lastWeek: "2026-09-20", lastYear: "2025-09-27" });
    expect(daily.total).toEqual({
      revenue: metric("1125.00", ["750.00", "375.00", 50], ["1000.00", "125.00", 12.5]),
      invoices: metric(6, [3, 3, 100], [1, 5, 500]),
      customers: metric(4, [2, 2, 100], [1, 3, 300]),
      aovPerCustomer: metric("281.25", ["375.00", "-93.75", -25], ["1000.00", "-718.75", -71.9]),
    });
    expect(daily.branches).toEqual([
      {
        branchId: branch.north,
        branchName: "Branch North",
        revenue: metric("540.00", ["400.00", "140.00", 35], ["1000.00", "-460.00", -46]),
        invoices: metric(3, [1, 2, 200], [1, 2, 200]),
        customers: metric(3, [1, 2, 200], [1, 2, 200]),
        aovPerCustomer: metric("180.00", ["400.00", "-220.00", -55], ["1000.00", "-820.00", -82]),
      },
      {
        branchId: branch.south,
        branchName: "Branch South",
        // Nothing at South on the same date last year: a zero base has a change but no percentage.
        revenue: metric("585.00", ["350.00", "235.00", 67.1], ["0.00", "585.00", null]),
        invoices: metric(3, [2, 1, 50], [0, 3, null]),
        customers: metric(2, [1, 1, 100], [0, 2, null]),
        aovPerCustomer: metric<string | null>("292.50", ["350.00", "-57.50", -16.4], [null, null, null]),
      },
    ]);
    expect(daily.doctors).toEqual([
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        revenue: metric("550.00", ["200.00", "350.00", 175], ["0.00", "550.00", null]),
        invoices: metric(2, [1, 1, 100], [0, 2, null]),
        customers: metric(1, [1, 0, 0], [0, 1, null]),
        aovPerCustomer: metric<string | null>("550.00", ["200.00", "350.00", 175], [null, null, null]),
      },
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        revenue: metric("450.00", ["400.00", "50.00", 12.5], ["1000.00", "-550.00", -55]),
        invoices: metric(2, [1, 1, 100], [1, 1, 100]),
        customers: metric(2, [1, 1, 100], [1, 1, 100]),
        aovPerCustomer: metric("225.00", ["400.00", "-175.00", -43.8], ["1000.00", "-775.00", -77.5]),
      },
      {
        // Sold nothing on the day, but did the same weekday last week: still listed, so the drop shows.
        staffId: staff["Dr Delta"],
        name: "Dr Delta",
        source: "alias_only",
        revenue: metric("0.00", ["100.00", "-100.00", -100], ["0.00", "0.00", null]),
        invoices: metric(0, [1, -1, -100], [0, 0, null]),
        customers: metric(0, [1, -1, -100], [0, 0, null]),
        aovPerCustomer: metric<string | null>(null, ["100.00", null, null], [null, null, null]),
      },
    ]);
    expect(daily.groups).toEqual([
      {
        group: "other",
        revenue: metric("25.00", ["0.00", "25.00", null], ["0.00", "25.00", null]),
        invoices: metric(1, [0, 1, null], [0, 1, null]),
        customers: metric(1, [0, 1, null], [0, 1, null]),
        aovPerCustomer: metric<string | null>("25.00", [null, null, null], [null, null, null]),
      },
      {
        group: "generic",
        revenue: metric("60.00", ["0.00", "60.00", null], ["0.00", "60.00", null]),
        invoices: metric(1, [0, 1, null], [0, 1, null]),
        customers: metric(0, [0, 0, null], [0, 0, null]),
        aovPerCustomer: metric<string | null>(null, [null, null, null], [null, null, null]),
      },
      {
        group: "noStaff",
        revenue: metric("40.00", ["50.00", "-10.00", -20], ["0.00", "40.00", null]),
        invoices: metric(1, [1, 0, 0], [0, 1, null]),
        customers: metric(1, [1, 0, 0], [0, 1, null]),
        aovPerCustomer: metric<string | null>("40.00", ["50.00", "-10.00", -20], [null, null, null]),
      },
    ]);
  });

  it("puts each sale on its clinic day (Asia/Kuala_Lumpur), not its UTC date", async () => {
    // 26 Sep 23:50 KL (810008) and 28 Sep 00:10 KL (810009, 27 Sep in UTC) are not 27 Sep.
    expect((await getDailySales(db.sql, "2026-09-26")).total.revenue.value).toBe("111.00");
    expect((await getDailySales(db.sql, "2026-09-28")).total.revenue.value).toBe("222.00");
    // 810001 at 00:30 KL (26 Sep in UTC) counts on the 27th: Branch North has 3 invoices that day.
    const north = (await getDailySales(db.sql, DAY)).branches.find((row) => row.branchName === "Branch North")!;
    expect(north.invoices.value).toBe(3);
  });

  it("compares 29 February with 28 February of the previous year", async () => {
    const leap = await getDailySales(db.sql, "2028-02-29");
    expect(leap.comparisonDays).toEqual({ lastWeek: "2028-02-22", lastYear: "2027-02-28" });
    expect(leap.total.revenue).toEqual(metric("100.00", ["50.00", "50.00", 100], ["80.00", "20.00", 25]));
  });

  it("a day with no sales on it or its comparison days: zeros, no percentages, every branch still listed", async () => {
    const quiet = await getDailySales(db.sql, "2026-09-13");
    expect(quiet.total).toEqual({
      revenue: metric("0.00", ["0.00", "0.00", null], ["0.00", "0.00", null]),
      invoices: metric(0, [0, 0, null], [0, 0, null]),
      customers: metric(0, [0, 0, null], [0, 0, null]),
      aovPerCustomer: metric<string | null>(null, [null, null, null], [null, null, null]),
    });
    expect(quiet.branches.map((row) => [row.branchName, row.revenue.value])).toEqual([
      ["Branch North", "0.00"],
      ["Branch South", "0.00"],
    ]);
    expect(quiet.doctors).toEqual([]);
    expect(quiet.groups).toEqual([]);
  });

  it("applies the branch filter", async () => {
    const south = await getDailySales(db.sql, DAY, { branchIds: [branch.south] });
    expect(south.branches.map((row) => row.branchName)).toEqual(["Branch South"]);
    expect(south.total.revenue).toEqual(metric("585.00", ["350.00", "235.00", 67.1], ["0.00", "585.00", null]));
    expect(south.total.customers.value).toBe(2);
    expect(south.doctors.map((row) => [row.name, row.revenue.value, row.revenue.lastWeek.base])).toEqual([
      ["Dr Bravo Brown", "500.00", "200.00"],
      ["Dr Delta", "0.00", "100.00"],
    ]);
    expect(south.groups.map((row) => [row.group, row.revenue.value, row.revenue.lastWeek.changePercent])).toEqual([
      ["other", "25.00", null],
      ["generic", "60.00", null],
      ["noStaff", "0.00", -100],
    ]);

    const nowhere = await getDailySales(db.sql, DAY, { branchIds: ["999999", "not-an-id"] });
    expect(nowhere.branches).toEqual([]);
    expect(nowhere.total.revenue.value).toBe("0.00");
    expect(nowhere.doctors).toEqual([]);
  });

  it("applies the doctor filter: only lines credited to the selected doctors, every branch still listed", async () => {
    const alpha = await getDailySales(db.sql, DAY, { doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(alpha.total).toEqual({
      revenue: metric("450.00", ["400.00", "50.00", 12.5], ["1000.00", "-550.00", -55]),
      invoices: metric(2, [1, 1, 100], [1, 1, 100]),
      customers: metric(2, [1, 1, 100], [1, 1, 100]),
      aovPerCustomer: metric("225.00", ["400.00", "-175.00", -43.8], ["1000.00", "-775.00", -77.5]),
    });
    expect(alpha.branches.map((row) => [row.branchName, row.revenue.value, row.invoices.value, row.revenue.lastWeek.base, row.revenue.lastYear.base])).toEqual([
      ["Branch North", "450.00", 2, "400.00", "1000.00"],
      ["Branch South", "0.00", 0, "0.00", "0.00"],
    ]);
    expect(alpha.doctors.map((row) => row.name)).toEqual(["Dr Alpha Anderson"]);
    expect(alpha.groups).toEqual([]);

    const both = await getDailySales(db.sql, DAY, { doctorIds: [staff["Dr Alpha Anderson"]!, staff["Dr Bravo Brown"]!], branchIds: [branch.north] });
    // 810001 is shared by Alpha and Bravo: one invoice, one customer.
    expect([both.total.revenue.value, both.total.invoices.value, both.total.customers.value]).toEqual(["500.00", 2, 2]);
    expect(both.doctors.map((row) => [row.name, row.revenue.value])).toEqual([
      ["Dr Alpha Anderson", "450.00"],
      ["Dr Bravo Brown", "50.00"],
    ]);
  });

  it("counts a sale whose line items are not synced yet at its net amount, as its own group (never with a doctor filter)", async () => {
    // A new South sale on the day whose invoice page cannot be opened: its lines stay unread.
    const [pending] = syntheticSales([
      { saleId: 810010, branch: "south", customer: 8, at: `${DAY} 13:00`, lines: [{ name: "Consultation", staff: "Dr Bravo", amount: "80.00" }], page: false },
    ]).rows;
    h.fake.saleRows.push(pending!);
    h.clock.advance(3_600_000);
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } })).toMatchObject({
      status: "partial",
      counts: { inserted: 1, lineItemsFailed: 1 },
    });

    const daily = await getDailySales(db.sql, DAY);
    // Revenue never drops: 1,125.00 + 80.00; C8 is a new customer.
    expect(daily.total.revenue).toEqual(metric("1205.00", ["750.00", "455.00", 60.7], ["1000.00", "205.00", 20.5]));
    expect([daily.total.invoices.value, daily.total.customers.value, daily.total.aovPerCustomer.value]).toEqual([7, 5, "241.00"]);
    const south = daily.branches.find((row) => row.branchName === "Branch South")!;
    expect([south.revenue.value, south.invoices.value, south.customers.value, south.aovPerCustomer.value]).toEqual(["665.00", 4, 3, "221.67"]);
    expect(daily.doctors.map((row) => [row.name, row.revenue.value])).toEqual([
      ["Dr Bravo Brown", "550.00"],
      ["Dr Alpha Anderson", "450.00"],
      ["Dr Delta", "0.00"],
    ]);
    expect(daily.groups.at(-1)).toEqual({
      group: "pending",
      revenue: metric("80.00", ["0.00", "80.00", null], ["0.00", "80.00", null]),
      invoices: metric(1, [0, 1, null], [0, 1, null]),
      customers: metric(1, [0, 1, null], [0, 1, null]),
      aovPerCustomer: metric<string | null>("80.00", [null, null, null], [null, null, null]),
    });

    // With a doctor filter it cannot be included (credited to nobody yet); the page says so from getPendingLineItems.
    const bravo = await getDailySales(db.sql, DAY, { doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(bravo.total.revenue.value).toBe("550.00");
    expect(bravo.groups).toEqual([]);
    expect(await getPendingLineItems(db.sql, { dateFrom: DAY, dateTo: DAY })).toEqual({ invoices: 1, revenue: "80.00" });
  });
});

describe("Daily comparison days", () => {
  it("same weekday last week is 7 days earlier; same date last year is the same calendar date, 29 Feb → 28 Feb", () => {
    expect(dailyComparisonDays("2026-09-27")).toEqual({ lastWeek: "2026-09-20", lastYear: "2025-09-27" });
    expect(dailyComparisonDays("2026-01-03")).toEqual({ lastWeek: "2025-12-27", lastYear: "2025-01-03" });
    expect(dailyComparisonDays("2028-02-29")).toEqual({ lastWeek: "2028-02-22", lastYear: "2027-02-28" });
    expect(dailyComparisonDays("2029-02-28")).toEqual({ lastWeek: "2029-02-21", lastYear: "2028-02-28" });
    expect(dailyComparisonDays("2028-03-01")).toEqual({ lastWeek: "2028-02-23", lastYear: "2027-03-01" });
  });
});

describe("The day the Daily page shows", () => {
  it("defaults to yesterday at the clinic (Asia/Kuala_Lumpur), not yesterday in UTC or on the server", () => {
    // 28 Sep 2026 00:30 in KL is still 27 Sep in UTC: yesterday at the clinic is 27 Sep.
    expect(defaultDailyDay(new Date("2026-09-27T16:30:00Z"))).toBe("2026-09-27");
    expect(defaultDailyDay(new Date("2026-09-28T15:59:00Z"))).toBe("2026-09-27"); // 23:59 KL on the 28th
    expect(defaultDailyDay(new Date("2026-09-28T16:00:00Z"))).toBe("2026-09-28"); // midnight KL: the 29th
    expect(defaultDailyDay(new Date("2028-03-01T01:00:00Z"))).toBe("2028-02-29");
  });

  it("takes a real date from the URL, else yesterday", () => {
    const now = new Date("2026-09-28T02:00:00Z");
    expect(resolveDailyDay("2026-09-01", now)).toBe("2026-09-01");
    expect(resolveDailyDay(["2026-08-31", "2026-09-01"], now)).toBe("2026-08-31");
    expect(resolveDailyDay(undefined, now)).toBe("2026-09-27");
    expect(resolveDailyDay("2026-02-30", now)).toBe("2026-09-27");
    expect(resolveDailyDay("yesterday", now)).toBe("2026-09-27");
    expect(resolveDailyDay("", now)).toBe("2026-09-27");
  });

  it("allows today (a day in progress) but not a future or implausibly old day", () => {
    const now = new Date("2026-09-28T02:00:00Z"); // 28 Sep 2026, 10:00 in KL
    expect(resolveDailyDay("2026-09-28", now)).toBe("2026-09-28");
    expect(resolveDailyDay("2026-09-29", now)).toBe("2026-09-27");
    expect(resolveDailyDay("2099-01-01", now)).toBe("2026-09-27");
    expect(resolveDailyDay("2000-01-01", now)).toBe("2000-01-01");
    expect(resolveDailyDay("1999-12-31", now)).toBe("2026-09-27");
    expect(resolveDailyDay("0100-06-15", now)).toBe("2026-09-27");
    // "Today" is the clinic's: at 00:30 on the 29th in KL (still the 28th in UTC), the 29th is allowed.
    expect(resolveDailyDay("2026-09-29", new Date("2026-09-28T16:30:00Z"))).toBe("2026-09-29");
  });
});
