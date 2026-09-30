import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { assignItem } from "@/items/store";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { syntheticSales } from "@/kreloses/testing/synthetic-sales";
import { runSync } from "@/sync/engine";
import { createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getConsultAttachRates, getDoctorRanking, getItemsPerInvoiceTrend, METRIC_DEFINITIONS, UPSELL_METRICS, type AttachFigures, type AttachRateSet } from "./index";
import { UPSELL_EDGE_CASES, UPSELL_SCENARIO } from "./testing/upsell-scenario";

/**
 * Seam 1 for the Upsell page (#14): the Sync Engine reads the hand-built sales of
 * `testing/upsell-scenario.ts` (August–September 2026; the seeded item rules classify the items)
 * into a throwaway database, and the Analytics Service must return these HAND-COMPUTED figures.
 *
 * Consult invoices (an active sale with line items synced and a consult line credited to the doctor):
 *   Dr Alpha Anderson (7): 820001 820002 820003 820005 | 820011 820014 820016
 *     (820015 has no invoice page yet → not synced → left out; 820017 has only Alpha's vaccination and
 *     820020 no consult → not Alpha's consult invoices)
 *   Dr Bravo Brown (5):    820004 820005 | 820012 820017 820018   (820013 is cancelled)
 *   Charlie Chen's consult (820019) is other staff's: no row, not in "all doctors".
 *
 * Add-ons = lines that are not consult lines and charged more than 0:
 *   820001  X-ray (Bravo)            diagnostics + second service — for Alpha only on the WHOLE invoice
 *   820002  Antibiotic tablets 0.00  free → nothing
 *   820003  TCVM examination         a consult line → nothing
 *   820004  Blood test (Bravo)       diagnostics + second service, Bravo's own
 *   820005  X-ray (Bravo)            diagnostics + second service: Alpha whole only; Bravo whole and own
 *   820011  Surgery - Spay (Alpha)   second service, own
 *   820012  5% DISCOUNT line         not a line item at all → nothing
 *   820014  Antibiotic 45 (Alpha) + Shampoo (Charlie)   product, own (the antibiotic)
 *   820016  Prescription diet (no staff)                product, whole only
 *   820017  Vaccination - DHPPi (Alpha)                 second service for Bravo, whole only
 *   820018  Prescription diet returned (−60.00)         charged below 0 → nothing
 *
 *                      whole invoice: diag / products / 2nd service / any    own lines: diag / products / 2nd / any
 *   Alpha (7)          2 28.6 / 2 28.6 / 3 42.9 / 5 71.4                     0 0.0 / 1 14.3 / 1 14.3 / 2 28.6
 *   Bravo (5)          2 40.0 / 0 0.0  / 3 60.0 / 3 60.0                     2 40.0 / 0 0.0 / 2 40.0 / 2 40.0
 *   All doctors (12)   4 33.3 / 2 16.7 / 6 50.0 / 8 66.7                     2 16.7 / 1 8.3 / 3 25.0 / 4 33.3
 *   (820005 counts for both doctors: 7 + 5 = 12.)
 *
 * Items per invoice (#5: the doctor's credited lines ÷ invoices with a line credited to them):
 *   Alpha  Aug 820001 1 · 820002 2 · 820003 2 · 820005 1 = 6 / 4 = 1.50
 *          Sep 820011 2 · 820014 2 · 820016 1 · 820017 1 · 820020 2 = 8 / 5 = 1.60   whole 14 / 9 = 1.56
 *   Bravo  Aug 820001 1 · 820004 2 · 820005 2 = 5 / 3 = 1.67
 *          Sep 820012 1 · 820017 1 · 820018 2 = 4 / 3 = 1.33                        whole 9 / 6 = 1.50
 *
 * Filters: September only — Alpha 820011 820014 820016, Bravo 820012 820017 820018. Branch North —
 * Alpha 6 (all but 820003), Bravo 2 (820005, 820017). 10 Aug – 15 Sep — Alpha 5/3 and 5/3 (820002,
 * 820003, 820005 | 820011, 820014, 820016), Bravo 4/2 (820004, 820005) and 1/1 (820012). Branch South
 * items — Alpha Aug 820003 2/1; Bravo Aug 820004 2/1, Sep 820012 + 820018 3/2.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const AUG_SEP = { dateFrom: "2026-08-01", dateTo: "2026-09-30" };
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
/** The clinic's "today" for the monthly series: 28 Sep 2026 (September is the current month). */
const NOW = new Date("2026-09-28T01:00:00Z");

