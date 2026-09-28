import { describe, expect, it } from "vitest";

import {
  allocateLargestRemainder,
  creditInvoice,
  DISCOUNT_ITEM_TYPE,
  grossSen,
  invoiceRevenueBaseSen,
  type AttributionInvoice,
  type AttributionLine,
  type CreditedLine,
} from "./credit";

/**
 * Attribution & Rules (pure): an invoice's lines → credited lines that add up to the invoice's
 * revenue base exactly. Every expected figure below is worked out by hand in integer sen.
 */
const PRODUCT = 1;
const SERVICE = 4;

const active = (netSen: number, totalRefundsSen = 0): AttributionInvoice => ({ status: "active", netSen, totalRefundsSen });

let nextLineNo = 1;
function line(values: Partial<AttributionLine> & { amountSen: number | null }): AttributionLine {
  return {
    lineNo: values.lineNo ?? nextLineNo++,
    itemType: values.itemType ?? SERVICE,
    quantity: values.quantity === undefined ? "1" : values.quantity,
    unitPriceSen: values.unitPriceSen === undefined ? values.amountSen : values.unitPriceSen,
    amountSen: values.amountSen,
    staffName: values.staffName === undefined ? "Dr Alpha" : values.staffName,
  };
}
const discountLine = (lineNo: number, amountSen: number): AttributionLine => ({
  lineNo,
  itemType: DISCOUNT_ITEM_TYPE,
  quantity: null,
  unitPriceSen: null,
  amountSen,
  staffName: null,
});

const sum = (credited: CreditedLine[]) => credited.reduce((total, row) => total + row.creditedSen, 0);
const byStaff = (credited: CreditedLine[]) => {
  const totals: Record<string, number> = {};
  for (const row of credited) totals[row.staffName ?? "(no staff)"] = (totals[row.staffName ?? "(no staff)"] ?? 0) + row.creditedSen;
  return totals;
};

describe("invoiceRevenueBaseSen", () => {
  it("is the net amount of an active invoice; refunds are recorded but not subtracted (pending live verification)", () => {
    expect(invoiceRevenueBaseSen(active(120_000))).toBe(120_000);
    expect(invoiceRevenueBaseSen(active(110_000, 10_000))).toBe(110_000);
    expect(invoiceRevenueBaseSen(active(-12_000, 12_000))).toBe(-12_000);
  });

  it("is zero for a cancelled invoice", () => {
    expect(invoiceRevenueBaseSen({ status: "cancelled", netSen: 90_000, totalRefundsSen: 0 })).toBe(0);
  });
});

describe("grossSen (quantity × unit price, exact)", () => {
  it("multiplies decimal quantities without floating point and rounds half away from zero to the sen", () => {
    expect(grossSen("1", 15_000)).toBe(15_000);
    expect(grossSen("10", 2_000)).toBe(20_000);
    expect(grossSen("2.5", 7_220)).toBe(18_050);
    expect(grossSen("0.5", 10_000)).toBe(5_000);
    expect(grossSen("0.333", 1_000)).toBe(333);
    expect(grossSen("0.5", 1_235)).toBe(618); // 617.5 → 618
    expect(grossSen("-0.5", 1_235)).toBe(-618); // −617.5 → −618
    expect(grossSen("-1", 12_000)).toBe(-12_000);
    expect(grossSen("3", 35_000)).toBe(105_000);
    expect(grossSen("0.1", 3)).toBe(0); // 0.3 sen
    expect(grossSen("1.0001", 99_999_999_999)).toBe(100_009_999_999); // 100,009,999,998.9999 → no float drift
  });

  it("refuses anything that is not a plain decimal quantity", () => {
    for (const bad of ["", "1,000", "1e3", "abc", "1.2.3", " 1"]) expect(() => grossSen(bad, 100), bad).toThrow(RangeError);
  });
});

