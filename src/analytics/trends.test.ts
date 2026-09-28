import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS, type SaleListRow, type SaleOverviewModel } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getDoctorDetail, getDoctorRanking, getMonthlyTrends, getYearOnYear, trendMonths, type DoctorTrend, type TrendMonth } from "./index";

/**
 * Seam 1: the Sync Engine reads the shared synthetic Sale List + invoice pages
 * (src/kreloses/__fixtures__/sale-list-rows.json, sale-overviews.json) PLUS this test's own extra
 * sales (./__fixtures__/trend-sales.json) from the fake Kreloses into a throwaway database; the
 * trend queries must return exactly these HAND-COMPUTED figures (credited lines as in
 * doctors.test.ts; KL = Asia/Kuala_Lumpur, UTC+8; C1… = Customer 0001…).
 *
 * Doctors' credited lines by clinic month (branch, customer, invoice):
 *   2024-03  Dr Alpha   N C1 1,000.00 (500101)
 *   2024-11  Dr Bravo   S C5   400.00 (500102)
 *   2024-12  Dr Alpha   N C2   250.00 (500103: 31 Dec 23:30 KL)
 *   2025-03  Dr Bravo   N C7   800.00 (600101)
 *   2025-09  Dr Alpha   N C1 12,345.60 (600001) · Dr Bravo S C5 654.40 (600002) · no staff S 100.00 (600003)
 *   2025-10  Dr Alpha   N C3   999.00 (600004: 1 Oct 00:10 KL = 30 Sep 16:10 UTC)
 *   2025-12  Dr Alpha   N C1   655.40 (600102)
 *   2026-01  Dr Alpha   N C2   300.00 (800101: 1 Jan 2026 00:30 KL = 31 Dec 2025 16:30 UTC)
 *   2026-03  800102 S C4: Dr Bravo 200.00 + Dr Alpha 100.00 less a (30.00) discount line spread by
 *            what each charged → Dr Bravo 180.00 · Dr Alpha 90.00
 *   2026-08  Dr Alpha N C1 500.00 (700090: 31 Aug 23:50 KL) · Dr Bravo N C7 1,000.00 (700091, 15 Aug)
 *            · Dr Bravo S C8 300.00 (700093, 1 Aug) · Dr Delta S C4 800.00 (700092, 20 Aug)
 *   2026-09  (doctors.test.ts) Dr Alpha N 1,500.50 (C1 700101 at 1 Sep 00:30 KL = 31 Aug 16:30 UTC; C2)
 *            + S 153.85 (C1) · Dr Bravo N 2,155.85 (C2 C3) + S 1,196.15 (C5 C1) · Dr Delta S 480.00 (C4)
 *            · non-doctors: Charlie Chen (other) 45.00, generic accounts, no staff — never in a doctor series
 *   2026-10  Dr Bravo   N C3   150.00 (800103: 1 Oct 2026 00:30 KL = 30 Sep 16:30 UTC)
 * AOV per customer = revenue ÷ distinct customers with a line credited to the doctor, rounded half up to the sen.
 *
 * "Today" is 1 Oct 2026 (the harness clock: 2026-10-01T02:00Z = 10:00 KL) unless a test says otherwise.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const NOW = new Date("2026-10-01T02:00:00Z");
const extra = JSON.parse(readFileSync(new URL("./__fixtures__/trend-sales.json", import.meta.url), "utf8")) as {
  rows: SaleListRow[];
  models: Record<string, SaleOverviewModel>;
};

/** Months 2025-09 … 2026-10 (the 14 months of the long range below). */
const LONG_MONTHS = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
const LONG = { dateFrom: "2025-09-01", dateTo: "2026-10-01" };

