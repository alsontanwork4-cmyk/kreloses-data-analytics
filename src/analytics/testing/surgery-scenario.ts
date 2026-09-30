import type { ItemClassification } from "../../attribution/item-groups";
import type { SyntheticSale } from "../../kreloses/testing/synthetic-sales";

/**
 * SYNTHETIC sales for the surgery department, vaccines and dental (#15), used by the Seam 1 test
 * (`src/analytics/surgery.test.ts`, which documents every hand-computed figure) and the e2e spec
 * (`e2e/surgery.spec.ts`). Build the Kreloses shapes with `syntheticSales(SURGERY_SCENARIO)`.
 *
 * The item names are the scenario's OWN ("Syn …"), classified by explicit owner assignments
 * (`SURGERY_SCENARIO_ASSIGNMENTS`), so the figures never depend on the seeded item rules.
 * Staff: "Dr Alpha" / "Dr Bravo" (doctors in the synthetic staff list: Dr Alpha Anderson / Dr
 * Bravo Brown), "Dr Delta" (a doctor missing from it: alias-only), "Charlie" (other staff), none.
 * C = customer, N / S = Branch North / South, (P) = an operation (procedure), (s) = surgery but
 * not an operation (sedation / anaesthesia).
 *
 *   950019 N C1  2026-08-28  Dr Alpha Spay(P) 750.00                                 case (August)
 *   950001 N C1  2026-09-01  Dr Alpha Spay(P) 800.00, Sedation(s) 150.00, Meds 50.00 case, operation
 *   950002 N C1  2026-09-15  Dr Bravo Recheck 60.00                  C1's visit exactly 14 days after 950001
 *   950003 S C2  2026-09-02  Dr Bravo Sedation(s) 200.00, Consult 80.00             case, sedation only
 *   950004 S C2  2026-09-17  Dr Alpha Consult 80.00                  C2's visit 15 days after 950003
 *   950005 N C3  2026-09-03  Dr Alpha Spay(P) 900.00, Dr Bravo Mass removal(P) 600.00,
 *                            Dr Bravo Sedation(s) 100.00, Charlie Meds 40.00        two doctors, two procedures
 *   950006 N C3  2026-09-03  Dr Bravo Recheck 50.00 (16:00)          same day: not a follow-up
 *   950007 N C3  2026-09-05  Dr Bravo Recheck 50.00 CANCELLED        not a visit
 *   950008 S C4  2026-09-10  Dr Alpha Spay(P) 1,000.00 CANCELLED     not a case
 *   950009 N C5  2026-09-13  Dr Alpha Mass removal(P) 500.00, no staff Sedation(s) 120.00   case, operation
 *   950010 S C5  2026-09-14  Dr Delta Recheck 70.00                  C5's visit the next day, at the OTHER branch
 *   950011 N C6  2026-09-14  Dr Bravo Spay(P) 700.00                                 case, operation
 *   950012 N C6  2026-09-16  Dr Bravo Recheck 40.00                  C6's visit 2 days later
 *   950013 S —   2026-09-05  Dr Delta Sedation(s) 90.00 (walk-in)                     case, sedation only
 *   950014 N C7  2026-09-08  Dr Alpha Spay(P) 500.00 — its invoice page is missing: line items never read
 *   950015 N C8  2026-09-04  Dr Alpha Vaccine 120.00, Consult 80.00
 *   950016 S C9  2026-09-06  Dr Bravo Dental scaling 450.00, Vaccine 100.00, Charlie Vaccine 30.00
 *   950017 N C10 2026-09-27  Dr Alpha Dental scaling 300.00          the latest sale: synced through 27 Sep
 *   950018 N C11 2026-09-11  Dr Alpha Spay(P) returned: quantity −1 at 800.00 = (800.00)   not a case
 */