type Compact = [invoices: number, percent: number | null];
/** A rate set as `{ consults, whole: [diag, products, 2nd, any], own: […] }`, each `[invoices, percent]`. */
function compact(set: AttachRateSet) {
  const figures = (value: AttachFigures): Compact[] => [
    [value.diagnostics.invoices, value.diagnostics.percent],
    [value.products.invoices, value.products.percent],
    [value.secondService.invoices, value.secondService.percent],
    [value.anyAddOn.invoices, value.anyAddOn.percent],
  ];
  return { consults: set.consultInvoices, whole: figures(set.wholeInvoice), own: figures(set.ownLines) };
}

async function syncScenario(h: SyncHarness): Promise<string> {
  const connectionId = await h.connect(both, "Both branches");
  // 820015 has no invoice page: its line items stay "not synced yet" and the run ends partial.
  expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-08-01", to: "2026-09-30" } })).toMatchObject({
    status: "partial",
    counts: { invoicesSeen: 15, lineItemsRead: 13, lineItemsFailed: 1 },
  });
  return connectionId;
}

describe("Analytics Service: consult attach rates and items per invoice over time (hand-built sales)", () => {
  const db = useTestDatabase();
  let staff: Record<string, string>;
  let branch: { north: string; south: string };

  beforeAll(async () => {
    const sales = syntheticSales(UPSELL_SCENARIO);
    await syncScenario(createSyncHarness(db.sql, { fake: { saleList: { rows: sales.rows }, saleOverviews: sales.overviews } }));
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
  });

  it("attach rates per doctor over their consult invoices: the whole invoice (the visit's basket) and the doctor's own lines", async () => {
    const rates = await getConsultAttachRates(db.sql, AUG_SEP);
    expect(rates.period).toEqual(AUG_SEP);
    expect(rates.doctors.map((doctor) => ({ staffId: doctor.staffId, name: doctor.name, source: doctor.source, active: doctor.active, ...compact(doctor) }))).toEqual([
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        active: true,
        consults: 7,
        whole: [[2, 28.6], [2, 28.6], [3, 42.9], [5, 71.4]],
        own: [[0, 0], [1, 14.3], [1, 14.3], [2, 28.6]],
      },
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        active: true,
        consults: 5,
        whole: [[2, 40], [0, 0], [3, 60], [3, 60]],
        own: [[2, 40], [0, 0], [2, 40], [2, 40]],
      },
    ]);
  });

  it("all doctors together pool every doctor's consult invoices (one shared by two consulting doctors counts for each); other staff's consults are not included", async () => {
    const rates = await getConsultAttachRates(db.sql, AUG_SEP);
    expect(compact(rates.allDoctors)).toEqual({
      consults: 12,
      whole: [[4, 33.3], [2, 16.7], [6, 50], [8, 66.7]],
      own: [[2, 16.7], [1, 8.3], [3, 25], [4, 33.3]],
    });
    expect(rates.doctors.map((doctor) => doctor.name)).not.toContain("Charlie Chen");
  });

  it("leaves out sales whose line items are not synced yet (they cannot be classified) and says how many there are", async () => {
    const rates = await getConsultAttachRates(db.sql, AUG_SEP);
    expect(rates.pendingLineItems).toEqual({ invoices: 1, revenue: "230.00" });
    const september = await getConsultAttachRates(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    // The doctor filter never hides them: they are credited to nobody yet.
    expect(september.pendingLineItems).toEqual({ invoices: 1, revenue: "230.00" });
    expect(september.doctors.map(compact)).toEqual([{ consults: 3, whole: [[0, 0], [2, 66.7], [1, 33.3], [3, 100]], own: [[0, 0], [1, 33.3], [1, 33.3], [2, 66.7]] }]);
  });

  it("follows the filter: dates, branches (the invoice's branch) and doctors (who is listed; all doctors ignores it)", async () => {
    const september = await getConsultAttachRates(db.sql, SEPTEMBER);
    expect(september.doctors.map((doctor) => [doctor.name, compact(doctor)])).toEqual([
      ["Dr Alpha Anderson", { consults: 3, whole: [[0, 0], [2, 66.7], [1, 33.3], [3, 100]], own: [[0, 0], [1, 33.3], [1, 33.3], [2, 66.7]] }],
      ["Dr Bravo Brown", { consults: 3, whole: [[0, 0], [0, 0], [1, 33.3], [1, 33.3]], own: [[0, 0], [0, 0], [0, 0], [0, 0]] }],
    ]);

    const north = await getConsultAttachRates(db.sql, { ...AUG_SEP, branchIds: [branch.north] });
    expect(north.doctors.map((doctor) => [doctor.name, compact(doctor)])).toEqual([
      ["Dr Alpha Anderson", { consults: 6, whole: [[2, 33.3], [2, 33.3], [3, 50], [5, 83.3]], own: [[0, 0], [1, 16.7], [1, 16.7], [2, 33.3]] }],
      ["Dr Bravo Brown", { consults: 2, whole: [[1, 50], [0, 0], [2, 100], [2, 100]], own: [[1, 50], [0, 0], [1, 50], [1, 50]] }],
    ]);
    expect(compact(north.allDoctors)).toEqual({ consults: 8, whole: [[3, 37.5], [2, 25], [5, 62.5], [7, 87.5]], own: [[1, 12.5], [1, 12.5], [2, 25], [3, 37.5]] });
    expect(north.pendingLineItems).toEqual({ invoices: 1, revenue: "230.00" });
    const south = await getConsultAttachRates(db.sql, { ...AUG_SEP, branchIds: [branch.south] });
    expect(south.pendingLineItems).toEqual({ invoices: 0, revenue: "0.00" });

    const bravo = await getConsultAttachRates(db.sql, { ...AUG_SEP, doctorIds: [staff["Dr Bravo Brown"]!] });
    expect(bravo.doctors.map((doctor) => doctor.name)).toEqual(["Dr Bravo Brown"]);
    expect(compact(bravo.allDoctors).consults).toBe(12);
  });

  it("has no doctors and no rates for a period without consults", async () => {
    const july = await getConsultAttachRates(db.sql, { dateFrom: "2026-07-01", dateTo: "2026-07-31" });
    expect(july.doctors).toEqual([]);
    expect(compact(july.allDoctors)).toEqual({
      consults: 0,
      whole: [[0, null], [0, null], [0, null], [0, null]],
      own: [[0, null], [0, null], [0, null], [0, null]],
    });
    expect(july.pendingLineItems).toEqual({ invoices: 0, revenue: "0.00" });
  });

  it("average items per invoice per doctor per clinic month, with the current month flagged partial — the Doctors page's definition", async () => {
    const trend = await getItemsPerInvoiceTrend(db.sql, AUG_SEP, { now: NOW });
    expect(trend.period).toEqual(AUG_SEP);
    expect(trend.months).toEqual([
      { month: "2026-08", dateFrom: "2026-08-01", dateTo: "2026-08-31", partial: false, partialReason: null },
      { month: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", partial: true, partialReason: "current_month" },
    ]);
    expect(trend.doctors).toEqual([
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        active: true,
        total: { itemLines: 14, invoices: 9, itemsPerInvoice: 1.56 },
        points: [
          { month: "2026-08", itemLines: 6, invoices: 4, itemsPerInvoice: 1.5 },
          { month: "2026-09", itemLines: 8, invoices: 5, itemsPerInvoice: 1.6 },
        ],
      },
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        active: true,
        total: { itemLines: 9, invoices: 6, itemsPerInvoice: 1.5 },
        points: [
          { month: "2026-08", itemLines: 5, invoices: 3, itemsPerInvoice: 1.67 },
          { month: "2026-09", itemLines: 4, invoices: 3, itemsPerInvoice: 1.33 },
        ],
      },
    ]);
    // Exactly the Doctors page's "items per invoice" over the same period.
    const ranking = await getDoctorRanking(db.sql, AUG_SEP);
    expect(ranking.doctors.map((doctor) => [doctor.name, doctor.itemsPerInvoice])).toEqual([
      ["Dr Alpha Anderson", 1.56],
      ["Dr Bravo Brown", 1.5],
    ]);
  });

  it("items per invoice follows the filter: months cut by the range are partial, branches and doctors narrow the series, later months are dropped", async () => {
    const cut = await getItemsPerInvoiceTrend(db.sql, { dateFrom: "2026-08-10", dateTo: "2026-09-15" }, { now: NOW });
    expect(cut.months.map((month) => [month.month, month.dateFrom, month.dateTo, month.partialReason])).toEqual([
      ["2026-08", "2026-08-10", "2026-08-31", "cut_by_range"],
      ["2026-09", "2026-09-01", "2026-09-15", "cut_by_range"],
    ]);
    expect(cut.doctors.map((doctor) => [doctor.name, doctor.total.itemsPerInvoice, doctor.points.map((point) => [point.itemLines, point.invoices, point.itemsPerInvoice])])).toEqual([
      ["Dr Alpha Anderson", 1.67, [[5, 3, 1.67], [5, 3, 1.67]]],
      ["Dr Bravo Brown", 1.67, [[4, 2, 2], [1, 1, 1]]],
    ]);

    const south = await getItemsPerInvoiceTrend(db.sql, { ...AUG_SEP, branchIds: [branch.south] }, { now: NOW });
    expect(south.doctors.map((doctor) => [doctor.name, doctor.points.map((point) => [point.itemLines, point.invoices, point.itemsPerInvoice])])).toEqual([
      ["Dr Bravo Brown", [[2, 1, 2], [3, 2, 1.5]]],
      ["Dr Alpha Anderson", [[2, 1, 2], [0, 0, null]]],
    ]);

    const bravo = await getItemsPerInvoiceTrend(db.sql, { ...AUG_SEP, doctorIds: [staff["Dr Bravo Brown"]!] }, { now: NOW });
    expect(bravo.doctors.map((doctor) => doctor.name)).toEqual(["Dr Bravo Brown"]);

    const later = await getItemsPerInvoiceTrend(db.sql, { dateFrom: "2026-09-01", dateTo: "2026-12-31" }, { now: NOW });
    expect(later.months.map((month) => [month.month, month.partialReason])).toEqual([["2026-09", "current_month"]]);
    const empty = await getItemsPerInvoiceTrend(db.sql, { dateFrom: "2026-07-01", dateTo: "2026-07-31" }, { now: NOW });
    expect(empty.doctors).toEqual([]);
  });

  it("defines every upsell metric once, for the page and for Claude", () => {
    for (const name of UPSELL_METRICS) expect(METRIC_DEFINITIONS[name]).toMatch(/\w/);
    expect(METRIC_DEFINITIONS.attachRate).toMatch(/charged more than zero/i);
    // The item-mapping rules Claude quotes: unmapped items count by type, never as diagnostics or as a consult.
    expect(METRIC_DEFINITIONS.attachRate).toMatch(/unmapped item[^.]*never[^.]*diagnostics/i);
    expect(METRIC_DEFINITIONS.consultInvoice).toMatch(/unmapped item[^.]*never[^.]*consult/i);
    expect(METRIC_DEFINITIONS.attachRate).toMatch(/Settings → Items/);
    expect(METRIC_DEFINITIONS.consultInvoice).toMatch(/not synced yet/i);
  });
});

