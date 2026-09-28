import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { addItemRule, assignItem, clearItemAssignment, deleteItemRule } from "@/items/store";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { moneyToSen } from "@/lib/money";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import {
  CLINIC_MIX_BUCKETS,
  getDoctorRanking,
  getItemRevenue,
  getMonthlyServiceLineRevenue,
  getOverviewKpis,
  getRevenuePerWorkingDay,
  getServiceLineKpis,
  getServiceLinesByDoctor,
  getServiceMix,
  getTopItemsByDoctor,
  MIX_BUCKETS,
  MIX_COMPARISON_THRESHOLD_POINTS,
  type ServiceMix,
} from "./index";

/**
 * Seam 1 for item groups (#9): the Sync Engine reads the synthetic Sale List and invoice pages
 * (src/kreloses/__fixtures__/) into a throwaway database, the SEEDED item rules classify every item
 * name, and the Analytics Service must return these HAND-COMPUTED figures. Credited amounts per
 * line are worked out in src/analytics/doctors.test.ts; here each is put in its service group.
 *
 * September 2026 (the seeded rules; "u" = unmapped: no rule recognises the item):
 *   Dr Bravo Brown  3,352.00: Consultation 80.00 + 96.15 = consult 176.15 · Surgery - Wound stitching
 *                   surgery 700.00 · Hospitalisation 1,023.31 + Pain relief injection 400.00 = hospital
 *                   1,423.31 · Dental scaling preventive 1,052.54
 *   Dr Alpha Anderson 1,654.35: Consultation consult 144.00 · Surgery - Spay surgery 864.00 · Antibiotic
 *                   tablets medicines 192.00 · Vaccination - DHPPi 120.00 + Deworming tablets 180.50 =
 *                   preventive 300.50 · Skin scraping test u 153.85
 *   Dr Delta        480.00: Consultation consult 84.37 · X-ray diagnostics 515.63 · Prescription diet
 *                   return retail (120.00)
 *   Not doctors: Charlie Chen Nail clipping retail 45.00 · North General IV fluids hospital 48.73 ·
 *                South General Microchip u 45.00 · no staff: Prescription diet retail 175.42, Ear
 *                cleaner u 54.90
 *
 *   All doctors 5,486.35: consult 404.52 · surgery 1,564.00 · diagnostics 515.63 · hospital 1,423.31 ·
 *     rehab 0 · medicines 192.00 · preventive 1,353.04 · retail (120.00) · unmapped 153.85
 *   Whole clinic 5,855.40: the same plus hospital 48.73, retail 45.00 + 175.42, unmapped 45.00 + 54.90
 *     → hospital 1,472.04 · retail 100.42 · unmapped 253.75
 *
 * Shares = group ÷ total × 100, rounded half away from zero to 0.1; difference = doctor share −
 * all-doctors share (percentage points); above/below at ±5.0 points.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const ALL_TIME = { dateFrom: "2024-01-01", dateTo: "2026-12-31" };

/** A doctor's mix as [revenue, share, difference, comparison] per bucket (only non-zero revenue or a flagged difference). */
function compact(mix: ServiceMix) {
  return mix.doctors.map((doctor) => ({
    name: doctor.name,
    revenue: doctor.revenue,
    groups: Object.fromEntries(
      MIX_BUCKETS.map((bucket) => {
        const cell = doctor.groups[bucket];
        return [bucket, [cell.revenue, cell.sharePercent, cell.differencePoints, cell.comparison]];
      }),
    ),
  }));
}