export const SURGERY_SCENARIO: readonly SyntheticSale[] = [
  { saleId: 950019, branch: "north", customer: 1, at: "2026-08-28 10:00", lines: [{ name: "Syn Spay", staff: "Dr Alpha", amount: "750.00" }] },
  {
    saleId: 950001,
    branch: "north",
    customer: 1,
    at: "2026-09-01 10:00",
    lines: [
      { name: "Syn Spay", staff: "Dr Alpha", amount: "800.00" },
      { name: "Syn Sedation", staff: "Dr Alpha", amount: "150.00" },
      { name: "Syn Meds", staff: "Dr Alpha", amount: "50.00", itemType: 1 },
    ],
  },
  { saleId: 950002, branch: "north", customer: 1, at: "2026-09-15 11:00", lines: [{ name: "Syn Recheck", staff: "Dr Bravo", amount: "60.00" }] },
  {
    saleId: 950003,
    branch: "south",
    customer: 2,
    at: "2026-09-02 10:00",
    lines: [
      { name: "Syn Sedation", staff: "Dr Bravo", amount: "200.00" },
      { name: "Syn Consult", staff: "Dr Bravo", amount: "80.00" },
    ],
  },
  { saleId: 950004, branch: "south", customer: 2, at: "2026-09-17 10:00", lines: [{ name: "Syn Consult", staff: "Dr Alpha", amount: "80.00" }] },
  {
    saleId: 950005,
    branch: "north",
    customer: 3,
    at: "2026-09-03 09:00",
    lines: [
      { name: "Syn Spay", staff: "Dr Alpha", amount: "900.00" },
      { name: "Syn Mass removal", staff: "Dr Bravo", amount: "600.00" },
      { name: "Syn Sedation", staff: "Dr Bravo", amount: "100.00" },
      { name: "Syn Meds", staff: "Charlie", amount: "40.00", itemType: 1 },
    ],
  },
  { saleId: 950006, branch: "north", customer: 3, at: "2026-09-03 16:00", lines: [{ name: "Syn Recheck", staff: "Dr Bravo", amount: "50.00" }] },
  {
    saleId: 950007,
    branch: "north",
    customer: 3,
    at: "2026-09-05 10:00",
    status: "Cancelled",
    lines: [{ name: "Syn Recheck", staff: "Dr Bravo", amount: "50.00" }],
  },
  {
    saleId: 950008,
    branch: "south",
    customer: 4,
    at: "2026-09-10 10:00",
    status: "Cancelled",
    lines: [{ name: "Syn Spay", staff: "Dr Alpha", amount: "1000.00" }],
  },
  {
    saleId: 950009,
    branch: "north",
    customer: 5,
    at: "2026-09-13 10:00",
    lines: [
      { name: "Syn Mass removal", staff: "Dr Alpha", amount: "500.00" },
      { name: "Syn Sedation", staff: null, amount: "120.00" },
    ],
  },
  { saleId: 950010, branch: "south", customer: 5, at: "2026-09-14 10:00", lines: [{ name: "Syn Recheck", staff: "Dr Delta", amount: "70.00" }] },
  { saleId: 950011, branch: "north", customer: 6, at: "2026-09-14 10:00", lines: [{ name: "Syn Spay", staff: "Dr Bravo", amount: "700.00" }] },
  { saleId: 950012, branch: "north", customer: 6, at: "2026-09-16 10:00", lines: [{ name: "Syn Recheck", staff: "Dr Bravo", amount: "40.00" }] },
  { saleId: 950013, branch: "south", customer: null, at: "2026-09-05 10:00", lines: [{ name: "Syn Sedation", staff: "Dr Delta", amount: "90.00" }] },
  { saleId: 950014, branch: "north", customer: 7, at: "2026-09-08 10:00", page: false, lines: [{ name: "Syn Spay", staff: "Dr Alpha", amount: "500.00" }] },
  {
    saleId: 950015,
    branch: "north",
    customer: 8,
    at: "2026-09-04 10:00",
    lines: [
      { name: "Syn Vaccine", staff: "Dr Alpha", amount: "120.00" },
      { name: "Syn Consult", staff: "Dr Alpha", amount: "80.00" },
    ],
  },
  {
    saleId: 950016,
    branch: "south",
    customer: 9,
    at: "2026-09-06 10:00",
    lines: [
      { name: "Syn Dental scaling", staff: "Dr Bravo", amount: "450.00" },
      { name: "Syn Vaccine", staff: "Dr Bravo", amount: "100.00" },
      { name: "Syn Vaccine", staff: "Charlie", amount: "30.00" },
    ],
  },
  { saleId: 950017, branch: "north", customer: 10, at: "2026-09-27 10:00", lines: [{ name: "Syn Dental scaling", staff: "Dr Alpha", amount: "300.00" }] },
  {
    saleId: 950018,
    branch: "north",
    customer: 11,
    at: "2026-09-11 10:00",
    lines: [{ name: "Syn Spay", staff: "Dr Alpha", amount: "-800.00", quantity: -1, unitPrice: "800.00" }],
  },
];

const NO_FLAGS = { surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false } as const;

/**
 * The owner's item assignments the scenario's figures assume (Settings → Items), by item key
 * (`itemKey`: lower case). Apply them with `assignItem` (unit tests) or by inserting
 * `item_assignments` rows before the sync (e2e).
 */
export const SURGERY_SCENARIO_ASSIGNMENTS: readonly { itemKey: string; classification: ItemClassification }[] = [
  { itemKey: "syn spay", classification: { ...NO_FLAGS, group: "surgery", surgery: true, procedure: true } },
  { itemKey: "syn mass removal", classification: { ...NO_FLAGS, group: "surgery", surgery: true, procedure: true } },
  { itemKey: "syn sedation", classification: { ...NO_FLAGS, group: "surgery", surgery: true } },
  { itemKey: "syn consult", classification: { ...NO_FLAGS, group: "consult", consult: true } },
  { itemKey: "syn recheck", classification: { ...NO_FLAGS, group: "consult", consult: true } },
  { itemKey: "syn vaccine", classification: { ...NO_FLAGS, group: "preventive", vaccine: true } },
  { itemKey: "syn dental scaling", classification: { ...NO_FLAGS, group: "preventive", dentalScaling: true } },
  { itemKey: "syn meds", classification: { ...NO_FLAGS, group: "medicines_supplements" } },
];