/**
 * The documented rules on their own sales (`UPSELL_EDGE_CASES`, July 2026, all Dr Alpha's):
 *   consult invoices: 830001 (a FREE consult), 830003, 830004, 830006 = 4
 *     not: 830002 (its only consult line is a return), 830005 (an unmapped item is never a consult line)
 *   830001  X-ray                               diagnostics + second service
 *   830003  Antibiotic tablets, credited 0.00   product: its own line charged 50.00 (the discount line took the credit)
 *   830004  Mystery widget / Zeta session       unmapped: product and second service by ItemType, never diagnostics
 *   830006  Mystery widget 0.00                 free → nothing
 *   → diagnostics 1 (25.0) · products 2 (50.0) · second service 2 (50.0) · any 3 (75.0); own lines the same.
 * Once the owner maps "Doctor visit" as a consult (Settings → Items), 830005 is a consult invoice with a
 * Blood test: 5 consult invoices · diagnostics 2 (40.0) · products 2 (40.0) · second service 3 (60.0) · any 4 (80.0).
 */
describe("Analytics Service: the attach-rate rules (free and returned consults, discounted and unmapped add-ons)", () => {
  const db = useTestDatabase();
  const JULY = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };

  beforeAll(async () => {
    const sales = syntheticSales(UPSELL_EDGE_CASES);
    const h = createSyncHarness(db.sql, { fake: { saleList: { rows: sales.rows }, saleOverviews: sales.overviews } });
    const connectionId = await h.connect(both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-07-01", to: "2026-07-31" } })).toMatchObject({
      status: "succeeded",
      counts: { invoicesSeen: 6, lineItemsRead: 6 },
    });
  });

  it("the fixture is what the rules are about: a product credited 0.00 by an invoice discount, and unmapped items", async () => {
    const credited = await db.sql<{ itemName: string; amount: string; creditedAmount: string }[]>`
      select l.item_name, l.amount::text as amount, c.credited_amount::text as credited_amount
      from credited_lines c join invoice_lines l on l.id = c.invoice_line_id join invoices i on i.id = c.invoice_id
      where i.kreloses_sale_id = '830003' order by l.line_no
    `;
    expect(credited).toEqual([
      { itemName: "Consultation", amount: "100.00", creditedAmount: "0.00" },
      { itemName: "Antibiotic tablets", amount: "50.00", creditedAmount: "0.00" },
    ]);
    const unmapped = await db.sql<{ itemName: string; mixGroup: string; isConsult: boolean }[]>`
      select item_name, mix_group, is_consult from item_classifications
      where item_name in ('Mystery widget', 'Zeta session', 'Doctor visit') order by item_name
    `;
    expect(unmapped).toEqual([
      { itemName: "Doctor visit", mixGroup: "unmapped", isConsult: false },
      { itemName: "Mystery widget", mixGroup: "unmapped", isConsult: false },
      { itemName: "Zeta session", mixGroup: "unmapped", isConsult: false },
    ]);
  });

  it("a free consult makes a consult invoice, a returned one does not; a discounted-to-zero add-on counts; unmapped items count by ItemType, never as diagnostics", async () => {
    const rates = await getConsultAttachRates(db.sql, JULY);
    expect(rates.doctors.map((doctor) => [doctor.name, compact(doctor)])).toEqual([
      ["Dr Alpha Anderson", { consults: 4, whole: [[1, 25], [2, 50], [2, 50], [3, 75]], own: [[1, 25], [2, 50], [2, 50], [3, 75]] }],
    ]);
  });

  it("rates follow the owner's item mapping at once: an item mapped as a consult makes consult invoices", async () => {
    expect(
      await assignItem(db.sql, { itemKey: "Doctor visit", classification: { group: "consult", surgery: false, consult: true, vaccine: false, dentalScaling: false, procedure: false } }),
    ).toMatchObject({ status: "saved" });
    const rates = await getConsultAttachRates(db.sql, JULY);
    expect(rates.doctors.map(compact)).toEqual([{ consults: 5, whole: [[2, 40], [2, 40], [3, 60], [4, 80]], own: [[2, 40], [2, 40], [3, 60], [4, 80]] }]);
  });
});

