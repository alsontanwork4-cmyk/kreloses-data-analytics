import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import {
  FIXTURES_DIR,
  readSaleListRows,
  readSaleOverviewModels,
  SYNTHETIC_ACCOUNTS,
  type SaleListRow,
  type SaleOverviewModel,
} from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getDiscountTypes, getDoctorDiscounts, getDoctorRanking, type DiscountFigures } from "./index";

/**
 * Seam 1: the Sync Engine reads the shared synthetic sales (sale-list-rows.json / sale-overviews.json)
 * PLUS the discount edge cases in `src/kreloses/__fixtures__/discount-sales.json` (July 2026) from
 * the fake Kreloses into a throwaway database; the Analytics Service must return exactly these
 * HAND-COMPUTED figures.
 *
 * Per credited line: discount = gross (quantity × unit price, rounded to the sen) − charged (the
 * credited amount: what the line charged after its own item discount AND its share of the invoice's
 * discount lines, spread by #5 in proportion to what each line charged — ADR 0006). Per doctor:
 * discount = Σ gross − Σ charged; rate = discount ÷ gross; an invoice counts as discounted for them
 * when THEIR share of its discount is over RM 0.05.
 *
 * SEPTEMBER 2026 (the shared fixture; credited amounts in src/analytics/doctors.test.ts)
 *   700101 N  Dr Alpha 150 → 144.00 (6.00) · 900 → 864.00 (36.00) · 10 × 20 → 192.00 (8.00)   "RM50 LOYALTY" (50.00)
 *   700102 N  Dr Bravo 80 · Dr Alpha 120 + 2.5 × 72.20 = 180.50                               no discount
 *   700104 N  Dr Bravo 3 × 350 = 1,050 → 1,023.31 (26.69) · 1,200 with "10% DISCOUNT" 120 → 1,080 → 1,052.54 (147.46)
 *             · no staff 180 → 175.42 (4.58) · North General 0.5 × 100 → 48.73 (1.27)          "RM60 VOUCHER" (60.00)
 *   700105 N  Charlie 45 · no staff 54.90                                                      no discount
 *   700201 S  Dr Delta 90 → 84.37 (5.63) · 2 × 275 → 515.63 (34.37)                           "RM40 OFF" -40.00
 *   700202 S  Dr Bravo 700 + 2 × 200 = 1,100 → 1,100 (a 100.00 refund is recorded: NOT a discount)
 *   700203 S  Dr Bravo 100 → 96.15 (3.85) · Dr. Alpha 160 → 153.85 (6.15)          lines 260 vs net 250: 10.00 difference
 *   700205 S  South General 45 (walk-in) · 700206 S Dr Delta return (1) × 120 → (120.00): gross = charged, no discount
 *
 *   Doctor          gross      charged    discount  rate   invoices  discounted (> RM 0.05)
 *   Dr Bravo        3,530.00   3,352.00   178.00    5.0 %  4         2 (700104 174.15, 700203 3.85) → 50.0 %
 *   Dr Alpha        1,710.50   1,654.35    56.15    3.3 %  3         2 (700101 50.00, 700203 6.15)  → 66.7 %
 *   Dr Delta          520.00     480.00    40.00    7.7 %  2         1 (700201)                     → 50.0 %
 *   Other: Charlie Chen 45.00 / 45.00 / 0.00 · 0.0 % · 1 · 0 → 0.0 %
 *   Generic: 95.00 / 93.73 / 1.27 · 1.3 % · 2 · 1 → 50.0 %  (North General 50.00 / 48.73 / 1.27 · 2.5 % · 1 · 1; South General 45 / 45 / 0 · 1 · 0)
 *   No staff: 234.90 / 230.32 / 4.58 · 1.9 % · 2 · 1 → 50.0 %
 *   Total: 6,135.40 / 5,855.40 / 280.00 · 4.6 % · 9 invoices · 4 discounted → 44.4 %
 *   Types: 10% DISCOUNT (item) 120.00 · RM60 VOUCHER 60.00 · RM50 LOYALTY 50.00 · RM40 OFF 40.00
 *          · difference to the invoice net 10.00 (700203)                      = 280.00, the total discount
 *
 * JULY 2026 (discount-sales.json; all Branch North except 710008)
 *   710001  Dr Alpha 100 → 95.00 (5.00) · Dr Bravo 300 → 285.00 (15.00)       "5% DISCOUNT" (20.00): shared 1 : 3
 *   710002  Dr Alpha 100 with "90% OFF" 90 → 10 → 4.55 (95.45) · Dr Bravo 100 → 45.45 (54.55)
 *           "RM60 OFF" (60.00) shared by CHARGED 10 : 100 → 5.45 / 54.55 (by gross it would push Dr Alpha below zero)
 *   710003  Dr Alpha 10 → 9.95: discount exactly RM 0.05 → NOT a discounted invoice   "ROUNDING" (0.05)
 *   710004  Dr Bravo 10 → 9.94: discount RM 0.06 → discounted                         "ROUNDING" (0.06)
 *   710005  Dr Alpha 2.5 × 72.20 = 180.50 with "STAFF 10%" 18.05 → 162.45 · 1.5 × 33.33 = 49.995 → gross 50.00 = charged
 *   710006  Dr Bravo 80 with "FREE CONSULT" 80 → 0 (charged nothing: no share) · Charlie 1 × 0.00 (gross 0)
 *           · Dr Alpha 120 → 108.00 (takes all of "RM12 OFF" (12.00))
 *   710007  Dr Bravo 200 → 191.92 · 50 with "5% DISCOUNT" 2.50 → 47.50 → 45.58     " 5% discount " (10.00) → 12.50
 *   710008 S  Dr Alpha 90 with an UNNAMED item discount of 9.00 → 81.00
 *   710009  active, no invoice page: line items not synced yet (500.00) — no gross known, so not in any discount figure
 *   710010  cancelled (50.00 discount): never counted
 *
 *   Doctor     gross     charged   discount  rate    invoices  discounted
 *   Dr Bravo   740.00    577.89    162.11    21.9 %  5         5 (incl. the 6-sen one)          → 100.0 %
 *   Dr Alpha   650.50    510.95    139.55    21.5 %  6         5 (not the 5-sen one)            →  83.3 %
 *   Other: Charlie Chen 0.00 / 0.00 / 0.00 · no rate (gross 0) · 1 · 0 → 0.0 %
 *   Total: 1,390.50 / 1,088.84 / 301.66 · 21.7 % · 8 invoices · 7 discounted → 87.5 %
 *   Types: 90% OFF 90.00 · FREE CONSULT 80.00 · RM60 OFF 60.00 · 5% DISCOUNT (item + invoice, 3 lines, 2 invoices) 32.50
 *          · STAFF 10% 18.05 · RM12 OFF 12.00 · Item discount (no name) 9.00 · ROUNDING (2 lines) 0.11   = 301.66
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const JULY = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };
const july = (day: number) => ({ dateFrom: `2026-07-0${day}`, dateTo: `2026-07-0${day}` });

const NOTHING: DiscountFigures = {
  gross: "0.00",
  charged: "0.00",
  discount: "0.00",
  discountRatePercent: null,
  invoices: 0,
  discountedInvoices: 0,
  discountedInvoicesPercent: null,
};

const discountSales = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "discount-sales.json"), "utf8")) as {
  rows: SaleListRow[];
  models: Record<string, SaleOverviewModel>;
};

describe("Analytics Service: discounts (fed by the Sync Engine, line items included)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  const sync = (dateRange = { from: "2026-07-01", to: "2026-09-30" }) => runSync(h.deps(), connectionId, "manual", { dateRange, pageSize: 7 });
  /** A doctor row without its ids (asserted separately), for compact expectations. */
  const figures = (rows: { name: string }[]) => rows.map(({ name, ...rest }) => ({ name, ...pick(rest as unknown as DiscountFigures) }));

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, {
      now: new Date("2026-10-01T02:00:00Z"),
      fake: {
        saleList: { rows: [...readSaleListRows(), ...discountSales.rows] },
        saleOverviews: { ...readSaleOverviewModels(), ...discountSales.models },
      },
    });
    connectionId = await h.connect(both, "Both branches");
    // 710009 has no invoice page: the run reads everything else and ends "partial" (that sale stays pending).
    expect(await sync()).toMatchObject({ status: "partial", counts: { lineItemsFailed: 1 } });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  it("per doctor: discount total, discount rate and share of invoices discounted; other groups apart (September)", async () => {
    const discounts = await getDoctorDiscounts(db.sql, SEPTEMBER);
    expect(discounts.period).toEqual(SEPTEMBER);
    expect(discounts.total).toEqual({
      gross: "6135.40",
      charged: "5855.40",
      discount: "280.00",
      discountRatePercent: 4.6,
      invoices: 9,
      discountedInvoices: 4,
      discountedInvoicesPercent: 44.4,
    });
    expect(discounts.doctors).toEqual([
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        active: true,
        gross: "3530.00",
        charged: "3352.00",
        discount: "178.00",
        discountRatePercent: 5,
        invoices: 4,
        discountedInvoices: 2,
        discountedInvoicesPercent: 50,
      },
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        active: true,
        gross: "1710.50",
        charged: "1654.35",
        discount: "56.15",
        discountRatePercent: 3.3,
        invoices: 3,
        discountedInvoices: 2,
        discountedInvoicesPercent: 66.7,
      },
      {
        staffId: staff["Dr Delta"],
        name: "Dr Delta",
        source: "alias_only",
        active: true,
        gross: "520.00",
        charged: "480.00",
        discount: "40.00",
        discountRatePercent: 7.7,
        invoices: 2,
        discountedInvoices: 1,
        discountedInvoicesPercent: 50,
      },
    ]);
    const charlie = { gross: "45.00", charged: "45.00", discount: "0.00", discountRatePercent: 0, invoices: 1, discountedInvoices: 0, discountedInvoicesPercent: 0 };
    expect(discounts.groups).toEqual({
      other: {
        ...charlie,
        members: [{ staffId: staff["Charlie Chen"], name: "Charlie Chen", source: "kreloses", active: true, ...charlie }],
      },
      generic: {
        gross: "95.00",
        charged: "93.73",
        discount: "1.27",
        discountRatePercent: 1.3,
        invoices: 2,
        discountedInvoices: 1,
        discountedInvoicesPercent: 50,
        members: [
          {
            staffId: staff["Branch North General"],
            name: "Branch North General",
            source: "kreloses",
            active: true,
            gross: "50.00",
            charged: "48.73",
            discount: "1.27",
            discountRatePercent: 2.5,
            invoices: 1,
            discountedInvoices: 1,
            discountedInvoicesPercent: 100,
          },
          {
            staffId: staff["Branch South General"],
            name: "Branch South General",
            source: "kreloses",
            active: true,
            gross: "45.00",
            charged: "45.00",
            discount: "0.00",
            discountRatePercent: 0,
            invoices: 1,
            discountedInvoices: 0,
            discountedInvoicesPercent: 0,
          },
        ],
      },
      noStaff: { gross: "234.90", charged: "230.32", discount: "4.58", discountRatePercent: 1.9, invoices: 2, discountedInvoices: 1, discountedInvoicesPercent: 50 },
    });
    expect(discounts.pendingLineItems).toEqual({ invoices: 0, revenue: "0.00" });
  });

  it("charged is the revenue credited (the Doctors page's figure), so gross − discount = revenue", async () => {
    for (const period of [SEPTEMBER, JULY]) {
      const [discounts, ranking] = await Promise.all([getDoctorDiscounts(db.sql, period), getDoctorRanking(db.sql, period)]);
      const charged = Object.fromEntries(discounts.doctors.map((row) => [row.staffId, row.charged]));
      expect(charged).toEqual(Object.fromEntries(ranking.doctors.map((row) => [row.staffId, row.revenue])));
    }
  });

  it("lists the discount types used — item discounts, discount lines and any difference to the invoice net — adding up to the total discount (September)", async () => {
    expect(await getDiscountTypes(db.sql, SEPTEMBER)).toEqual({
      period: SEPTEMBER,
      total: "280.00",
      types: [
        { key: "name:10% discount", label: "10% DISCOUNT", appliedTo: "item", lines: 1, invoices: 1, amount: "120.00", sharePercent: 42.9 },
        { key: "name:rm60 voucher", label: "RM60 VOUCHER", appliedTo: "invoice", lines: 1, invoices: 1, amount: "60.00", sharePercent: 21.4 },
        { key: "name:rm50 loyalty", label: "RM50 LOYALTY", appliedTo: "invoice", lines: 1, invoices: 1, amount: "50.00", sharePercent: 17.9 },
        { key: "name:rm40 off", label: "RM40 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "40.00", sharePercent: 14.3 },
        {
          key: "difference",
          label: "Difference to the invoice net (no discount line)",
          appliedTo: "difference",
          lines: null,
          invoices: 1,
          amount: "10.00",
          sharePercent: 3.6,
        },
      ],
    });
  });

  it("shares an invoice's discount between its doctors in proportion to what each line charged (no item discounts: = gross)", async () => {
    const shared = await getDoctorDiscounts(db.sql, july(1));
    expect(figures(shared.doctors)).toEqual([
      { name: "Dr Bravo Brown", gross: "300.00", charged: "285.00", discount: "15.00", discountRatePercent: 5, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
      { name: "Dr Alpha Anderson", gross: "100.00", charged: "95.00", discount: "5.00", discountRatePercent: 5, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
    ]);
    expect((await getDiscountTypes(db.sql, july(1))).types).toEqual([
      { key: "name:5% discount", label: "5% DISCOUNT", appliedTo: "invoice", lines: 1, invoices: 1, amount: "20.00", sharePercent: 100 },
    ]);
  });

  it("with an item discount on one doctor's line, the invoice discount is shared by the amounts after it (never pushing a line below zero)", async () => {
    const shared = await getDoctorDiscounts(db.sql, july(2));
    expect(figures(shared.doctors)).toEqual([
      // 90.00 item discount + 5.45 of the RM60 (10 : 100 of what the lines charged).
      { name: "Dr Alpha Anderson", gross: "100.00", charged: "4.55", discount: "95.45", discountRatePercent: 95.5, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
      { name: "Dr Bravo Brown", gross: "100.00", charged: "45.45", discount: "54.55", discountRatePercent: 54.6, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
    ]);
    expect((await getDiscountTypes(db.sql, july(2))).types).toEqual([
      { key: "name:90% off", label: "90% OFF", appliedTo: "item", lines: 1, invoices: 1, amount: "90.00", sharePercent: 60 },
      { key: "name:rm60 off", label: "RM60 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "60.00", sharePercent: 40 },
    ]);
  });

  it("counts an invoice as discounted only when the doctor's share is over RM 0.05: exactly 5 sen is not, 6 sen is", async () => {
    const threshold = await getDoctorDiscounts(db.sql, { dateFrom: "2026-07-03", dateTo: "2026-07-04" });
    expect(figures(threshold.doctors)).toEqual([
      { name: "Dr Bravo Brown", gross: "10.00", charged: "9.94", discount: "0.06", discountRatePercent: 0.6, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
      { name: "Dr Alpha Anderson", gross: "10.00", charged: "9.95", discount: "0.05", discountRatePercent: 0.5, invoices: 1, discountedInvoices: 0, discountedInvoicesPercent: 0 },
    ]);
    expect(threshold.total).toMatchObject({ discount: "0.11", invoices: 2, discountedInvoices: 1, discountedInvoicesPercent: 50 });
    // The discount itself still counts in full, and both lines share one (normalised) type.
    expect((await getDiscountTypes(db.sql, { dateFrom: "2026-07-03", dateTo: "2026-07-04" })).types).toEqual([
      { key: "name:rounding", label: "ROUNDING", appliedTo: "invoice", lines: 2, invoices: 2, amount: "0.11", sharePercent: 100 },
    ]);
  });

  it("takes gross as quantity × unit price rounded to the sen, fractional quantities included", async () => {
    const fractional = await getDoctorDiscounts(db.sql, july(5));
    // 2.5 × 72.20 = 180.50 (18.05 off) and 1.5 × 33.33 = 49.995 → 50.00, charged 50.00: no phantom discount.
    expect(figures(fractional.doctors)).toEqual([
      { name: "Dr Alpha Anderson", gross: "230.50", charged: "212.45", discount: "18.05", discountRatePercent: 7.8, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
    ]);
    expect((await getDiscountTypes(db.sql, july(5))).types).toEqual([
      { key: "name:staff 10%", label: "STAFF 10%", appliedTo: "item", lines: 1, invoices: 1, amount: "18.05", sharePercent: 100 },
    ]);
  });

  it("handles fully discounted and zero-price lines: no share of the invoice discount, no rate without gross", async () => {
    const free = await getDoctorDiscounts(db.sql, july(6));
    expect(figures(free.doctors)).toEqual([
      { name: "Dr Bravo Brown", gross: "80.00", charged: "0.00", discount: "80.00", discountRatePercent: 100, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
      { name: "Dr Alpha Anderson", gross: "120.00", charged: "108.00", discount: "12.00", discountRatePercent: 10, invoices: 1, discountedInvoices: 1, discountedInvoicesPercent: 100 },
    ]);
    const charlie = { gross: "0.00", charged: "0.00", discount: "0.00", discountRatePercent: null, invoices: 1, discountedInvoices: 0, discountedInvoicesPercent: 0 };
    expect(free.groups.other).toEqual({ ...charlie, members: [{ staffId: staff["Charlie Chen"], name: "Charlie Chen", source: "kreloses", active: true, ...charlie }] });
    expect((await getDiscountTypes(db.sql, july(6))).types).toEqual([
      { key: "name:free consult", label: "FREE CONSULT", appliedTo: "item", lines: 1, invoices: 1, amount: "80.00", sharePercent: 87 },
      { key: "name:rm12 off", label: "RM12 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "12.00", sharePercent: 13 },
    ]);
  });

  it("adds up a month: names grouped ignoring case and spaces (shown as most often written), unnamed discounts kept (July)", async () => {
    const discounts = await getDoctorDiscounts(db.sql, JULY);
    expect(figures(discounts.doctors)).toEqual([
      { name: "Dr Bravo Brown", gross: "740.00", charged: "577.89", discount: "162.11", discountRatePercent: 21.9, invoices: 5, discountedInvoices: 5, discountedInvoicesPercent: 100 },
      { name: "Dr Alpha Anderson", gross: "650.50", charged: "510.95", discount: "139.55", discountRatePercent: 21.5, invoices: 6, discountedInvoices: 5, discountedInvoicesPercent: 83.3 },
    ]);
    expect(discounts.total).toEqual({
      gross: "1390.50",
      charged: "1088.84",
      discount: "301.66",
      discountRatePercent: 21.7,
      invoices: 8,
      discountedInvoices: 7,
      discountedInvoicesPercent: 87.5,
    });
    expect(discounts.groups.generic).toEqual({ ...NOTHING, members: [] });
    expect(discounts.groups.noStaff).toEqual(NOTHING);

    expect(await getDiscountTypes(db.sql, JULY)).toEqual({
      period: JULY,
      total: "301.66",
      types: [
        { key: "name:90% off", label: "90% OFF", appliedTo: "item", lines: 1, invoices: 1, amount: "90.00", sharePercent: 29.8 },
        { key: "name:free consult", label: "FREE CONSULT", appliedTo: "item", lines: 1, invoices: 1, amount: "80.00", sharePercent: 26.5 },
        { key: "name:rm60 off", label: "RM60 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "60.00", sharePercent: 19.9 },
        { key: "name:5% discount", label: "5% DISCOUNT", appliedTo: "both", lines: 3, invoices: 2, amount: "32.50", sharePercent: 10.8 },
        { key: "name:staff 10%", label: "STAFF 10%", appliedTo: "item", lines: 1, invoices: 1, amount: "18.05", sharePercent: 6 },
        { key: "name:rm12 off", label: "RM12 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "12.00", sharePercent: 4 },
        { key: "unnamed-item", label: "Item discount (no name)", appliedTo: "item", lines: 1, invoices: 1, amount: "9.00", sharePercent: 3 },
        { key: "name:rounding", label: "ROUNDING", appliedTo: "invoice", lines: 2, invoices: 2, amount: "0.11", sharePercent: 0 },
      ],
    });
  });

  it("leaves out sales whose line items are not synced yet (no gross is known) and says how many; never counts cancelled sales", async () => {
    const discounts = await getDoctorDiscounts(db.sql, july(9));
    expect(discounts.total).toEqual(NOTHING);
    expect(discounts.doctors).toEqual([]);
    expect(discounts.pendingLineItems).toEqual({ invoices: 1, revenue: "500.00" });
    expect(await getDiscountTypes(db.sql, july(9))).toEqual({ period: july(9), total: "0.00", types: [] });
    // Also under a doctor filter (those sales are credited to nobody yet).
    expect((await getDoctorDiscounts(db.sql, { ...JULY, doctorIds: [staff["Dr Alpha Anderson"]!] })).pendingLineItems).toEqual({ invoices: 1, revenue: "500.00" });
    // 710010 is cancelled.
    expect((await getDoctorDiscounts(db.sql, { dateFrom: "2026-07-10", dateTo: "2026-07-10" })).total).toEqual(NOTHING);
  });

  it("applies the doctor filter: their figures, and each discount type's share that fell on their lines", async () => {
    const alpha = { ...JULY, doctorIds: [staff["Dr Alpha Anderson"]!] };
    const discounts = await getDoctorDiscounts(db.sql, alpha);
    expect(figures(discounts.doctors)).toEqual([
      { name: "Dr Alpha Anderson", gross: "650.50", charged: "510.95", discount: "139.55", discountRatePercent: 21.5, invoices: 6, discountedInvoices: 5, discountedInvoicesPercent: 83.3 },
    ]);
    expect(discounts.total).toEqual({ ...pick(discounts.doctors[0]!) });
    expect(discounts.groups).toEqual({ other: { ...NOTHING, members: [] }, generic: { ...NOTHING, members: [] }, noStaff: NOTHING });

    // Dr Bravo's FREE CONSULT is not Dr Alpha's; Dr Alpha bore 5.45 of RM60 OFF (710002), 5.00 of the 5% (710001) and all of RM12 OFF.
    expect(await getDiscountTypes(db.sql, alpha)).toEqual({
      period: JULY,
      total: "139.55",
      types: [
        { key: "name:90% off", label: "90% OFF", appliedTo: "item", lines: 1, invoices: 1, amount: "90.00", sharePercent: 64.5 },
        { key: "name:staff 10%", label: "STAFF 10%", appliedTo: "item", lines: 1, invoices: 1, amount: "18.05", sharePercent: 12.9 },
        { key: "name:rm12 off", label: "RM12 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "12.00", sharePercent: 8.6 },
        { key: "unnamed-item", label: "Item discount (no name)", appliedTo: "item", lines: 1, invoices: 1, amount: "9.00", sharePercent: 6.4 },
        { key: "name:rm60 off", label: "RM60 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "5.45", sharePercent: 3.9 },
        { key: "name:5% discount", label: "5% DISCOUNT", appliedTo: "invoice", lines: 1, invoices: 1, amount: "5.00", sharePercent: 3.6 },
        { key: "name:rounding", label: "ROUNDING", appliedTo: "invoice", lines: 1, invoices: 1, amount: "0.05", sharePercent: 0 },
      ],
    });

    // Dr Bravo charged nothing on 710006, so none of its RM12 OFF is his.
    expect((await getDiscountTypes(db.sql, { ...JULY, doctorIds: [staff["Dr Bravo Brown"]!] })).types).toEqual([
      { key: "name:free consult", label: "FREE CONSULT", appliedTo: "item", lines: 1, invoices: 1, amount: "80.00", sharePercent: 49.3 },
      { key: "name:rm60 off", label: "RM60 OFF", appliedTo: "invoice", lines: 1, invoices: 1, amount: "54.55", sharePercent: 33.6 },
      { key: "name:5% discount", label: "5% DISCOUNT", appliedTo: "both", lines: 3, invoices: 2, amount: "27.50", sharePercent: 17 },
      { key: "name:rounding", label: "ROUNDING", appliedTo: "invoice", lines: 1, invoices: 1, amount: "0.06", sharePercent: 0 },
    ]);

    // September, Dr Bravo: his 10% item discount, 54.15 of the RM60 VOUCHER and 3.85 of the 10.00 difference = 178.00.
    expect((await getDiscountTypes(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] })).types.map((row) => [row.label, row.amount])).toEqual([
      ["10% DISCOUNT", "120.00"],
      ["RM60 VOUCHER", "54.15"],
      ["Difference to the invoice net (no discount line)", "3.85"],
    ]);

    const nobody = { ...JULY, doctorIds: ["999999", "not-an-id"] };
    expect((await getDoctorDiscounts(db.sql, nobody)).doctors).toEqual([]);
    expect((await getDiscountTypes(db.sql, nobody)).types).toEqual([]);
  });

  it("applies the branch filter", async () => {
    const north = { ...JULY, branchIds: [branch.north] };
    expect(figures((await getDoctorDiscounts(db.sql, north)).doctors)).toEqual([
      { name: "Dr Bravo Brown", gross: "740.00", charged: "577.89", discount: "162.11", discountRatePercent: 21.9, invoices: 5, discountedInvoices: 5, discountedInvoicesPercent: 100 },
      { name: "Dr Alpha Anderson", gross: "560.50", charged: "429.95", discount: "130.55", discountRatePercent: 23.3, invoices: 5, discountedInvoices: 4, discountedInvoicesPercent: 80 },
    ]);
    expect((await getDiscountTypes(db.sql, north)).types.map((row) => row.key)).not.toContain("unnamed-item");
    const south = await getDiscountTypes(db.sql, { ...JULY, branchIds: [branch.south] });
    expect(south).toEqual({
      period: JULY,
      total: "9.00",
      types: [{ key: "unnamed-item", label: "Item discount (no name)", appliedTo: "item", lines: 1, invoices: 1, amount: "9.00", sharePercent: 100 }],
    });
  });

  it("returns zero figures and no types for a period without sales", async () => {
    const empty = { dateFrom: "2024-01-01", dateTo: "2024-01-31" };
    expect(await getDoctorDiscounts(db.sql, empty)).toEqual({
      period: empty,
      total: NOTHING,
      doctors: [],
      groups: { other: { ...NOTHING, members: [] }, generic: { ...NOTHING, members: [] }, noStaff: NOTHING },
      pendingLineItems: { invoices: 0, revenue: "0.00" },
    });
    expect(await getDiscountTypes(db.sql, empty)).toEqual({ period: empty, total: "0.00", types: [] });
  });

  // Last: it changes the fake's data.
  it("does not count a refund as a discount: discounts use what was charged before any refund", async () => {
    const before = await getDoctorDiscounts(db.sql, july(1));
    const row = h.fake.saleRows.find((sale) => sale.SaleId === 710001)!;
    row.TotalRefunds = "95.00";
    (h.fake.saleOverviews["710001"]!.Totals as Record<string, unknown>).TotalRefunds = "95.00";
    h.clock.advance(60 * 60 * 1000);
    const resync = await sync({ from: "2026-07-01", to: "2026-07-01" });
    // The refund changed the invoice, so its line items were read again…
    expect(resync).toMatchObject({ counts: { updated: 1, lineItemsRead: 1 } });
    expect(await db.sql`select total_refunds::text from invoices where kreloses_sale_id = '710001'`).toEqual([{ totalRefunds: "95.00" }]);
    // …and the discounts are exactly what they were.
    expect(await getDoctorDiscounts(db.sql, july(1))).toEqual(before);
    expect(before.total.discount).toBe("20.00");
  });
});

function pick(row: DiscountFigures): DiscountFigures {
  return {
    gross: row.gross,
    charged: row.charged,
    discount: row.discount,
    discountRatePercent: row.discountRatePercent,
    invoices: row.invoices,
    discountedInvoices: row.discountedInvoices,
    discountedInvoicesPercent: row.discountedInvoicesPercent,
  };
}
