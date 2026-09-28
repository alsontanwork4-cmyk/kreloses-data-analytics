import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { syntheticSales } from "@/kreloses/testing/synthetic-sales";
import { runSync } from "@/sync/engine";
import { createSyncHarness } from "@/sync/test-support";

import { getDoctorRanking, getRevenuePerWorkingDay } from "./index";

/**
 * Working days on HAND-BUILT sales (October 2026, KL times; the seeded item rules classify them):
 *
 *   800001  5 Oct 10:00  North  Dr Alpha  Consultation          100.00  consult
 *   800002  5 Oct 15:00  South  Dr Alpha  Surgery - Spay        800.00  surgery (procedure)
 *   800003  6 Oct 11:00  North  Dr Alpha  Vaccination - Rabies  150.00  neither → not a working day
 *   800004  7 Oct 09:00  South  Dr Alpha  Sedation              200.00  surgery (sedation only)
 *   800005  7 Oct 10:00  North  Dr Bravo  Consultation           60.00  consult
 *   800006  8 Oct 00:30  South  Dr Bravo  Consultation           90.00  consult (7 Oct 16:30 UTC: a KL 8 Oct)
 *   800007  9 Oct 10:00  North  Dr Alpha  Consultation          100.00  CANCELLED → never counts
 *
 *   Dr Alpha Anderson: 1,250.00 over 2 working days (5 Oct — consult at North + surgery at South is ONE
 *     day — and 7 Oct) → 625.00. North only: 250.00 ÷ the same 2 days = 125.00; South: 1,000.00 ÷ 2 = 500.00.
 *   Dr Bravo Brown: 150.00 over 2 days (7 and 8 Oct) → 75.00.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const OCTOBER = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };

const SALES = syntheticSales([
  { saleId: 800001, branch: "north", at: "2026-10-05 10:00", customer: 1, lines: [{ name: "Consultation", amount: "100.00", staff: "Dr Alpha" }] },
  { saleId: 800002, branch: "south", at: "2026-10-05 15:00", customer: 2, lines: [{ name: "Surgery - Spay", amount: "800.00", staff: "Dr Alpha" }] },
  { saleId: 800003, branch: "north", at: "2026-10-06 11:00", customer: 1, lines: [{ name: "Vaccination - Rabies", amount: "150.00", staff: "Dr Alpha" }] },
  // Two units at 100.00 (the quantity / unit price form of a line).
  { saleId: 800004, branch: "south", at: "2026-10-07 09:00", customer: 3, lines: [{ name: "Sedation", quantity: 2, unitPrice: "100.00", amount: "200.00", staff: "Dr Alpha" }] },
  { saleId: 800005, branch: "north", at: "2026-10-07 10:00", customer: 4, lines: [{ name: "Consultation", amount: "60.00", staff: "Dr Bravo" }] },
  { saleId: 800006, branch: "south", at: "2026-10-08 00:30", customer: 4, lines: [{ name: "Consultation", amount: "90.00", staff: "Dr Bravo" }] },
  { saleId: 800007, branch: "north", at: "2026-10-09 10:00", customer: 1, status: "Cancelled", lines: [{ name: "Consultation", amount: "100.00", staff: "Dr Alpha" }] },
]);

describe("Analytics Service: revenue per working day (hand-built sales)", () => {
  const db = useTestDatabase();
  let staff: Record<string, string>;
  let branch: { north: string; south: string };

  beforeAll(async () => {
    const h = createSyncHarness(db.sql, { now: new Date("2026-11-01T02:00:00Z"), fake: { saleList: { rows: SALES.rows }, saleOverviews: SALES.overviews } });
    const connectionId = await h.connect(both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-10-01", to: "2026-10-31" } })).toMatchObject({
      status: "succeeded",
      counts: { invoicesSeen: 7, lineItemsRead: 6 },
    });
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
  });

  it("counts a consult at one branch and a surgery at the other on the same clinic day as ONE working day", async () => {
    const days = await getRevenuePerWorkingDay(db.sql, OCTOBER);
    expect(days[staff["Dr Alpha Anderson"]!]).toEqual({ staffId: staff["Dr Alpha Anderson"], revenue: "1250.00", workingDays: 2, revenuePerWorkingDay: "625.00" });
    expect(days[staff["Dr Bravo Brown"]!]).toEqual({ staffId: staff["Dr Bravo Brown"], revenue: "150.00", workingDays: 2, revenuePerWorkingDay: "75.00" });
    // The revenue is the doctor ranking's revenue.
    const ranking = await getDoctorRanking(db.sql, OCTOBER);
    expect(ranking.doctors.map((doctor) => [doctor.name, doctor.revenue])).toEqual([
      ["Dr Alpha Anderson", "1250.00"],
      ["Dr Bravo Brown", "150.00"],
    ]);
  });

  it("uses clinic days (a sale at 00:30 KL is the next day) and the period's dates", async () => {
    const days = await getRevenuePerWorkingDay(db.sql, { dateFrom: "2026-10-05", dateTo: "2026-10-07" });
    expect(days[staff["Dr Bravo Brown"]!]).toMatchObject({ revenue: "60.00", workingDays: 1, revenuePerWorkingDay: "60.00" });
    expect(days[staff["Dr Alpha Anderson"]!]).toMatchObject({ revenue: "1250.00", workingDays: 2 });
    const sixth = await getRevenuePerWorkingDay(db.sql, { dateFrom: "2026-10-06", dateTo: "2026-10-06" });
    expect(sixth[staff["Dr Alpha Anderson"]!]).toEqual({ staffId: staff["Dr Alpha Anderson"], revenue: "150.00", workingDays: 0, revenuePerWorkingDay: null });
  });

  it("a branch filter narrows the revenue but not the working days (days at either branch count)", async () => {
    const north = await getRevenuePerWorkingDay(db.sql, { ...OCTOBER, branchIds: [branch.north] });
    expect(north[staff["Dr Alpha Anderson"]!]).toMatchObject({ revenue: "250.00", workingDays: 2, revenuePerWorkingDay: "125.00" });
    const south = await getRevenuePerWorkingDay(db.sql, { ...OCTOBER, branchIds: [branch.south] });
    expect(south[staff["Dr Alpha Anderson"]!]).toMatchObject({ revenue: "1000.00", workingDays: 2, revenuePerWorkingDay: "500.00" });
    expect(south[staff["Dr Bravo Brown"]!]).toMatchObject({ revenue: "90.00", workingDays: 2, revenuePerWorkingDay: "45.00" });

    const split = await getRevenuePerWorkingDay(db.sql, OCTOBER, { splitByBranch: true });
    expect(split[staff["Dr Alpha Anderson"]!]!.branches).toEqual([
      { branchId: branch.north, revenue: "250.00", revenuePerWorkingDay: "125.00" },
      { branchId: branch.south, revenue: "1000.00", revenuePerWorkingDay: "500.00" },
    ]);

    const onlyBravo = await getRevenuePerWorkingDay(db.sql, { ...OCTOBER, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(Object.keys(onlyBravo)).toEqual([staff["Dr Bravo Brown"]]);
  });
});
