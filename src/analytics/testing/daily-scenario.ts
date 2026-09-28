import { addDays, addYears, type IsoDate } from "../../filters/dates";
import type { SyntheticSale } from "../../kreloses/testing/synthetic-sales";

/**
 * SYNTHETIC sales around one clinic day `day` for the Daily page (#11), used by the Seam 1 test
 * (`src/analytics/daily.test.ts`, which documents the hand-computed figures) and by the e2e spec
 * (`e2e/daily.spec.ts`, with `day` = yesterday). Every date is relative to `day`, so both get the
 * same figures. Build the Kreloses shapes with `syntheticSales(dailyScenario(day))`.
 *
 *   day      N 810001 C1 00:30  Dr Alpha 150.00 + Dr Bravo 50.00        (00:30 KL: the day before in UTC)
 *            N 810002 C2 10:00  Dr Alpha 300.00
 *            N 810003 C3 23:59  no staff 40.00 (product)                (last minute of the day)
 *            S 810004 C1 12:00  Dr Bravo 500.00
 *            S 810005 —  15:00  South General 60.00 (walk-in, generic account)
 *            S 810006 C4 16:00  Charlie 25.00 (other staff)
 *            N 810007 C5 11:00  Dr Alpha 999.00 CANCELLED
 *   day − 1  N 810008 C6 23:50  Dr Alpha 111.00                          (not the day)
 *   day + 1  N 810009 C6 00:10  Dr Alpha 222.00                          (not the day, though its UTC date is)
 *   day − 7  N 810011 C1 09:00  Dr Alpha 400.00
 *            S 810012 C7 14:00  Dr Bravo 200.00 + no staff 50.00
 *            S 810013 C7 18:00  Dr Delta 100.00 (a name matching no staff member)
 *   last yr  N 810021 C1 10:00  Dr Alpha 1,000.00                        (same date, one year earlier)
 */
export function dailyScenario(day: IsoDate): SyntheticSale[] {
  const lastWeek = addDays(day, -7);
  const lastYear = addYears(day, -1);
  return [
    {
      saleId: 810001,
      branch: "north",
      customer: 1,
      at: `${day} 00:30`,
      lines: [
        { name: "Consultation", staff: "Dr Alpha", amount: "150.00" },
        { name: "Vaccination - DHPPi", staff: "Dr Bravo", amount: "50.00" },
      ],
    },
    { saleId: 810002, branch: "north", customer: 2, at: `${day} 10:00`, lines: [{ name: "Surgery - Spay", staff: "Dr Alpha", amount: "300.00" }] },
    { saleId: 810003, branch: "north", customer: 3, at: `${day} 23:59`, lines: [{ name: "Shampoo", staff: null, amount: "40.00", itemType: 1 }] },
    { saleId: 810004, branch: "south", customer: 1, at: `${day} 12:00`, lines: [{ name: "Dental scaling", staff: "Dr Bravo", amount: "500.00" }] },
    { saleId: 810005, branch: "south", customer: null, at: `${day} 15:00`, lines: [{ name: "Microchip", staff: "South General", amount: "60.00" }] },
    { saleId: 810006, branch: "south", customer: 4, at: `${day} 16:00`, lines: [{ name: "Grooming", staff: "Charlie", amount: "25.00" }] },
    {
      saleId: 810007,
      branch: "north",
      customer: 5,
      at: `${day} 11:00`,
      status: "Cancelled",
      lines: [{ name: "Surgery - Neuter", staff: "Dr Alpha", amount: "999.00" }],
    },
    { saleId: 810008, branch: "north", customer: 6, at: `${addDays(day, -1)} 23:50`, lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "111.00" }] },
    { saleId: 810009, branch: "north", customer: 6, at: `${addDays(day, 1)} 00:10`, lines: [{ name: "Consultation", staff: "Dr Alpha", amount: "222.00" }] },
    { saleId: 810011, branch: "north", customer: 1, at: `${lastWeek} 09:00`, lines: [{ name: "Blood test panel", staff: "Dr Alpha", amount: "400.00" }] },
    {
      saleId: 810012,
      branch: "south",
      customer: 7,
      at: `${lastWeek} 14:00`,
      lines: [
        { name: "Consultation", staff: "Dr Bravo", amount: "200.00" },
        { name: "Collar", staff: null, amount: "50.00", itemType: 1 },
      ],
    },
    { saleId: 810013, branch: "south", customer: 7, at: `${lastWeek} 18:00`, lines: [{ name: "Rehab session", staff: "Dr Delta", amount: "100.00" }] },
    { saleId: 810021, branch: "north", customer: 1, at: `${lastYear} 10:00`, lines: [{ name: "Surgery - Cystotomy", staff: "Dr Alpha", amount: "1000.00" }] },
  ];
}
