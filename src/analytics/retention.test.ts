import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness } from "@/sync/test-support";

import { getRetention, type DoctorRetention, type NewVsReturning, type NinetyDayReturns, type Retention, type YearCohort } from "./index";
import { retentionFakeData } from "./retention-fixture";

/**
 * Seam 1: the Sync Engine reads the hand-built retention sales (./retention-fixture.ts) from the
 * fake Kreloses into a throwaway database; the Analytics Service must return exactly these
 * HAND-COMPUTED figures.
 *
 * Service visits (customer, clinic day) → doctors the visit is attributed to; N/S = branch.
 *   C1001  2024-01-08 A N · 2025-02-10 A N · 2026-01-12 A N (two service lines, one visit) · 2026-09-30 A N
 *   C1002  2024-05-06 B N · 2025-06-02 A N                       (returns only to another doctor)
 *   C1003  2024-07-01 A+B N (two invoices, two doctors: one visit, counts for both) · 2025-07-07 B S · 2026-03-23 B S
 *   C1004  2024-09-02 A N (Dr Bravo only sold a product: not his visit) — 2025-03-03 product + discount line only: NO visit
 *   C1005  2024-10-07 B S — 2025-01-06 cancelled: NO visit
 *   C1006  2026-01-05 A S · 2026-04-05 B S                       (back after exactly 90 days, to another doctor)
 *   C1007  2026-02-02 B S · 2026-05-04 B S                       (back after 91 days)
 *   C1008  2026-03-02 D N (two invoices the same day: one visit, never a return)
 *   C1009  2025-04-07 A N · 2026-02-09 — N ("Charlie", other staff: a visit, no doctor)
 *   C1010  2025-05-05 B N · 2026-01-19 B S                       (first visit at North, later only at South)
 *   C1011  2025-08-04 A N — 2026-03-09 returned service (quantity (1)): NO visit; 2026-03-16 page missing (line
 *          items not synced yet): NO visit
 *   C1012  2026-08-03 A S · 2026-08-10 — S (no staff on the line)
 *   C1013  2026-07-02 B N · 2026-09-30 D N                       (exactly 90 days, ending on the last synced day)
 *   C1014  2025-10-06 A N · 2025-11-03 B S                       (back 28 days later, at the other branch)
 *   Walk-ins 2025-12-30 A N and 2026-01-26 A N (a service, no customer): NO visit; 2025-12-31 S (a product): no visit.
 * Synced history: 2024-01-08 → 2026-09-30 (North the same; South 2024-10-07 → 2026-08-10).
 *
 * Branch filter: only visits at the selected branches put a customer in a period or cohort, but new vs
 * returning, "came back" and 90-day returns are judged across BOTH branches (orchestrator decision on #13).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const Q1_2026 = { dateFrom: "2026-01-01", dateTo: "2026-03-31" };
const YEAR_2026 = { dateFrom: "2026-01-01", dateTo: "2026-09-30" };

const nvr = (customers: number, newCustomers: number, newPercent: number | null, returningPercent: number | null): NewVsReturning => ({
  customers,
  newCustomers,
  returningCustomers: customers - newCustomers,
  newPercent,
  returningPercent,
});
const returns = (visits: number, notYetMature: number, returned: number, returnPercent: number | null): NinetyDayReturns => ({
  visits,
  notYetMature,
  mature: visits - notYetMature,
  returned,
  returnPercent,
});
type CohortStatus = "accruing" | "complete" | "accruing, partial year" | "complete, partial year";
const cohort = (year: number, status: CohortStatus, customers: number, any: [number, number], same: [number, number] | null): YearCohort => ({
  year,
  accruing: status.startsWith("accruing"),
  partialYear: status.endsWith("partial year"),
  customers,
  retainedAnyDoctor: any[0],
  retainedAnyDoctorPercent: any[1],
  retainedSameDoctor: same ? same[0] : null,
  retainedSameDoctorPercent: same ? same[1] : null,
});
const NO_VISITS_NVR = nvr(0, 0, null, null);
const NO_VISITS_RETURNS = returns(0, 0, 0, null);

describe("Analytics Service: retention (fed by the Sync Engine)", () => {
  const db = useTestDatabase();
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  const doctor = (report: Retention, name: string): DoctorRetention | undefined => report.doctors.find((row) => row.name === name);
  const harness = (now: string) => {
    const { rows, overviews } = retentionFakeData();
    return createSyncHarness(db.sql, { fake: { saleList: { rows }, saleOverviews: overviews }, now: new Date(now) });
  };

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    const h = harness("2026-10-01T02:00:00Z");
    const connectionId = await h.connect(both, "Both branches");
    // 800024's invoice page is missing: the run reads everything else and ends "partial".
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2024-01-01", to: "2026-09-30" } })).toMatchObject({
      status: "partial",
      counts: { invoicesSeen: 36, inserted: 36, lineItemsRead: 34, lineItemsFailed: 1 },
    });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  it("returns the synced history's bounds and the sales whose line items are not synced yet", async () => {
    const report = await getRetention(db.sql, Q1_2026);
    expect(report.period).toEqual(Q1_2026);
    expect(report.historyFrom).toBe("2024-01-08");
    expect(report.syncedThrough).toBe("2026-09-30");
    expect(report.matureThrough).toBe("2026-07-02"); // 90 days before
    expect(report.limitedHistory).toBe(false);
    expect(report.pendingInvoices).toBe(1); // 800024

    const south = await getRetention(db.sql, { ...Q1_2026, branchIds: [branch.south] });
    expect([south.historyFrom, south.syncedThrough, south.matureThrough, south.pendingInvoices]).toEqual(["2024-10-07", "2026-08-10", "2026-05-12", 0]);
  });

  it("counts new vs returning customers per doctor: new = first service visit (any doctor) in the period", async () => {
    const report = await getRetention(db.sql, Q1_2026);
    // Seen in Q1 2026: C1001 C1003 C1009 C1010 returning; C1006 C1007 C1008 new (first visit in Q1).
    expect(report.clinic.newVsReturning).toEqual(nvr(7, 3, 42.9, 57.1));
    expect(report.doctors.map((row) => [row.name, row.source])).toEqual([
      ["Dr Alpha Anderson", "kreloses"],
      ["Dr Bravo Brown", "kreloses"],
      ["Dr Delta", "alias_only"],
    ]);
    expect(report.doctors.map((row) => row.staffId)).toEqual([staff["Dr Alpha Anderson"], staff["Dr Bravo Brown"], staff["Dr Delta"]]);
    // Dr Alpha: C1001 returning, C1006 new. Dr Bravo: C1010 C1003 returning, C1007 new. Dr Delta: C1008 new.
    expect(doctor(report, "Dr Alpha Anderson")!.newVsReturning).toEqual(nvr(2, 1, 50, 50));
    expect(doctor(report, "Dr Bravo Brown")!.newVsReturning).toEqual(nvr(3, 1, 33.3, 66.7));
    expect(doctor(report, "Dr Delta")!.newVsReturning).toEqual(nvr(1, 1, 100, 0));

    // C1006's first visit is on the period's first day: new. From the next day on, their 5 Apr visit is returning.
    expect((await getRetention(db.sql, { dateFrom: "2026-01-05", dateTo: "2026-01-05" })).clinic.newVsReturning).toEqual(nvr(1, 1, 100, 0));
    expect((await getRetention(db.sql, { dateFrom: "2026-01-06", dateTo: "2026-04-05" })).clinic.newVsReturning).toEqual(nvr(7, 2, 28.6, 71.4));
  });

  it("flags a period starting within 90 days of the synced history's start (new may include earlier customers)", async () => {
    const early = await getRetention(db.sql, { dateFrom: "2024-01-01", dateTo: "2024-03-31" });
    expect(early.limitedHistory).toBe(true);
    expect(early.clinic.newVsReturning).toEqual(nvr(1, 1, 100, 0));
    expect((await getRetention(db.sql, { dateFrom: "2024-04-06", dateTo: "2024-04-30" })).limitedHistory).toBe(true);
    expect((await getRetention(db.sql, { dateFrom: "2024-04-07", dateTo: "2024-04-30" })).limitedHistory).toBe(false);
  });

  it("builds yearly cohorts: retained with any doctor and with the same doctor; the latest one still accruing", async () => {
    const report = await getRetention(db.sql, Q1_2026); // cohorts ignore the date range
    // 2026's cohort is not listed: 2027 has not started in the synced data (through 2026-09-30).
    // 2024 (complete; a partial year: the synced sales start on 8 Jan 2024): C1001 C1002 C1003 back in 2025;
    // C1004 only bought a product, C1005's visit was cancelled.
    // 2025 (still accruing: 2026 is not over): C1001 C1003 C1009 (non-doctor staff counts) C1010 back; C1002, C1011 (a
    // returned service and an unsynced sale) and C1014 not. The 2025 walk-in is nobody.
    expect(report.clinic.cohorts).toEqual([cohort(2025, "accruing", 7, [4, 57.1], null), cohort(2024, "complete, partial year", 5, [3, 60], null)]);
    // Dr Alpha 2024: C1001 C1003 C1004 — any: C1001 C1003; same: C1001 (C1003 went back to Dr Bravo).
    // Dr Alpha 2025: C1001 C1002 C1009 C1011 C1014 — any: C1001 C1009; same: C1001.
    expect(doctor(report, "Dr Alpha Anderson")!.cohorts).toEqual([
      cohort(2025, "accruing", 5, [2, 40], [1, 20]),
      cohort(2024, "complete, partial year", 3, [2, 66.7], [1, 33.3]),
    ]);
    // Dr Bravo 2024: C1002 C1003 C1005 (not C1004: a product only) — any: C1002 C1003; same: C1003 (C1002 went to Dr Alpha).
    // Dr Bravo 2025: C1003 C1010 C1014 — C1003 and C1010 back to him in 2026.
    expect(doctor(report, "Dr Bravo Brown")!.cohorts).toEqual([
      cohort(2025, "accruing", 3, [2, 66.7], [2, 66.7]),
      cohort(2024, "complete, partial year", 3, [2, 66.7], [1, 33.3]),
    ]);
    expect(doctor(report, "Dr Delta")!.cohorts).toEqual([]);
  });

  it("works out the 90-day return rate per visit: 1–90 days later, any doctor; recent visits excluded until mature", async () => {
    const report = await getRetention(db.sql, YEAR_2026);
    // Mature = visit day + 90 ≤ 2026-09-30, i.e. on or before 2026-07-02. Returned within 90 days: C1006 5 Jan
    // (back on day 90) and C1013 2 Jul (back on day 90, the last synced day). Not: C1007 2 Feb (day 91), C1008's
    // same-day second invoice, … Not yet mature: C1012 3 Aug + 10 Aug, C1001 30 Sep, C1013 30 Sep.
    expect(report.clinic.returns90).toEqual(returns(14, 4, 2, 20));
    // Dr Alpha: C1006 5 Jan ✓, C1001 12 Jan ✗; C1012 3 Aug and C1001 30 Sep not yet mature.
    expect(doctor(report, "Dr Alpha Anderson")!.returns90).toEqual(returns(4, 2, 1, 50));
    // Dr Bravo: C1010 19 Jan, C1007 2 Feb, C1003 23 Mar, C1006 5 Apr, C1007 4 May ✗; C1013 2 Jul ✓.
    expect(doctor(report, "Dr Bravo Brown")!.returns90).toEqual(returns(6, 0, 1, 16.7));
    // Dr Delta: C1008 2 Mar ✗ (same day is the same visit); C1013 30 Sep not yet mature.
    expect(doctor(report, "Dr Delta")!.returns90).toEqual(returns(2, 1, 0, 0));

    // Q1 only: nothing is too recent.
    const q1 = await getRetention(db.sql, Q1_2026);
    expect(q1.clinic.returns90).toEqual(returns(7, 0, 1, 14.3)); // C1006 5 Jan
    expect(doctor(q1, "Dr Delta")!.returns90).toEqual(returns(1, 0, 0, 0));
  });

  it("with a branch filter, only visits at the selected branches count people in; new, returned and came back are judged at any branch", async () => {
    // North, October 2025: C1014's visit, followed 28 days later by one at South — a 90-day return.
    const northOctober = await getRetention(db.sql, { dateFrom: "2025-10-01", dateTo: "2025-10-31", branchIds: [branch.north] });
    expect(northOctober.clinic.returns90).toEqual(returns(1, 0, 1, 100));
    expect(doctor(northOctober, "Dr Alpha Anderson")!.returns90).toEqual(returns(1, 0, 1, 100));

    const north = await getRetention(db.sql, { ...Q1_2026, branchIds: [branch.north] });
    // North cohorts: members are customers with a North visit in the year; coming back counts at either branch
    // (C1003's 2025 visit and C1010's 2026 visit were at South). 2024 is a partial year (sales from 8 Jan).
    //   2024: C1001 C1002 C1003 C1004 — back: C1001 C1002 C1003.   2025: C1001 C1002 C1009 C1010 C1011 C1014 — back: C1001 C1009 C1010.
    expect(north.clinic.cohorts).toEqual([cohort(2025, "accruing", 6, [3, 50], null), cohort(2024, "complete, partial year", 4, [3, 75], null)]);
    expect(doctor(north, "Dr Alpha Anderson")!.cohorts).toEqual([
      cohort(2025, "accruing", 5, [2, 40], [1, 20]),
      cohort(2024, "complete, partial year", 3, [2, 66.7], [1, 33.3]),
    ]);
    // Dr Bravo at North: 2024 C1002 C1003 (C1003 back to him at South in 2025); 2025 C1010 (back to him at South).
    expect(doctor(north, "Dr Bravo Brown")!.cohorts).toEqual([
      cohort(2025, "accruing", 1, [1, 100], [1, 100]),
      cohort(2024, "complete, partial year", 2, [2, 100], [1, 50]),
    ]);
    // No North visit for Dr Bravo in Q1 2026, but he has North cohorts: listed with empty period figures.
    expect(doctor(north, "Dr Bravo Brown")!.newVsReturning).toEqual(NO_VISITS_NVR);
    expect(doctor(north, "Dr Bravo Brown")!.returns90).toEqual(NO_VISITS_RETURNS);

    // South, Q1 2026: C1006 and C1007 are new; C1003 and C1010 are returning — C1010 had only been to North before.
    const south = await getRetention(db.sql, { ...Q1_2026, branchIds: [branch.south] });
    expect(south.clinic.newVsReturning).toEqual(nvr(4, 2, 50, 50));
    expect(south.doctors.map((row) => row.name)).toEqual(["Dr Alpha Anderson", "Dr Bravo Brown"]);
    expect(doctor(south, "Dr Bravo Brown")!.newVsReturning).toEqual(nvr(3, 1, 33.3, 66.7));
    // South is synced through 2026-08-10 (its latest sale) and from 2024-10-07 (so 2024 is a partial year):
    // 2025 (C1003 C1014; C1003 back) is still accruing, 2024 (C1005, whose return was cancelled) is complete.
    expect(south.clinic.cohorts).toEqual([cohort(2025, "accruing", 2, [1, 50], null), cohort(2024, "complete, partial year", 1, [0, 0], null)]);
  });

  it("with a doctor filter, lists only those doctors; the whole-clinic figures do not change", async () => {
    const everyone = await getRetention(db.sql, YEAR_2026);
    const bravo = await getRetention(db.sql, { ...YEAR_2026, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(bravo.doctors.map((row) => row.name)).toEqual(["Dr Bravo Brown"]);
    expect(bravo.doctors[0]).toEqual(doctor(everyone, "Dr Bravo Brown"));
    expect(bravo.clinic).toEqual(everyone.clinic);

    // Non-doctor staff are never listed as doctors; ids that match nobody list nobody.
    expect((await getRetention(db.sql, { ...YEAR_2026, doctorIds: [staff["Charlie Chen"]!] })).doctors).toEqual([]);
    expect((await getRetention(db.sql, { ...YEAR_2026, doctorIds: ["999999", "not-an-id"] })).doctors).toEqual([]);
  });

  it("keeps a cohort accruing until the synced sales reach 31 December of the next year", async () => {
    await clearSyncTables(db.sql);
    const h = harness("2026-01-02T02:00:00Z");
    const connectionId = await h.connect(both, "Both branches");
    // Synced through 30 Dec 2025 (the walk-in): 2024's cohort is still accruing.
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2024-01-01", to: "2025-12-30" } })).toMatchObject({ status: "succeeded" });
    const before = await getRetention(db.sql, Q1_2026);
    expect(before.syncedThrough).toBe("2025-12-30");
    expect(before.clinic.cohorts).toEqual([cohort(2024, "accruing, partial year", 5, [3, 60], null)]);

    // 31 Dec 2025 synced too: complete.
    h.clock.advance(3_600_000);
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2025-12-31", to: "2025-12-31" } })).toMatchObject({ status: "succeeded" });
    const after = await getRetention(db.sql, Q1_2026);
    expect(after.syncedThrough).toBe("2025-12-31");
    expect(after.clinic.cohorts).toEqual([cohort(2024, "complete, partial year", 5, [3, 60], null)]);
  });

  it("returns empty figures when nothing is synced", async () => {
    await clearSyncTables(db.sql);
    expect(await getRetention(db.sql, Q1_2026)).toEqual({
      period: Q1_2026,
      historyFrom: null,
      syncedThrough: null,
      matureThrough: null,
      limitedHistory: false,
      pendingInvoices: 0,
      clinic: { newVsReturning: NO_VISITS_NVR, returns90: NO_VISITS_RETURNS, cohorts: [] },
      doctors: [],
    });
  });
});