describe("allocateLargestRemainder", () => {
  it("splits an amount in proportion to the weights, exactly, giving leftover sen to the largest remainders", () => {
    // 60.00 over 1,050 / 1,200 / 180 / 50: 2540.32, 2903.23, 435.48, 120.97 → floors 5,998; +1 to .97 and .48.
    expect(allocateLargestRemainder(6_000, [105_000, 120_000, 18_000, 5_000])).toEqual([2_540, 2_903, 436, 121]);
    expect(allocateLargestRemainder(-6_000, [105_000, 120_000, 18_000, 5_000])).toEqual([-2_540, -2_903, -436, -121]);
  });

  it("breaks ties by position (line order)", () => {
    // 40.00 over 90 / 550 → 562.5 / 3437.5: one sen left, equal remainders → the first line.
    expect(allocateLargestRemainder(4_000, [9_000, 55_000])).toEqual([563, 3_437]);
    expect(allocateLargestRemainder(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateLargestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it("handles zero and huge amounts", () => {
    expect(allocateLargestRemainder(0, [3, 5])).toEqual([0, 0]);
    expect(allocateLargestRemainder(999_999_999_999, [1, 2])).toEqual([333_333_333_333, 666_666_666_666]);
  });

  it("refuses weights it cannot divide by", () => {
    expect(() => allocateLargestRemainder(100, [])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(100, [0, 0])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(100, [1, -1])).toThrow(RangeError);
  });
});

describe("creditInvoice", () => {
  it("single doctor: every line to that doctor, an invoice discount line spread in proportion to gross", () => {
    // 700101: 150 + 900 + 200 = 1,250 gross; a (50.00) discount line; net 1,200.
    const credited = creditInvoice(active(120_000), [
      line({ lineNo: 1, amountSen: 15_000 }),
      line({ lineNo: 2, amountSen: 90_000 }),
      line({ lineNo: 3, itemType: PRODUCT, quantity: "10", unitPriceSen: 2_000, amountSen: 20_000 }),
      discountLine(4, -5_000),
    ]);
    expect(credited).toEqual([
      { lineNo: 1, staffName: "Dr Alpha", grossSen: 15_000, lineAmountSen: 15_000, spreadSen: -600, creditedSen: 14_400 },
      { lineNo: 2, staffName: "Dr Alpha", grossSen: 90_000, lineAmountSen: 90_000, spreadSen: -3_600, creditedSen: 86_400 },
      { lineNo: 3, staffName: "Dr Alpha", grossSen: 20_000, lineAmountSen: 20_000, spreadSen: -800, creditedSen: 19_200 },
    ]);
    expect(sum(credited)).toBe(120_000);
  });

  it("two doctors on one invoice, with a fractional quantity", () => {
    // 700102: Dr Bravo 80.00; Dr Alpha 120.00 + 2.5 × 72.20 = 180.50. Lines add up to the net: nothing to spread.
    const credited = creditInvoice(active(38_050), [
      line({ lineNo: 1, amountSen: 8_000, staffName: "Dr Bravo" }),
      line({ lineNo: 2, amountSen: 12_000, staffName: "Dr Alpha" }),
      line({ lineNo: 3, itemType: PRODUCT, quantity: "2.5", unitPriceSen: 7_220, amountSen: 18_050, staffName: "Dr Alpha" }),
    ]);
    expect(byStaff(credited)).toEqual({ "Dr Bravo": 8_000, "Dr Alpha": 30_050 });
    expect(credited.map((row) => row.spreadSen)).toEqual([0, 0, 0]);
    expect(credited[2]).toMatchObject({ grossSen: 18_050, creditedSen: 18_050 });
  });

  it("no-staff lines are credited to nobody (\"No staff on line\"); blank names count as no staff", () => {
    const credited = creditInvoice(active(9_990), [
      line({ lineNo: 1, amountSen: 4_500, staffName: "Charlie" }),
      line({ lineNo: 2, itemType: PRODUCT, amountSen: 5_490, staffName: null }),
    ]);
    expect(credited.map((row) => [row.staffName, row.creditedSen])).toEqual([
      ["Charlie", 4_500],
      [null, 5_490],
    ]);
    const blank = creditInvoice(active(1_000), [line({ lineNo: 1, amountSen: 1_000, staffName: "   " })]);
    expect(blank[0]!.staffName).toBeNull();
    expect(creditInvoice(active(1_000), [line({ lineNo: 1, amountSen: 1_000, staffName: "  Dr  Alpha " })])[0]!.staffName).toBe("Dr Alpha");
  });

  it("item-level discounts stay on their line; invoice discount lines and gaps are spread over all lines by gross", () => {
    // 700104: 3 × 350 = 1,050 (Dr Bravo) · 1,200 less a 120.00 item discount = 1,080 (Dr Bravo) ·
    // 180 (no staff) · 0.5 × 100 = 50 (North General) · a (60.00) discount line. Net 2,300.00.
    // Spread −60.00 by gross 1,050 / 1,200 / 180 / 50 (of 2,480): −25.40, −29.03, −4.36, −1.21.
    const credited = creditInvoice(active(230_000), [
      line({ lineNo: 1, quantity: "3", unitPriceSen: 35_000, amountSen: 105_000, staffName: "Dr Bravo" }),
      line({ lineNo: 2, quantity: "1", unitPriceSen: 120_000, amountSen: 108_000, staffName: "Dr Bravo" }),
      line({ lineNo: 3, itemType: PRODUCT, amountSen: 18_000, staffName: null }),
      line({ lineNo: 4, itemType: PRODUCT, quantity: "0.5", unitPriceSen: 10_000, amountSen: 5_000, staffName: "North General" }),
      discountLine(5, -6_000),
    ]);
    expect(credited).toEqual([
      { lineNo: 1, staffName: "Dr Bravo", grossSen: 105_000, lineAmountSen: 105_000, spreadSen: -2_540, creditedSen: 102_460 },
      { lineNo: 2, staffName: "Dr Bravo", grossSen: 120_000, lineAmountSen: 108_000, spreadSen: -2_903, creditedSen: 105_097 },
      { lineNo: 3, staffName: null, grossSen: 18_000, lineAmountSen: 18_000, spreadSen: -436, creditedSen: 17_564 },
      { lineNo: 4, staffName: "North General", grossSen: 5_000, lineAmountSen: 5_000, spreadSen: -121, creditedSen: 4_879 },
    ]);
    expect(sum(credited)).toBe(230_000);
    expect(byStaff(credited)).toEqual({ "Dr Bravo": 207_557, "(no staff)": 17_564, "North General": 4_879 });
  });

  it("spreads a gap between the lines and the net even without a discount line (ties to the earlier line)", () => {
    // 700203: lines 100.00 + 160.00 = 260.00, net 250.00 → −10.00 by 100 / 160: −3.846 / −6.153 → −3.85 / −6.15.
    expect(
      creditInvoice(active(25_000), [
        line({ lineNo: 1, amountSen: 10_000, staffName: "Dr Bravo" }),
        line({ lineNo: 2, amountSen: 16_000, staffName: "Dr. Alpha" }),
      ]).map((row) => row.creditedSen),
    ).toEqual([9_615, 15_385]);
    // 700201: (40.00) over 90 / 550 → −5.625 / −34.375: equal remainders, the earlier line takes the sen.
    expect(
      creditInvoice(active(60_000), [
        line({ lineNo: 1, amountSen: 9_000 }),
        line({ lineNo: 2, quantity: "2", unitPriceSen: 27_500, amountSen: 55_000 }),
        discountLine(3, -4_000),
      ]).map((row) => row.spreadSen),
    ).toEqual([-563, -3_437]);
  });

  it("orders lines by line number whatever order they arrive in", () => {
    const credited = creditInvoice(active(3), [line({ lineNo: 2, amountSen: 0, unitPriceSen: 1 }), line({ lineNo: 1, amountSen: 0, unitPriceSen: 1 })]);
    expect(credited.map((row) => [row.lineNo, row.creditedSen])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  describe("edge cases", () => {
    it("all-zero gross: spreads by the lines' amounts instead", () => {
      const credited = creditInvoice(active(9_000), [
        line({ lineNo: 1, quantity: "0", unitPriceSen: 5_000, amountSen: 2_000 }),
        line({ lineNo: 2, quantity: "0", unitPriceSen: 5_000, amountSen: 8_000 }),
      ]);
      // −10.00 by 20 / 80 → −2.00 / −8.00
      expect(credited.map((row) => [row.grossSen, row.spreadSen, row.creditedSen])).toEqual([
        [0, -200, 1_800],
        [0, -800, 7_200],
      ]);
    });

    it("all-zero gross and amounts: splits equally (leftover sen to the earlier lines)", () => {
      const credited = creditInvoice(active(1_000), [
        line({ lineNo: 1, amountSen: 0, unitPriceSen: 0 }),
        line({ lineNo: 2, amountSen: 0, unitPriceSen: 0, staffName: "Dr Bravo" }),
        line({ lineNo: 3, amountSen: 0, unitPriceSen: 0, staffName: null }),
      ]);
      expect(credited.map((row) => row.creditedSen)).toEqual([334, 333, 333]);
    });

    it("negative lines (returns): weights are absolute gross, so the spread keeps the pool's sign", () => {
      // A whole return: nothing to spread.
      expect(
        creditInvoice(active(-12_000, 12_000), [line({ lineNo: 1, itemType: PRODUCT, quantity: "-1", unitPriceSen: 12_000, amountSen: -12_000, staffName: "Dr Delta" })]),
      ).toEqual([{ lineNo: 1, staffName: "Dr Delta", grossSen: -12_000, lineAmountSen: -12_000, spreadSen: 0, creditedSen: -12_000 }]);
      // A sale and a return on one invoice with a (8.00) discount: −8.00 over |100| / |−20| → −6.67 / −1.33.
      const mixed = creditInvoice(active(7_200), [
        line({ lineNo: 1, amountSen: 10_000 }),
        line({ lineNo: 2, quantity: "-1", unitPriceSen: 2_000, amountSen: -2_000, staffName: "Dr Bravo" }),
        discountLine(3, -800),
      ]);
      expect(mixed.map((row) => [row.spreadSen, row.creditedSen])).toEqual([
        [-667, 9_333],
        [-133, -2_133],
      ]);
      expect(sum(mixed)).toBe(7_200);
    });

    it("an invoice net of zero (fully discounted) credits zero to every line", () => {
      const credited = creditInvoice(active(0), [
        line({ lineNo: 1, amountSen: 3_000 }),
        line({ lineNo: 2, amountSen: 7_000, staffName: "Dr Bravo" }),
        discountLine(3, -10_000),
      ]);
      expect(credited.map((row) => row.creditedSen)).toEqual([0, 0]);
    });

    it("a gap with no non-discount lines becomes one unitemised remainder credited to no staff", () => {
      expect(creditInvoice(active(5_000), [discountLine(1, -1_000)])).toEqual([
        { lineNo: null, staffName: null, grossSen: 0, lineAmountSen: 0, spreadSen: 5_000, creditedSen: 5_000 },
      ]);
      expect(creditInvoice(active(5_000), [])).toEqual([
        { lineNo: null, staffName: null, grossSen: 0, lineAmountSen: 0, spreadSen: 5_000, creditedSen: 5_000 },
      ]);
      // Even a zero invoice without lines keeps one (zero) credited line, so it still counts as an invoice.
      expect(creditInvoice(active(0), [])).toEqual([
        { lineNo: null, staffName: null, grossSen: 0, lineAmountSen: 0, spreadSen: 0, creditedSen: 0 },
      ]);
    });

    it("a cancelled invoice credits nothing (its lines are kept at zero)", () => {
      const credited = creditInvoice({ status: "cancelled", netSen: 90_000, totalRefundsSen: 0 }, [line({ lineNo: 1, amountSen: 90_000 })]);
      expect(credited).toEqual([{ lineNo: 1, staffName: "Dr Alpha", grossSen: 90_000, lineAmountSen: 90_000, spreadSen: -90_000, creditedSen: 0 }]);
    });

    it("refuses lines it cannot credit (a caller bug, not data to guess about)", () => {
      expect(() => creditInvoice(active(100), [line({ lineNo: 1, amountSen: null })])).toThrow(RangeError);
      expect(() => creditInvoice(active(100), [line({ lineNo: 1, amountSen: 100 }), line({ lineNo: 1, amountSen: 100 })])).toThrow(RangeError);
    });
  });

  it("always sums to the revenue base exactly, whatever the lines (deterministic pseudo-random invoices)", () => {
    let seed = 20260928;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let invoice = 0; invoice < 500; invoice += 1) {
      const lines: AttributionLine[] = [];
      const count = random(6);
      for (let lineNo = 1; lineNo <= count; lineNo += 1) {
        if (random(5) === 0) {
          lines.push(discountLine(lineNo, -random(10_000)));
          continue;
        }
        const unitPriceSen = random(100_000) - (random(10) === 0 ? 50_000 : 0);
        const quantity = random(3) === 0 ? `${random(5)}.${random(1000)}` : String(random(4));
        const amountSen = grossSen(quantity, unitPriceSen) - random(500);
        lines.push({ lineNo, itemType: SERVICE, quantity, unitPriceSen, amountSen, staffName: random(3) === 0 ? null : `Dr ${random(4)}` });
      }
      const netSen = random(1_000_000) - 100_000;
      const credited = creditInvoice(active(netSen), lines);
      expect(sum(credited), `invoice ${invoice}`).toBe(netSen);
      for (const row of credited) expect(row.creditedSen).toBe(row.lineAmountSen + row.spreadSen);
      expect(credited.length).toBeGreaterThan(0);
    }
  });
});