describe("Analytics Service: a consult whose line items were not synced yet counts once they are", () => {
  const db = useTestDatabase();

  it("adds the sale to the doctor's consult invoices (and its add-ons) at the next sync that reads its page", async () => {
    const sales = syntheticSales(UPSELL_SCENARIO);
    const h = createSyncHarness(db.sql, { fake: { saleList: { rows: sales.rows }, saleOverviews: sales.overviews } });
    const connectionId = await syncScenario(h);
    const alpha = async () => (await getConsultAttachRates(db.sql, AUG_SEP)).doctors.find((doctor) => doctor.name === "Dr Alpha Anderson")!;
    expect(compact(await alpha()).consults).toBe(7);

    // Kreloses now opens 820015's page (Consultation + X-ray, both Alpha's).
    h.fake.saleOverviews["820015"] = syntheticSales(UPSELL_SCENARIO.filter((sale) => sale.saleId === 820015).map((sale) => ({ ...sale, page: true }))).overviews["820015"]!;
    h.clock.advance(60 * 60 * 1000);
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } })).toMatchObject({ status: "succeeded" });

    expect(compact(await alpha())).toEqual({ consults: 8, whole: [[3, 37.5], [2, 25], [4, 50], [6, 75]], own: [[1, 12.5], [1, 12.5], [2, 25], [3, 37.5]] });
    expect((await getConsultAttachRates(db.sql, AUG_SEP)).pendingLineItems).toEqual({ invoices: 0, revenue: "0.00" });
  });
});