describe("Analytics Service: monthly trends, year on year and doctor detail (fed by the Sync Engine)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  const series = (doctors: DoctorTrend[], field: "revenue" | "aovPerCustomer" | "customers" | "invoices") =>
    Object.fromEntries(doctors.map((doctor) => [doctor.name, doctor.points.map((point) => point[field])]));

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: NOW });
    h.fake.saleRows.push(...extra.rows);
    Object.assign(h.fake.saleOverviews, extra.models);
    connectionId = await h.connect(both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2024-01-01", to: "2026-10-01" }, pageSize: 10 })).toMatchObject({
      status: "succeeded",
      counts: { invoicesSeen: 28, inserted: 28, lineItemsRead: 25 },
    });
    expect(await db.sql`select 1 from invoices where status = 'active' and not lines_current`).toEqual([]);
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  describe("months of a date range", () => {
    it("lists each calendar month the range overlaps, up to the current month, labelling partial ones", () => {
      expect(trendMonths({ dateFrom: "2026-07-15", dateTo: "2026-12-31" }, "2026-10-01")).toEqual([
        { month: "2026-07", dateFrom: "2026-07-15", dateTo: "2026-07-31", partial: true, partialReason: "cut_by_range" },
        { month: "2026-08", dateFrom: "2026-08-01", dateTo: "2026-08-31", partial: false, partialReason: null },
        { month: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", partial: false, partialReason: null },
        // The current month is still going; months after it are not listed at all.
        { month: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-31", partial: true, partialReason: "current_month" },
      ]);
      // A range that ends before today, inside the current month: cut by the range, not "so far".
      expect(trendMonths({ dateFrom: "2026-09-01", dateTo: "2026-09-15" }, "2026-09-28")).toEqual([
        { month: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-15", partial: true, partialReason: "cut_by_range" },
      ]);
      // Across a year end, and a February in a leap year.
      expect(trendMonths({ dateFrom: "2027-12-01", dateTo: "2028-02-29" }, "2028-06-01").map((month) => [month.month, month.dateTo, month.partial])).toEqual([
        ["2027-12", "2027-12-31", false],
        ["2028-01", "2028-01-31", false],
        ["2028-02", "2028-02-29", false],
      ]);
      // Entirely in the future: nothing.
      expect(trendMonths({ dateFrom: "2026-11-01", dateTo: "2026-12-31" }, "2026-10-01")).toEqual([]);
    });
  });

  describe("getMonthlyTrends", () => {
    it("gives each doctor's revenue per clinic month (KL month boundaries), highest total first", async () => {
      const trends = await getMonthlyTrends(db.sql, LONG, { now: NOW });
      expect(trends.period).toEqual(LONG);
      expect(trends.months.map((month) => month.month)).toEqual(LONG_MONTHS);
      expect(trends.months.filter((month) => month.partial)).toEqual([
        { month: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-01", partial: true, partialReason: "current_month" },
      ]);
      expect(trends.doctors.map((doctor) => [doctor.name, doctor.staffId, doctor.source])).toEqual([
        ["Dr Alpha Anderson", staff["Dr Alpha Anderson"], "kreloses"],
        ["Dr Bravo Brown", staff["Dr Bravo Brown"], "kreloses"],
        ["Dr Delta", staff["Dr Delta"], "alias_only"],
      ]);
      //                                  2025-09     10        11      12        2026-01   02      03       04      05      06      07      08         09         10
      expect(series(trends.doctors, "revenue")).toEqual({
        "Dr Alpha Anderson": ["12345.60", "999.00", "0.00", "655.40", "300.00", "0.00", "90.00", "0.00", "0.00", "0.00", "0.00", "500.00", "1654.35", "0.00"],
        "Dr Bravo Brown": ["654.40", "0.00", "0.00", "0.00", "0.00", "0.00", "180.00", "0.00", "0.00", "0.00", "0.00", "1300.00", "3352.00", "150.00"],
        "Dr Delta": ["0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "800.00", "480.00", "0.00"],
      });
      // KL month boundaries: 700101 (1 Sep 00:30 KL, still 31 Aug in UTC) is September's, so Dr Alpha's
      // August is only 700090 (31 Aug 23:50 KL); 600004 (1 Oct 2025 00:10 KL) is October's; 800101
      // (1 Jan 2026 00:30 KL) is January 2026's; 800103 (1 Oct 2026 00:30 KL) is October 2026's.
      expect(series(trends.doctors, "customers")).toEqual({
        "Dr Alpha Anderson": [1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 2, 0],
        "Dr Bravo Brown": [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 4, 1],
        "Dr Delta": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0],
      });
      expect(series(trends.doctors, "invoices")).toEqual({
        "Dr Alpha Anderson": [1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 3, 0],
        "Dr Bravo Brown": [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 4, 1],
        "Dr Delta": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0],
      });
      expect(trends.doctors.every((doctor) => doctor.points.every((point, index) => point.month === LONG_MONTHS[index]))).toBe(true);
      // Totals over the whole range (AOV counted over the range: a customer seen in two months counts once).
      expect(Object.fromEntries(trends.doctors.map((doctor) => [doctor.name, doctor.total]))).toEqual({
        "Dr Alpha Anderson": { revenue: "16544.35", invoices: 9, customers: 4, aovPerCustomer: "4136.09", surgeryRevenue: null, consultRevenue: null },
        "Dr Bravo Brown": { revenue: "5636.40", invoices: 9, customers: 7, aovPerCustomer: "805.20", surgeryRevenue: null, consultRevenue: null },
        "Dr Delta": { revenue: "1280.00", invoices: 3, customers: 1, aovPerCustomer: "1280.00", surgeryRevenue: null, consultRevenue: null },
      });
    });

    it("gives each doctor's AOV per customer per month: the month's revenue ÷ that month's distinct customers", async () => {
      const trends = await getMonthlyTrends(db.sql, LONG, { now: NOW });
      expect(series(trends.doctors, "aovPerCustomer")).toEqual({
        // 2026-09: 1,654.35 ÷ 2 (C1 at both branches counts once) = 827.175 → 827.18
        "Dr Alpha Anderson": ["12345.60", "999.00", null, "655.40", "300.00", null, "90.00", null, null, null, null, "500.00", "827.18", null],
        // 2026-08: 1,300.00 ÷ 2 (C7 North, C8 South)
        "Dr Bravo Brown": ["654.40", null, null, null, null, null, "180.00", null, null, null, null, "650.00", "838.00", "150.00"],
        "Dr Delta": [null, null, null, null, null, null, null, null, null, null, null, "800.00", "480.00", null],
      });
    });

    it("honours the branch filter (AOV counted within the branch) and ranks by the branch's revenue", async () => {
      const south = await getMonthlyTrends(db.sql, { ...LONG, branchIds: [branch.south] }, { now: NOW });
      expect(south.doctors.map((doctor) => [doctor.name, doctor.total.revenue])).toEqual([
        ["Dr Bravo Brown", "2330.55"],
        ["Dr Delta", "1280.00"],
        ["Dr Alpha Anderson", "243.85"],
      ]);
      expect(series(south.doctors, "revenue")).toEqual({
        "Dr Bravo Brown": ["654.40", "0.00", "0.00", "0.00", "0.00", "0.00", "180.00", "0.00", "0.00", "0.00", "0.00", "300.00", "1196.15", "0.00"],
        "Dr Delta": ["0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "800.00", "480.00", "0.00"],
        "Dr Alpha Anderson": ["0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "90.00", "0.00", "0.00", "0.00", "0.00", "0.00", "153.85", "0.00"],
      });
      // 1,196.15 ÷ 2 (C5, C1) = 598.075 → 598.08
      expect(south.doctors[0]!.points[12]).toEqual({ month: "2026-09", revenue: "1196.15", invoices: 2, customers: 2, aovPerCustomer: "598.08", surgeryRevenue: null, consultRevenue: null });

      const north = await getMonthlyTrends(db.sql, { ...LONG, branchIds: [branch.north] }, { now: NOW });
      expect(north.doctors.map((doctor) => [doctor.name, doctor.total.revenue])).toEqual([
        ["Dr Alpha Anderson", "16300.50"],
        ["Dr Bravo Brown", "3305.85"],
      ]);
    });

    it("honours the doctor filter; non-doctor staff never get a series", async () => {
      const alpha = await getMonthlyTrends(db.sql, { ...LONG, doctorIds: [staff["Dr Alpha Anderson"]!] }, { now: NOW });
      expect(alpha.doctors.map((doctor) => doctor.name)).toEqual(["Dr Alpha Anderson"]);
      expect(alpha.doctors[0]!.total.revenue).toBe("16544.35");
      // Charlie Chen is "other" staff: selecting him gives no doctor series at all.
      expect((await getMonthlyTrends(db.sql, { ...LONG, doctorIds: [staff["Charlie Chen"]!] }, { now: NOW })).doctors).toEqual([]);
      expect((await getMonthlyTrends(db.sql, { ...LONG, doctorIds: ["999999", "not-an-id"] }, { now: NOW })).doctors).toEqual([]);
    });

    it("labels a first month cut by the date range and the current month as partial, with figures for the days covered", async () => {
      // 15 Aug – 30 Sep 2026: August counts from the 15th (700093 on 1 Aug is left out).
      const cut = await getMonthlyTrends(db.sql, { dateFrom: "2026-08-15", dateTo: "2026-09-30" }, { now: NOW });
      expect(cut.months).toEqual([
        { month: "2026-08", dateFrom: "2026-08-15", dateTo: "2026-08-31", partial: true, partialReason: "cut_by_range" },
        { month: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", partial: false, partialReason: null },
      ]);
      expect(series(cut.doctors, "revenue")).toEqual({
        "Dr Bravo Brown": ["1000.00", "3352.00"],
        "Dr Alpha Anderson": ["500.00", "1654.35"],
        "Dr Delta": ["800.00", "480.00"],
      });

      // On 28 Sep 2026, September is the current month: partial even though the range covers all of it;
      // later months of the range are not listed yet.
      const current = await getMonthlyTrends(db.sql, { dateFrom: "2026-09-01", dateTo: "2026-12-31" }, { now: new Date("2026-09-28T04:00:00Z") });
      expect(current.months).toEqual([{ month: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", partial: true, partialReason: "current_month" }]);
      expect(current.doctors.map((doctor) => [doctor.name, doctor.points.map((point) => point.revenue)])).toEqual([
        ["Dr Bravo Brown", ["3352.00"]],
        ["Dr Alpha Anderson", ["1654.35"]],
        ["Dr Delta", ["480.00"]],
      ]);
    });

    it("returns no months and no doctors for a range with no sales or in the future", async () => {
      expect(await getMonthlyTrends(db.sql, { dateFrom: "2026-11-01", dateTo: "2026-12-31" }, { now: NOW })).toEqual({
        period: { dateFrom: "2026-11-01", dateTo: "2026-12-31" },
        months: [],
        doctors: [],
      });
      const empty = await getMonthlyTrends(db.sql, { dateFrom: "2026-05-01", dateTo: "2026-06-30" }, { now: NOW });
      expect(empty.months.map((month) => month.month)).toEqual(["2026-05", "2026-06"]);
      expect(empty.doctors).toEqual([]);
    });
  });

  describe("getYearOnYear", () => {
    const cell = (year: number, revenue: string, invoices: number, customers: number, aovPerCustomer: string | null) => ({ year, revenue, invoices, customers, aovPerCustomer });

    it("compares full calendar years per doctor and branch; the current year to date is compared with the same dates last year", async () => {
      const yoy = await getYearOnYear(db.sql, {}, { now: NOW });
      expect(yoy.years).toEqual([
        { year: 2024, dateFrom: "2024-01-01", dateTo: "2024-12-31", partial: false, comparedWith: null },
        { year: 2025, dateFrom: "2025-01-01", dateTo: "2025-12-31", partial: false, comparedWith: { dateFrom: "2024-01-01", dateTo: "2024-12-31" } },
        // 2026 so far (to 1 Oct) against 1 Jan – 1 Oct 2025, never against the whole of 2025.
        { year: 2026, dateFrom: "2026-01-01", dateTo: "2026-10-01", partial: true, comparedWith: { dateFrom: "2025-01-01", dateTo: "2025-10-01" } },
      ]);
      const rows = yoy.rows.map((row) => ({
        doctor: row.name,
        branch: row.branchName,
        years: row.years.map(({ year, revenue, invoices, customers, aovPerCustomer }) => cell(year, revenue, invoices, customers, aovPerCustomer)),
        changes: row.years.map((year) => [year.revenueChangePercent, year.aovChangePercent]),
      }));
      expect(rows).toEqual([
        // Dr Alpha works at both branches: a row for both together (customers counted once), then each branch.
        {
          doctor: "Dr Alpha Anderson",
          branch: null,
          // 2024: 500101 + 500103 · 2025: 600001 + 600004 + 600102 · 2026: N 300.00 + 500.00 + 1,500.50, S 90.00 + 153.85 (C1 C2 C4)
          years: [cell(2024, "1250.00", 2, 2, "625.00"), cell(2025, "14000.00", 3, 2, "7000.00"), cell(2026, "2544.35", 6, 3, "848.12")],
          // 2025 vs 2024: +1,020.0 %; 2026 vs 1 Jan – 1 Oct 2025 (13,344.60 · 2 customers · 6,672.30): −80.9 % / −87.3 %
          changes: [[null, null], [1020, 1020], [-80.9, -87.3]],
        },
        {
          doctor: "Dr Alpha Anderson",
          branch: "Branch North",
          years: [cell(2024, "1250.00", 2, 2, "625.00"), cell(2025, "14000.00", 3, 2, "7000.00"), cell(2026, "2300.50", 4, 2, "1150.25")],
          changes: [[null, null], [1020, 1020], [-82.8, -82.8]],
        },
        {
          doctor: "Dr Alpha Anderson",
          branch: "Branch South",
          years: [cell(2024, "0.00", 0, 0, null), cell(2025, "0.00", 0, 0, null), cell(2026, "243.85", 2, 2, "121.93")],
          changes: [[null, null], [null, null], [null, null]], // nothing to compare with
        },
        {
          doctor: "Dr Bravo Brown",
          branch: null,
          // 2026: N 1,000.00 + 2,155.85 + 150.00 (800103 on 1 Oct = today) · S 180.00 + 300.00 + 1,196.15; 7 customers
          years: [cell(2024, "400.00", 1, 1, "400.00"), cell(2025, "1454.40", 2, 2, "727.20"), cell(2026, "4982.00", 8, 7, "711.71")],
          changes: [[null, null], [263.6, 81.8], [242.5, -2.1]],
        },
        {
          doctor: "Dr Bravo Brown",
          branch: "Branch North",
          years: [cell(2024, "0.00", 0, 0, null), cell(2025, "800.00", 1, 1, "800.00"), cell(2026, "3305.85", 4, 3, "1101.95")],
          changes: [[null, null], [null, null], [313.2, 37.7]],
        },
        {
          doctor: "Dr Bravo Brown",
          branch: "Branch South",
          years: [cell(2024, "400.00", 1, 1, "400.00"), cell(2025, "654.40", 1, 1, "654.40"), cell(2026, "1676.15", 4, 4, "419.04")],
          changes: [[null, null], [63.6, 63.6], [156.1, -36]],
        },
        // Dr Delta only ever worked at South: no "both branches" row.
        {
          doctor: "Dr Delta",
          branch: "Branch South",
          years: [cell(2024, "0.00", 0, 0, null), cell(2025, "0.00", 0, 0, null), cell(2026, "1280.00", 3, 1, "1280.00")],
          changes: [[null, null], [null, null], [null, null]],
        },
      ]);
      // Each year carries what it was compared with: the previous full year, or (the current year) the same dates last year.
      const alpha = yoy.rows[0]!;
      expect(alpha.years.map((year) => year.base)).toEqual([
        null,
        { revenue: "1250.00", invoices: 2, customers: 2, aovPerCustomer: "625.00" },
        { revenue: "13344.60", invoices: 2, customers: 2, aovPerCustomer: "6672.30" }, // 600001 + 600004 (1 Oct 2025 00:10 KL); not 600102 (Dec)
      ]);
      expect(yoy.rows.map((row) => [row.staffId, row.branchId])).toEqual([
        [staff["Dr Alpha Anderson"], null],
        [staff["Dr Alpha Anderson"], branch.north],
        [staff["Dr Alpha Anderson"], branch.south],
        [staff["Dr Bravo Brown"], null],
        [staff["Dr Bravo Brown"], branch.north],
        [staff["Dr Bravo Brown"], branch.south],
        [staff["Dr Delta"], branch.south],
      ]);
    });

    it("ignores the date range but honours the branch and doctor filters", async () => {
      const north = await getYearOnYear(db.sql, { dateFrom: "2026-09-01", dateTo: "2026-09-30", branchIds: [branch.north] }, { now: NOW });
      expect(north.years.map((year) => year.year)).toEqual([2024, 2025, 2026]);
      expect(north.rows.map((row) => [row.name, row.branchName, row.years.map((year) => year.revenue)])).toEqual([
        ["Dr Alpha Anderson", "Branch North", ["1250.00", "14000.00", "2300.50"]],
        ["Dr Bravo Brown", "Branch North", ["0.00", "800.00", "3305.85"]],
      ]);

      const delta = await getYearOnYear(db.sql, { doctorIds: [staff["Dr Delta"]!] }, { now: NOW });
      expect(delta.years.map((year) => year.year)).toEqual([2024, 2025, 2026]); // the clinic's years, not just Dr Delta's
      expect(delta.rows.map((row) => [row.name, row.branchName, row.years.map((year) => year.revenue)])).toEqual([["Dr Delta", "Branch South", ["0.00", "0.00", "1280.00"]]]);
    });

    it("on 28 Sep 2026 the year to date stops at today, on both sides of the comparison", async () => {
      const yoy = await getYearOnYear(db.sql, { branchIds: [branch.south] }, { now: new Date("2026-09-28T04:00:00Z") });
      expect(yoy.years.at(-1)).toEqual({ year: 2026, dateFrom: "2026-01-01", dateTo: "2026-09-28", partial: true, comparedWith: { dateFrom: "2025-01-01", dateTo: "2025-09-28" } });
      const bravo = yoy.rows.find((row) => row.name === "Dr Bravo Brown")!;
      // 2026 to 28 Sep at South: 180.00 + 300.00 + 1,196.15 (nothing after the 28th) vs 654.40 (21 Sep 2025).
      expect(bravo.years.at(-1)).toMatchObject({ revenue: "1676.15", base: { revenue: "654.40" }, revenueChangePercent: 156.1 });
    });

    it("has no years and no rows before anything is synced for the branches", async () => {
      expect(await getYearOnYear(db.sql, { branchIds: ["999999"] }, { now: NOW })).toEqual({ years: [], rows: [] });
    });
  });

  describe("getDoctorDetail", () => {
    const AUG_SEP = { dateFrom: "2026-08-01", dateTo: "2026-09-30" };

    it("gives a doctor's KPIs (the ranking's own figures), branch split and monthly trend for the filter", async () => {
      const detail = await getDoctorDetail(db.sql, staff["Dr Alpha Anderson"]!, AUG_SEP, { now: NOW });
      expect(detail.status).toBe("ok");
      if (detail.status !== "ok") return;
      expect(detail.doctor).toEqual({ staffId: staff["Dr Alpha Anderson"], name: "Dr Alpha Anderson", source: "kreloses", active: true });
      // 500.00 + 1,654.35 · invoices 700090 700101 700102 700203 · customers C1 C2 · 8 lines ÷ 4 · share of 8,455.40 (all Aug + Sep revenue)
      expect(detail.figures).toEqual({ revenue: "2154.35", invoices: 4, customers: 2, aovPerCustomer: "1077.18", itemsPerInvoice: 2, sharePercent: 25.5 });
      expect(detail.totalRevenue).toBe("8455.40");
      const ranked = (await getDoctorRanking(db.sql, AUG_SEP, { splitByBranch: true })).doctors.find((doctor) => doctor.name === "Dr Alpha Anderson")!;
      expect(detail.figures).toEqual({
        revenue: ranked.revenue,
        invoices: ranked.invoices,
        customers: ranked.customers,
        aovPerCustomer: ranked.aovPerCustomer,
        itemsPerInvoice: ranked.itemsPerInvoice,
        sharePercent: ranked.sharePercent,
      });
      expect(detail.branches).toEqual(ranked.branches);
      expect(detail.branches.map((row) => [row.branchName, row.revenue, row.customers, row.aovPerCustomer])).toEqual([
        ["Branch North", "2000.50", 2, "1000.25"],
        ["Branch South", "153.85", 1, "153.85"],
      ]);
      expect(detail.months.map((month: TrendMonth) => month.month)).toEqual(["2026-08", "2026-09"]);
      expect(detail.monthly.map((point) => [point.month, point.revenue, point.customers, point.aovPerCustomer])).toEqual([
        ["2026-08", "500.00", 1, "500.00"],
        ["2026-09", "1654.35", 2, "827.18"],
      ]);
      expect(detail.pendingLineItems).toEqual({ invoices: 0, revenue: "0.00" });
    });

    it("ignores the global doctor filter (the page is for one doctor) but keeps the branch filter", async () => {
      const detail = await getDoctorDetail(db.sql, staff["Dr Alpha Anderson"]!, { ...AUG_SEP, branchIds: [branch.south], doctorIds: [staff["Dr Bravo Brown"]!] }, { now: NOW });
      expect(detail).toMatchObject({ status: "ok", figures: { revenue: "153.85", customers: 1 } });
      if (detail.status !== "ok") return;
      expect(detail.monthly.map((point) => point.revenue)).toEqual(["0.00", "153.85"]);
    });

    it("gives zeros for a doctor with nothing in the period", async () => {
      const detail = await getDoctorDetail(db.sql, staff["Dr Delta"]!, { dateFrom: "2026-05-01", dateTo: "2026-06-30" }, { now: NOW });
      expect(detail).toMatchObject({
        status: "ok",
        doctor: { name: "Dr Delta", source: "alias_only" },
        figures: { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null, itemsPerInvoice: null, sharePercent: null },
        branches: [],
      });
      if (detail.status !== "ok") return;
      expect(detail.monthly.map((point) => [point.month, point.revenue, point.aovPerCustomer])).toEqual([
        ["2026-05", "0.00", null],
        ["2026-06", "0.00", null],
      ]);
    });

    it("tells apart an unknown id and a staff member who is not a doctor", async () => {
      expect(await getDoctorDetail(db.sql, "999999", AUG_SEP, { now: NOW })).toEqual({ status: "not_found" });
      expect(await getDoctorDetail(db.sql, "not-an-id", AUG_SEP, { now: NOW })).toEqual({ status: "not_found" });
      expect(await getDoctorDetail(db.sql, staff["Charlie Chen"]!, AUG_SEP, { now: NOW })).toEqual({
        status: "not_a_doctor",
        staff: { staffId: staff["Charlie Chen"], name: "Charlie Chen", kind: "other" },
      });
      expect(await getDoctorDetail(db.sql, staff["Branch North General"]!, AUG_SEP, { now: NOW })).toMatchObject({ status: "not_a_doctor", staff: { kind: "generic" } });
    });
  });

  it("leaves sales whose line items are not synced yet out of every doctor series (they are credited to nobody yet)", async () => {
    // A new September sale whose invoice page cannot be opened: it stays "line items not synced yet".
    h.fake.saleRows.push({ ...extra.rows.find((row) => row.SaleId === 800103)!, SaleId: 800199, SaleName: "INV-N-800199", SaleDate: "/Date(1789358400000)/" }); // 14 Sep 2026 12:00 KL
    h.clock.advance(3_600_000);
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } })).toMatchObject({
      status: "partial",
      counts: { lineItemsFailed: 1 },
    });
    const september = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    const trends = await getMonthlyTrends(db.sql, september, { now: NOW });
    expect(trends.doctors.map((doctor) => [doctor.name, doctor.points[0]!.revenue])).toEqual([
      ["Dr Bravo Brown", "3352.00"],
      ["Dr Alpha Anderson", "1654.35"],
      ["Dr Delta", "480.00"],
    ]);
    const detail = await getDoctorDetail(db.sql, staff["Dr Bravo Brown"]!, september, { now: NOW });
    expect(detail).toMatchObject({ status: "ok", figures: { revenue: "3352.00" }, pendingLineItems: { invoices: 1, revenue: "150.00" } });
    const yoy = await getYearOnYear(db.sql, { branchIds: [branch.north] }, { now: NOW });
    expect(yoy.rows.find((row) => row.name === "Dr Bravo Brown")!.years.at(-1)!.revenue).toBe("3305.85");
  });
});