describe("Analytics Service: service mix, top items, surgery / consult and working days (fed by the Sync Engine)", () => {
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
      counts: { lineItemsRead: 17 },
    });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  it("revenue per service group per doctor, with each doctor's share compared with all doctors together", async () => {
    const mix = await getServiceMix(db.sql, SEPTEMBER);
    expect(mix.period).toEqual(SEPTEMBER);
    expect(mix.thresholdPoints).toBe(5);
    expect(MIX_COMPARISON_THRESHOLD_POINTS).toBe(5);
    expect(compact(mix)).toEqual([
      {
        name: "Dr Bravo Brown",
        revenue: "3352.00",
        groups: {
          consult: ["176.15", 5.3, -2.1, "in_line"],
          surgery: ["700.00", 20.9, -7.6, "below"],
          diagnostics: ["0.00", 0, -9.4, "below"],
          hospital_treatment: ["1423.31", 42.5, 16.6, "above"],
          rehab_tcvm: ["0.00", 0, 0, "in_line"],
          medicines_supplements: ["0.00", 0, -3.5, "in_line"],
          preventive: ["1052.54", 31.4, 6.7, "above"],
          retail_other: ["0.00", 0, 2.2, "in_line"],
          unmapped: ["0.00", 0, -2.8, "in_line"],
        },
      },
      {
        name: "Dr Alpha Anderson",
        revenue: "1654.35",
        groups: {
          consult: ["144.00", 8.7, 1.3, "in_line"],
          surgery: ["864.00", 52.2, 23.7, "above"],
          diagnostics: ["0.00", 0, -9.4, "below"],
          hospital_treatment: ["0.00", 0, -25.9, "below"],
          rehab_tcvm: ["0.00", 0, 0, "in_line"],
          medicines_supplements: ["192.00", 11.6, 8.1, "above"],
          preventive: ["300.50", 18.2, -6.5, "below"],
          retail_other: ["0.00", 0, 2.2, "in_line"],
          unmapped: ["153.85", 9.3, 6.5, "above"],
        },
      },
      {
        name: "Dr Delta",
        revenue: "480.00",
        groups: {
          consult: ["84.37", 17.6, 10.2, "above"],
          surgery: ["0.00", 0, -28.5, "below"],
          diagnostics: ["515.63", 107.4, 98, "above"],
          hospital_treatment: ["0.00", 0, -25.9, "below"],
          rehab_tcvm: ["0.00", 0, 0, "in_line"],
          medicines_supplements: ["0.00", 0, -3.5, "in_line"],
          preventive: ["0.00", 0, -24.7, "below"],
          retail_other: ["-120.00", -25, -22.8, "below"],
          unmapped: ["0.00", 0, -2.8, "in_line"],
        },
      },
    ]);
    const shares = (groups: Record<string, { revenue: string; sharePercent: number | null }>) =>
      Object.fromEntries(Object.entries(groups).map(([bucket, cell]) => [bucket, [cell.revenue, cell.sharePercent]]));
    expect(mix.allDoctors.revenue).toBe("5486.35");
    expect(shares(mix.allDoctors.groups)).toEqual({
      consult: ["404.52", 7.4],
      surgery: ["1564.00", 28.5],
      diagnostics: ["515.63", 9.4],
      hospital_treatment: ["1423.31", 25.9],
      rehab_tcvm: ["0.00", 0],
      medicines_supplements: ["192.00", 3.5],
      preventive: ["1353.04", 24.7],
      retail_other: ["-120.00", -2.2],
      unmapped: ["153.85", 2.8],
    });
    expect(mix.clinic.revenue).toBe("5855.40");
    expect(shares(mix.clinic.groups)).toEqual({
      consult: ["404.52", 6.9],
      surgery: ["1564.00", 26.7],
      diagnostics: ["515.63", 8.8],
      hospital_treatment: ["1472.04", 25.1],
      rehab_tcvm: ["0.00", 0],
      medicines_supplements: ["192.00", 3.3],
      preventive: ["1353.04", 23.1],
      retail_other: ["100.42", 1.7],
      unmapped: ["253.75", 4.3],
      no_item: ["0.00", 0],
      pending: ["0.00", 0],
    });
  });

  it("every credited sen lands in exactly one bucket: groups add up to revenue, per doctor and for the whole clinic, over all history", async () => {
    for (const filter of [SEPTEMBER, ALL_TIME, { ...ALL_TIME, branchIds: [branch.south] }]) {
      const [mix, kpis, ranking] = await Promise.all([getServiceMix(db.sql, filter), getOverviewKpis(db.sql, filter), getDoctorRanking(db.sql, filter)]);
      const sum = (cells: { revenue: string }[]) => cells.reduce((total, cell) => total + moneyToSen(cell.revenue), 0);
      expect(sum(CLINIC_MIX_BUCKETS.map((bucket) => mix.clinic.groups[bucket]))).toBe(moneyToSen(kpis.total.revenue.value));
      expect(mix.clinic.revenue).toBe(kpis.total.revenue.value);
      for (const doctor of mix.doctors) {
        expect(sum(MIX_BUCKETS.map((bucket) => doctor.groups[bucket]))).toBe(moneyToSen(doctor.revenue));
        expect(doctor.revenue).toBe(ranking.doctors.find((row) => row.staffId === doctor.staffId)!.revenue);
      }
    }
    // All history: 2025-09 (12,345.60 + 654.40 + 100.00) + 2025-10 999.00 + Aug 2026 2,600.00 (incl. 1 Aug) + Sep 2026 5,855.40.
    expect((await getServiceMix(db.sql, ALL_TIME)).clinic.revenue).toBe("22554.40");
  });

  it("applies the branch and doctor filters to the doctors; the comparison baseline ignores the doctor filter", async () => {
    const south = await getServiceMix(db.sql, { ...SEPTEMBER, branchIds: [branch.south] });
    expect(south.doctors.map((doctor) => [doctor.name, doctor.revenue])).toEqual([
      ["Dr Bravo Brown", "1196.15"],
      ["Dr Delta", "480.00"],
      ["Dr Alpha Anderson", "153.85"],
    ]);
    expect(south.clinic.revenue).toBe("1875.00");

    const alpha = await getServiceMix(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(alpha.doctors.map((doctor) => doctor.name)).toEqual(["Dr Alpha Anderson"]);
    expect(alpha.allDoctors.revenue).toBe("5486.35");
    expect(alpha.clinic.revenue).toBe("5855.40");
    expect(alpha.doctors[0]!.groups.surgery).toMatchObject({ sharePercent: 52.2, differencePoints: 23.7, comparison: "above" });
  });

  it("each doctor's top revenue items (N configurable): positive revenue only, ties by name", async () => {
    const top = await getTopItemsByDoctor(db.sql, SEPTEMBER, { limit: 3 });
    expect(top.limit).toBe(3);
    expect(
      top.doctors.map((doctor) => [doctor.name, doctor.items.map((item) => [item.name, item.group, item.revenue, item.sharePercent, item.lines, item.invoices])]),
    ).toEqual([
      [
        "Dr Bravo Brown",
        [
          ["Dental scaling", "preventive", "1052.54", 31.4, 1, 1],
          ["Hospitalisation (per day)", "hospital_treatment", "1023.31", 30.5, 1, 1],
          ["Surgery - Wound stitching", "surgery", "700.00", 20.9, 1, 1],
        ],
      ],
      [
        "Dr Alpha Anderson",
        [
          ["Surgery - Spay", "surgery", "864.00", 52.2, 1, 1],
          ['Antibiotic tablets "Amoxi" {250mg}', "medicines_supplements", "192.00", 11.6, 1, 1],
          ["Deworming tablets", "preventive", "180.50", 10.9, 1, 1],
        ],
      ],
      [
        "Dr Delta",
        [
          ["X-ray", "diagnostics", "515.63", 107.4, 1, 1],
          ["Consultation", "consult", "84.37", 17.6, 1, 1],
        ],
      ],
    ]);
    // Consultation for Dr Bravo: two lines on two invoices (80.00 + 96.15); default N is 5.
    const five = await getTopItemsByDoctor(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(five.limit).toBe(5);
    expect(five.doctors[0]!.items.map((item) => [item.name, item.revenue, item.lines, item.invoices])).toEqual([
      ["Dental scaling", "1052.54", 1, 1],
      ["Hospitalisation (per day)", "1023.31", 1, 1],
      ["Surgery - Wound stitching", "700.00", 1, 1],
      ["Pain relief injection", "400.00", 1, 1],
      ["Consultation", "176.15", 2, 2],
    ]);
  });

  it("surgery and consult revenue per doctor (and in total for the filter)", async () => {
    const lines = await getServiceLinesByDoctor(db.sql, SEPTEMBER);
    expect(lines.total).toEqual({ revenue: "5855.40", surgeryRevenue: "1564.00", consultRevenue: "404.52", surgerySharePercent: 26.7, consultSharePercent: 6.9 });
    expect(lines.doctors.map((doctor) => [doctor.name, doctor.revenue, doctor.surgeryRevenue, doctor.surgerySharePercent, doctor.consultRevenue, doctor.consultSharePercent])).toEqual([
      ["Dr Bravo Brown", "3352.00", "700.00", 20.9, "176.15", 5.3],
      ["Dr Alpha Anderson", "1654.35", "864.00", 52.2, "144.00", 8.7],
      ["Dr Delta", "480.00", "0.00", 0, "84.37", 17.6],
    ]);
    const bravo = await getServiceLinesByDoctor(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(bravo.total).toMatchObject({ revenue: "3352.00", surgeryRevenue: "700.00", consultRevenue: "176.15" });
  });

  it("surgery / consult revenue per doctor per month (for the Trends measure switch)", async () => {
    const range = { dateFrom: "2025-09-01", dateTo: "2026-09-30" };
    expect(await getMonthlyServiceLineRevenue(db.sql, range, "surgery")).toEqual([
      { month: "2025-09", staffId: staff["Dr Alpha Anderson"], revenue: "12345.60" },
      { month: "2026-08", staffId: staff["Dr Bravo Brown"], revenue: "1000.00" },
      { month: "2026-09", staffId: staff["Dr Alpha Anderson"], revenue: "864.00" },
      { month: "2026-09", staffId: staff["Dr Bravo Brown"], revenue: "700.00" },
    ]);
    const consult = await getMonthlyServiceLineRevenue(db.sql, { ...range, branchIds: [branch.south] }, "consult");
    expect(consult).toEqual([
      { month: "2025-09", staffId: staff["Dr Bravo Brown"], revenue: "54.40" }, // 600003's consult names no staff
      { month: "2026-09", staffId: staff["Dr Bravo Brown"], revenue: "96.15" },
      { month: "2026-09", staffId: staff["Dr Delta"], revenue: "84.37" },
    ]);
  });

  it("Overview: surgery and consult revenue KPIs with the previous period and the same period last year", async () => {
    const kpis = await getServiceLineKpis(db.sql, SEPTEMBER);
    expect(kpis.previousPeriod).toEqual({ dateFrom: "2026-08-02", dateTo: "2026-08-31" });
    expect(kpis.total).toEqual({
      // Previous period: 700091 Surgery - Tooth extraction 1,000.00; last year: 600001 Surgery - FHO 12,345.60.
      surgeryRevenue: {
        value: "1564.00",
        previousPeriod: { base: "1000.00", change: "564.00", changePercent: 56.4 },
        lastYear: { base: "12345.60", change: "-10781.60", changePercent: -87.3 },
      },
      // Previous period: 700090 Consultation 100.00; last year: 600002 54.40 + 600003 (no staff) 100.00.
      consultRevenue: {
        value: "404.52",
        previousPeriod: { base: "100.00", change: "304.52", changePercent: 304.5 },
        lastYear: { base: "154.40", change: "250.12", changePercent: 162 },
      },
    });
    expect(kpis.branches.map((row) => [row.branchName, row.surgeryRevenue, row.consultRevenue])).toEqual([
      [
        "Branch North",
        { value: "864.00", previousPeriod: { base: "1000.00", change: "-136.00", changePercent: -13.6 }, lastYear: { base: "12345.60", change: "-11481.60", changePercent: -93 } },
        { value: "224.00", previousPeriod: { base: "100.00", change: "124.00", changePercent: 124 }, lastYear: { base: "0.00", change: "224.00", changePercent: null } },
      ],
      [
        "Branch South",
        { value: "700.00", previousPeriod: { base: "0.00", change: "700.00", changePercent: null }, lastYear: { base: "0.00", change: "700.00", changePercent: null } },
        { value: "180.52", previousPeriod: { base: "0.00", change: "180.52", changePercent: null }, lastYear: { base: "154.40", change: "26.12", changePercent: 16.9 } },
      ],
    ]);
    // With a doctor filter: only lines credited to them.
    const alpha = await getServiceLineKpis(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect([alpha.total.surgeryRevenue.value, alpha.total.consultRevenue.value, alpha.total.surgeryRevenue.lastYear.base]).toEqual([
      "864.00",
      "144.00",
      "12345.60",
    ]);
  });

  it("revenue per working day: the doctor's revenue ÷ clinic days with a consult or surgery line of theirs, at either branch", async () => {
    // Dr Bravo: consult 5 Sep (North), surgery 15 Sep (South), consult 18 Sep (South) → 3 days; 20 Sep only
    // hospital + dental lines → not a working day. Dr Alpha: 1 Sep (consult + spay) → 1 day (5 and 18 Sep:
    // vaccine, deworming, skin scraping only). Dr Delta: 2 Sep consult → 1 day (10 Sep: a retail return).
    const days = await getRevenuePerWorkingDay(db.sql, SEPTEMBER);
    const doctor = (name: string) => days[staff[name]!];
    expect(doctor("Dr Bravo Brown")).toEqual({ staffId: staff["Dr Bravo Brown"], revenue: "3352.00", workingDays: 3, revenuePerWorkingDay: "1117.33" });
    expect(doctor("Dr Alpha Anderson")).toMatchObject({ revenue: "1654.35", workingDays: 1, revenuePerWorkingDay: "1654.35" });
    expect(doctor("Dr Delta")).toMatchObject({ revenue: "480.00", workingDays: 1, revenuePerWorkingDay: "480.00" });
    // Staff with revenue but no consult / surgery line: no working day, no figure.
    expect(days[staff["Charlie Chen"]!]).toMatchObject({ revenue: "45.00", workingDays: 0, revenuePerWorkingDay: null });

    // A branch filter narrows the revenue, never the working days ("at either branch").
    const north = await getRevenuePerWorkingDay(db.sql, { ...SEPTEMBER, branchIds: [branch.north] });
    expect(north[staff["Dr Bravo Brown"]!]).toMatchObject({ revenue: "2155.85", workingDays: 3, revenuePerWorkingDay: "718.62" });

    // Split by branch: each branch's revenue ÷ the same working days.
    const split = await getRevenuePerWorkingDay(db.sql, SEPTEMBER, { splitByBranch: true });
    expect(split[staff["Dr Bravo Brown"]!]!.branches).toEqual([
      { branchId: branch.north, revenue: "2155.85", revenuePerWorkingDay: "718.62" },
      { branchId: branch.south, revenue: "1196.15", revenuePerWorkingDay: "398.72" },
    ]);
  });

  it("revenue per item for Settings (dates and branches; the doctor filter does not apply)", async () => {
    const revenue = await getItemRevenue(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Delta"]!] });
    expect(revenue).toMatchObject({
      consultation: "404.52",
      "skin scraping test": "153.85",
      "ear cleaner 100ml": "54.90",
      microchip: "45.00",
      "prescription diet 2kg": "55.42", // 175.42 − 120.00
    });
    expect(await getItemRevenue(db.sql, { ...SEPTEMBER, branchIds: [branch.north] })).not.toHaveProperty("microchip");
  });

  it("reassigning an item or adding a rule changes every figure, past periods included, without re-syncing", async () => {
    const requests = h.fake.requests.length;
    const alphaMix = async (filter = SEPTEMBER) =>
      (await getServiceMix(db.sql, filter)).doctors.find((doctor) => doctor.name === "Dr Alpha Anderson")!.groups;

    // The owner assigns the unmapped "Skin scraping test" to Diagnostics.
    expect(await assignItem(db.sql, { itemKey: "skin scraping test", classification: { group: "diagnostics", surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false } })).toEqual({
      status: "saved",
    });
    let alpha = await alphaMix();
    expect([alpha.diagnostics.revenue, alpha.unmapped.revenue]).toEqual(["153.85", "0.00"]);

    // Dental scaling becomes Hospital & treatment: September 2026 (Dr Bravo) AND October 2025 (600004, Dr Alpha) follow.
    const dental = await addItemRule(db.sql, {
      matchType: "exact",
      pattern: "Dental scaling",
      priority: 0,
      classification: { group: "hospital_treatment", surgery: false, consult: false, vaccine: false, dentalScaling: true, procedure: false },
    });
    expect(dental).toMatchObject({ status: "saved" });
    const october2025 = { dateFrom: "2025-10-01", dateTo: "2025-10-31" };
    alpha = await alphaMix(october2025);
    expect([alpha.hospital_treatment.revenue, alpha.preventive.revenue]).toEqual(["999.00", "0.00"]);
    const bravo = (await getServiceMix(db.sql, SEPTEMBER)).doctors.find((doctor) => doctor.name === "Dr Bravo Brown")!;
    expect([bravo.groups.hospital_treatment.revenue, bravo.groups.preventive.revenue]).toEqual(["2475.85", "0.00"]);

    // Flags follow too: X-ray made a surgery line → Dr Delta's surgery revenue and working days change at once.
    await assignItem(db.sql, { itemKey: "x-ray", classification: { group: "surgery", surgery: true, consult: false, vaccine: false, dentalScaling: false, procedure: true } });
    const lines = await getServiceLinesByDoctor(db.sql, SEPTEMBER);
    expect(lines.doctors.find((doctor) => doctor.name === "Dr Delta")).toMatchObject({ surgeryRevenue: "515.63" });
    expect(h.fake.requests.length).toBe(requests); // nothing was read from Kreloses

    // Put everything back.
    await clearItemAssignment(db.sql, "x-ray");
    await clearItemAssignment(db.sql, "skin scraping test");
    await deleteItemRule(db.sql, (dental as { ruleId: string }).ruleId);
    expect(compact(await getServiceMix(db.sql, SEPTEMBER))[1]!.groups.unmapped).toEqual(["153.85", 9.3, 6.5, "above"]);
  });

  it("a sale whose line items are not synced yet counts in the clinic's 'not synced yet' bucket; group totals still add up", async () => {
    const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700104)!;
    const before = { status: row.PaymentStatusName, payments: row.TotalPayments };
    row.PaymentStatusName = "Paid";
    row.TotalPayments = "2,438.00";
    h.clock.advance(3_600_000);
    let pageDown = true;
    h.fake.intercept((request) => (pageDown && request.url.pathname === "/Sale/Overview/700104" ? new Response("down", { status: 503 }) : undefined));
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, maxRetries: 0 });

    const mix = await getServiceMix(db.sql, SEPTEMBER);
    // 700104 (2,300.00) leaves hospital (1,023.31 Dr Bravo + 48.73 North General), preventive (1,052.54
    // dental) and retail (175.42 no staff) for "line items not synced yet".
    expect(mix.clinic.revenue).toBe("5855.40");
    expect(mix.clinic.groups.pending).toEqual({ revenue: "2300.00", sharePercent: 39.3 });
    expect([mix.clinic.groups.hospital_treatment.revenue, mix.clinic.groups.preventive.revenue, mix.clinic.groups.retail_other.revenue]).toEqual([
      "400.00",
      "300.50",
      "-75.00",
    ]);
    expect(mix.doctors.find((doctor) => doctor.name === "Dr Bravo Brown")!.revenue).toBe("1276.15");
    // Doctors never carry pending revenue (nobody is credited yet); surgery / consult totals leave it out.
    expect((await getServiceLinesByDoctor(db.sql, SEPTEMBER)).total).toMatchObject({ revenue: "5855.40", surgeryRevenue: "1564.00" });

    pageDown = false;
    row.PaymentStatusName = before.status;
    row.TotalPayments = before.payments;
    h.clock.advance(3_600_000);
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    expect((await getServiceMix(db.sql, SEPTEMBER)).clinic.groups.pending.revenue).toBe("0.00");
  });

  it("classifies item names that are new in a later sync, and catches up names stored without a classification", async () => {
    // 700201's X-ray is now called "Sedation" in Kreloses (and the sale changed, so its page is read again).
    const model = h.fake.saleOverviews["700201"] as { Items: { Name: string }[] };
    model.Items[1]!.Name = "Sedation";
    const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700201)!;
    row.PaymentStatusName = "Paid in full";
    h.clock.advance(3_600_000);
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    const [sedation] = await db.sql`select mix_group, is_surgery, is_procedure, source from item_classifications where item_name = 'Sedation'`;
    expect(sedation).toEqual({ mixGroup: "surgery", isSurgery: true, isProcedure: false, source: "rule" });
    const delta = (await getServiceLinesByDoctor(db.sql, SEPTEMBER)).doctors.find((doctor) => doctor.name === "Dr Delta")!;
    expect([delta.surgeryRevenue, delta.consultRevenue]).toEqual(["515.63", "84.37"]);

    // Names stored with no classification count as unmapped (revenue never lost) until a sync catches up.
    await db.sql`delete from item_classifications`;
    const bare = await getServiceMix(db.sql, SEPTEMBER);
    expect(bare.clinic.groups.unmapped.revenue).toBe("5855.40");
    h.clock.advance(3_600_000);
    await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    const caughtUp = await getServiceMix(db.sql, SEPTEMBER);
    expect(caughtUp.clinic.groups.unmapped.revenue).toBe("253.75");
    expect(caughtUp.clinic.groups.surgery.revenue).toBe("2079.63"); // 1,564.00 + the sedation 515.63

    model.Items[1]!.Name = "X-ray";
  });
});
