import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { assignItem } from "@/items/store";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { syntheticSales } from "@/kreloses/testing/synthetic-sales";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness } from "@/sync/test-support";

import { getSurgeryDepartment, getTopProcedures, getVaccineDentalRevenue, METRIC_DEFINITIONS, POST_OP_FOLLOW_UP_DAYS, type SurgeryFigures } from "./index";
import { SURGERY_SCENARIO, SURGERY_SCENARIO_ASSIGNMENTS } from "./testing/surgery-scenario";

/**
 * Seam 1 for the surgery department, vaccines and dental (#15): the Sync Engine reads the
 * hand-built sales of ./testing/surgery-scenario.ts (listed there) through the fake Kreloses into a
 * throwaway database, the scenario's own item names are classified by explicit owner assignments,
 * and the Analytics Service must return these HAND-COMPUTED figures.
 *
 * September 2026 — surgery CASES (active sales whose line items are synced, with ≥ 1 sold surgery line):
 *
 *   sale    branch day    customer  surgery lines (P = procedure)                fee      whole visit  kind
 *   950001  N      09-01  C1        Alpha Spay(P) 800 + Alpha Sedation 150        950.00   1,000.00     operation
 *   950003  S      09-02  C2        Bravo Sedation 200                            200.00     280.00     sedation only
 *   950005  N      09-03  C3        Alpha Spay(P) 900, Bravo Mass(P) 600 +
 *                                   Bravo Sedation 100                          1,600.00   1,640.00     operation (two doctors)
 *   950013  S      09-05  walk-in   Delta Sedation 90                              90.00      90.00     sedation only
 *   950009  N      09-13  C5        Alpha Mass(P) 500 + no staff Sedation 120     620.00     620.00     operation
 *   950011  N      09-14  C6        Bravo Spay(P) 700                             700.00     700.00     operation
 *   Not cases: 950008 (cancelled), 950014 (line items not synced yet: its page is missing),
 *   950018 (a RETURNED spay, quantity −1).
 *
 *   Totals: 6 cases = 4 operations + 2 sedation only; fees 4,160.00; whole visits 4,330.00;
 *   average fee 4,160 ÷ 6 = 693.333… → 693.33; average whole visit 4,330 ÷ 6 = 721.666… → 721.67;
 *   fee share 4,160 ÷ 4,330 = 96.07…% → 96.1.
 *
 * Post-op follow-up (another service visit of the same customer, any doctor, any branch, 1–14 days
 * after the case). Synced through 2026-09-27 (950017), so a case is mature when its day + 14 ≤
 * 09-27, i.e. up to 09-13:
 *   950001 C1 09-01 → C1's visit on 09-15 (exactly 14 days)                 followed up
 *   950003 C2 09-02 → C2's visit on 09-17 (15 days)                         not followed up
 *   950005 C3 09-03 → a same-day visit (not after) and a cancelled one      not followed up
 *   950009 C5 09-13 → a visit the next day at Branch SOUTH (mature: 09-27)  followed up
 *   950011 C6 09-14 → 09-28 > 09-27: not yet mature (though C6 came back on 09-16)
 *   950013 walk-in: no customer to follow up
 *   → 2 of 4 mature cases = 50.0%.
 *
 * Per doctor (a case counts for each doctor with a sold surgery line on it; their fee = their own
 * surgery lines on it; the whole visit is the whole invoice):
 *   Dr Alpha Anderson 950001, 950005, 950009: 3 operations; fees 950 + 900 + 500 = 2,350.00;
 *     whole 1,000 + 1,640 + 620 = 3,260.00; averages 783.33 / 1,086.67; share 72.1; follow-up 2 / 3 = 66.7
 *   Dr Bravo Brown 950003, 950005, 950011: 2 operations + 1 sedation only; fees 200 + 700 + 700 = 1,600.00;
 *     whole 280 + 1,640 + 700 = 2,620.00; averages 533.33 / 873.33; share 61.1; follow-up 0 / 2 (950011 not mature)
 *   Dr Delta 950013: 1 sedation only; 90.00 / 90.00; share 100.0; walk-in → no rate
 * Per branch: North 950001, 950005, 950009, 950011: 4 operations; fees 3,870.00; whole 3,960.00;
 *   averages 967.50 / 990.00; share 97.7; follow-up 2 / 3 = 66.7 (950011 not mature).
 *   South 950003, 950013: 2 sedation only; fees 290.00; whole 370.00; averages 145.00 / 185.00;
 *   share 78.4; follow-up 0 / 1 (950013 a walk-in).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const AUGUST = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
const BOTH_MONTHS = { dateFrom: "2026-08-01", dateTo: "2026-09-30" };

function figures(
  cases: number,
  operations: number,
  sedationOnly: number,
  money: [fees: string, whole: string, averageFee: string | null, averageWhole: string | null],
  share: number | null,
  followUp: [withoutCustomer: number, notYetMature: number, mature: number, followedUp: number, percent: number | null],
): SurgeryFigures {
  return {
    cases,
    operations,
    sedationOnly,
    surgeryFees: money[0],
    wholeVisitValue: money[1],
    averageSurgeryFee: money[2],
    averageWholeVisitValue: money[3],
    surgeryFeeSharePercent: share,
    followUp: { withoutCustomer: followUp[0], notYetMature: followUp[1], mature: followUp[2], followedUp: followUp[3], followUpPercent: followUp[4] },
  };
}

const NONE = figures(0, 0, 0, ["0.00", "0.00", null, null], null, [0, 0, 0, 0, null]);

describe("Analytics Service: surgery department, vaccines and dental (fed by the Sync Engine)", () => {
  const db = useTestDatabase();
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    for (const assignment of SURGERY_SCENARIO_ASSIGNMENTS) {
      expect(await assignItem(db.sql, assignment)).toEqual({ status: "saved" });
    }
    const { rows, overviews } = syntheticSales(SURGERY_SCENARIO);
    const h = createSyncHarness(db.sql, { fake: { saleList: { rows }, saleOverviews: overviews }, now: new Date("2026-10-01T02:00:00Z") });
    const connectionId = await h.connect(both, "Both branches");
    // "partial": 950014's invoice page is missing, so its line items are not synced.
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-08-01", to: "2026-09-30" } })).toMatchObject({
      status: "partial",
      counts: { invoicesSeen: 19, lineItemsFailed: 1 },
    });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows2 = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows2.map((row) => [row.fullName, row.id]));
  });

  it("classifies cases as operations or sedation only, with fee vs whole-visit value and the 14-day follow-up, in total, per branch and per doctor", async () => {
    const surgery = await getSurgeryDepartment(db.sql, SEPTEMBER);
    expect(surgery.period).toEqual(SEPTEMBER);
    expect(POST_OP_FOLLOW_UP_DAYS).toBe(14);
    expect(surgery.followUpDays).toBe(14);
    expect(surgery.syncedThrough).toBe("2026-09-27");
    expect(surgery.matureThrough).toBe("2026-09-13");
    expect(surgery.pendingLineItems).toEqual({ invoices: 1, revenue: "500.00" });

    expect(surgery.total).toEqual(figures(6, 4, 2, ["4160.00", "4330.00", "693.33", "721.67"], 96.1, [1, 1, 4, 2, 50]));
    expect(surgery.branches).toEqual([
      { branchId: branch.north, branchName: "Branch North", ...figures(4, 4, 0, ["3870.00", "3960.00", "967.50", "990.00"], 97.7, [0, 1, 3, 2, 66.7]) },
      { branchId: branch.south, branchName: "Branch South", ...figures(2, 0, 2, ["290.00", "370.00", "145.00", "185.00"], 78.4, [1, 0, 1, 0, 0]) },
    ]);
    expect(surgery.doctors).toEqual([
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        ...figures(3, 3, 0, ["2350.00", "3260.00", "783.33", "1086.67"], 72.1, [0, 0, 3, 2, 66.7]),
      },
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        ...figures(3, 2, 1, ["1600.00", "2620.00", "533.33", "873.33"], 61.1, [0, 1, 2, 0, 0]),
      },
      { staffId: staff["Dr Delta"], name: "Dr Delta", source: "alias_only", ...figures(1, 0, 1, ["90.00", "90.00", "90.00", "90.00"], 100, [1, 0, 0, 0, null]) },
    ]);
  });

  it("judges follow-ups across all branches under a branch filter, and a follow-up may fall after the period", async () => {
    const north = await getSurgeryDepartment(db.sql, { ...SEPTEMBER, branchIds: [branch.north] });
    // 950009's follow-up was at Branch South: it still counts.
    expect(north.total).toEqual(figures(4, 4, 0, ["3870.00", "3960.00", "967.50", "990.00"], 97.7, [0, 1, 3, 2, 66.7]));
    expect(north.branches.map((row) => row.branchName)).toEqual(["Branch North"]);
    // Dr Bravo at North: 950005 (mature, no follow-up) and 950011 (not yet mature).
    expect(north.doctors.map((doctor) => [doctor.name, doctor.cases, doctor.surgeryFees, doctor.wholeVisitValue, doctor.followUp])).toEqual([
      ["Dr Alpha Anderson", 3, "2350.00", "3260.00", { withoutCustomer: 0, notYetMature: 0, mature: 3, followedUp: 2, followUpPercent: 66.7 }],
      ["Dr Bravo Brown", 2, "1400.00", "2340.00", { withoutCustomer: 0, notYetMature: 1, mature: 1, followedUp: 0, followUpPercent: 0 }],
    ]);
    expect(north.pendingLineItems).toEqual({ invoices: 1, revenue: "500.00" });

    // August: 950019 (C1, 28 Aug) is followed up by 950001 on 1 Sep — outside the period, still within 14 days.
    const august = await getSurgeryDepartment(db.sql, AUGUST);
    expect(august.total).toEqual(figures(1, 1, 0, ["750.00", "750.00", "750.00", "750.00"], 100, [0, 0, 1, 1, 100]));
    // Both months: 7 cases; 950019, 950001, 950009 followed up of 5 mature.
    const both = await getSurgeryDepartment(db.sql, BOTH_MONTHS);
    expect(both.total).toEqual(figures(7, 5, 2, ["4910.00", "5080.00", "701.43", "725.71"], 96.7, [1, 1, 5, 3, 60]));
  });

  it("with a doctor filter, counts only the cases of the selected doctors and only their surgery lines as fees", async () => {
    const bravo = await getSurgeryDepartment(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] });
    // 950005 is an operation (Dr Alpha's spay and Dr Bravo's mass removal); Dr Bravo's fee on it is 700.00.
    expect(bravo.total).toEqual(figures(3, 2, 1, ["1600.00", "2620.00", "533.33", "873.33"], 61.1, [0, 1, 2, 0, 0]));
    expect(bravo.branches).toEqual([
      { branchId: branch.north, branchName: "Branch North", ...figures(2, 2, 0, ["1400.00", "2340.00", "700.00", "1170.00"], 59.8, [0, 1, 1, 0, 0]) },
      { branchId: branch.south, branchName: "Branch South", ...figures(1, 0, 1, ["200.00", "280.00", "200.00", "280.00"], 71.4, [0, 0, 1, 0, 0]) },
    ]);
    expect(bravo.doctors.map((doctor) => doctor.name)).toEqual(["Dr Bravo Brown"]);
    // No doctor, no case; no branch, nothing.
    const nobody = await getSurgeryDepartment(db.sql, { ...SEPTEMBER, doctorIds: [] });
    expect([nobody.total, nobody.doctors]).toEqual([NONE, []]);
    const noBranch = await getSurgeryDepartment(db.sql, { ...SEPTEMBER, branchIds: [] });
    expect([noBranch.total, noBranch.branches, noBranch.doctors]).toEqual([NONE, [], []]);
  });

  it("leaves a case out while its line items are not synced (and says so), and counts it again once they are", async () => {
    const pend = (delta: number) => db.sql`update invoices set header_version = header_version + ${delta} where kreloses_sale_id = '950001'`;
    await pend(1);
    try {
      const surgery = await getSurgeryDepartment(db.sql, SEPTEMBER);
      // 950001 is out, and so is its day as a service visit (a pending sale is not a visit).
      expect(surgery.total).toEqual(figures(5, 3, 2, ["3210.00", "3330.00", "642.00", "666.00"], 96.4, [1, 1, 3, 1, 33.3]));
      expect(surgery.pendingLineItems).toEqual({ invoices: 2, revenue: "1500.00" });
    } finally {
      await pend(-1);
    }
    expect((await getSurgeryDepartment(db.sql, SEPTEMBER)).total.cases).toBe(6);
  });

  it("follows an item change at once, with no re-sync", async () => {
    // "Syn Sedation" becomes an operation: 950003 and 950013 turn into operations.
    await assignItem(db.sql, { itemKey: "syn sedation", classification: { group: "surgery", surgery: true, procedure: true, consult: false, vaccine: false, dentalScaling: false } });
    try {
      const surgery = await getSurgeryDepartment(db.sql, SEPTEMBER);
      expect([surgery.total.cases, surgery.total.operations, surgery.total.sedationOnly]).toEqual([6, 6, 0]);
    } finally {
      await assignItem(db.sql, SURGERY_SCENARIO_ASSIGNMENTS.find((assignment) => assignment.itemKey === "syn sedation")!);
    }
    expect((await getSurgeryDepartment(db.sql, SEPTEMBER)).total.sedationOnly).toBe(2);
  });

  it("ranks procedures by fees: cases, fees and average fee, overall and per doctor, top N", async () => {
    const top = await getTopProcedures(db.sql, SEPTEMBER);
    expect(top.period).toEqual(SEPTEMBER);
    expect(top.limit).toBe(5);
    // The returned spay (950018), the cancelled one (950008) and the unsynced one (950014) are not cases.
    expect(top.overall).toEqual([
      { itemKey: "syn spay", name: "Syn Spay", cases: 3, fees: "2400.00", averageFee: "800.00" },
      { itemKey: "syn mass removal", name: "Syn Mass removal", cases: 2, fees: "1100.00", averageFee: "550.00" },
    ]);
    expect(top.doctors).toEqual([
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        procedures: [
          { itemKey: "syn spay", name: "Syn Spay", cases: 2, fees: "1700.00", averageFee: "850.00" },
          { itemKey: "syn mass removal", name: "Syn Mass removal", cases: 1, fees: "500.00", averageFee: "500.00" },
        ],
      },
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        procedures: [
          { itemKey: "syn spay", name: "Syn Spay", cases: 1, fees: "700.00", averageFee: "700.00" },
          { itemKey: "syn mass removal", name: "Syn Mass removal", cases: 1, fees: "600.00", averageFee: "600.00" },
        ],
      },
    ]);

    const top1 = await getTopProcedures(db.sql, BOTH_MONTHS, { limit: 1 });
    expect(top1.limit).toBe(1);
    expect(top1.overall).toEqual([{ itemKey: "syn spay", name: "Syn Spay", cases: 4, fees: "3150.00", averageFee: "787.50" }]);
    expect(top1.doctors.map((doctor) => [doctor.name, doctor.procedures.map((row) => [row.name, row.cases, row.fees])])).toEqual([
      ["Dr Alpha Anderson", [["Syn Spay", 3, "2450.00"]]],
      ["Dr Bravo Brown", [["Syn Spay", 1, "700.00"]]],
    ]);

    // With a doctor filter, "overall" is theirs.
    const bravo = await getTopProcedures(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(bravo.overall.map((row) => [row.name, row.cases, row.fees])).toEqual([
      ["Syn Spay", 1, "700.00"],
      ["Syn Mass removal", 1, "600.00"],
    ]);
    expect(bravo.doctors.map((doctor) => doctor.name)).toEqual(["Dr Bravo Brown"]);
    // The limit is clamped.
    expect((await getTopProcedures(db.sql, SEPTEMBER, { limit: 0 })).limit).toBe(1);
    expect((await getTopProcedures(db.sql, SEPTEMBER, { limit: 500 })).limit).toBe(50);
  });

  it("vaccine and dental-scaling revenue per doctor, with each as a share of the doctor's revenue", async () => {
    // September revenue: Dr Alpha 1,000 + 80 + 900 + 500 + 200 + 300 − 800 = 2,180.00; Dr Bravo 60 + 280 + 700 + 50 + 700 + 40 +
    // 550 = 2,380.00; Dr Delta 70 + 90 = 160.00; all 5,410.00 (+ Charlie 70, no staff 120, not synced yet 500).
    const revenue = await getVaccineDentalRevenue(db.sql, SEPTEMBER);
    expect(revenue.period).toEqual(SEPTEMBER);
    expect(revenue.total).toEqual({ revenue: "5410.00", vaccineRevenue: "250.00", vaccineSharePercent: 4.6, dentalScalingRevenue: "750.00", dentalScalingSharePercent: 13.9 });
    expect(revenue.doctors).toEqual([
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        revenue: "2380.00",
        vaccineRevenue: "100.00",
        vaccineSharePercent: 4.2,
        dentalScalingRevenue: "450.00",
        dentalScalingSharePercent: 18.9,
      },
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        revenue: "2180.00",
        vaccineRevenue: "120.00",
        vaccineSharePercent: 5.5,
        dentalScalingRevenue: "300.00",
        dentalScalingSharePercent: 13.8,
      },
      {
        staffId: staff["Dr Delta"],
        name: "Dr Delta",
        source: "alias_only",
        revenue: "160.00",
        vaccineRevenue: "0.00",
        vaccineSharePercent: 0,
        dentalScalingRevenue: "0.00",
        dentalScalingSharePercent: 0,
      },
    ]);
    // Branch and doctor filters apply.
    const south = await getVaccineDentalRevenue(db.sql, { ...SEPTEMBER, branchIds: [branch.south] });
    // South: 280 + 80 + 70 + 90 + 580 = 1,100.00 (950008 is cancelled); vaccines 100 + Charlie's 30 (in the total, not a doctor's).
    expect(south.total).toEqual({ revenue: "1100.00", vaccineRevenue: "130.00", vaccineSharePercent: 11.8, dentalScalingRevenue: "450.00", dentalScalingSharePercent: 40.9 });
    const alpha = await getVaccineDentalRevenue(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(alpha.total).toEqual({ revenue: "2180.00", vaccineRevenue: "120.00", vaccineSharePercent: 5.5, dentalScalingRevenue: "300.00", dentalScalingSharePercent: 13.8 });
    expect(alpha.doctors.map((doctor) => doctor.name)).toEqual(["Dr Alpha Anderson"]);
  });

  it("defines every metric once, for the dashboard and Claude", () => {
    for (const name of ["surgeryCase", "surgeryOperation", "sedationOnlyCase", "surgeryFee", "wholeVisitValue", "topProcedures", "postOpFollowUp", "vaccineRevenue", "dentalScalingRevenue"] as const) {
      expect(METRIC_DEFINITIONS[name]).toMatch(/\w/);
    }
  });
});
