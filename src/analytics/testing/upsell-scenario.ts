import type { SyntheticSale } from "../../kreloses/testing/synthetic-sales";

/**
 * SYNTHETIC sales for the Upsell page (#14), August–September 2026, used by the Seam 1 test
 * (`src/analytics/upsell.test.ts`, which documents the hand-computed figures) and the e2e spec
 * (`e2e/upsell.spec.ts`; its clinic "today" is 28 Sep 2026). Build the Kreloses shapes with
 * `syntheticSales(UPSELL_SCENARIO)`. The seeded item rules classify the items: Consultation and TCVM
 * examination are consult lines; X-ray, Blood test and Ultrasound are Diagnostics; Antibiotic
 * tablets, Shampoo and Prescription diet are products (ItemType 1); everything else is a service.
 *
 *   820001  5 Aug  N C1   Consultation (Alpha) 80 · X-ray (Bravo) 150           diagnostics by ANOTHER doctor
 *   820002 12 Aug  N C2   Consultation (Alpha) 80 · Antibiotic tablets (Alpha) 0.00, product   a FREE product only
 *   820003 19 Aug  S C3   Consultation (Alpha) 80 · TCVM examination (Alpha) 60  two consult lines, nothing else
 *   820004 20 Aug  S C4   Consultation (Bravo) 90 · Blood test (Bravo) 120       own diagnostics
 *   820005 26 Aug  N C5   Consultation (Alpha) 80 · Consultation (Bravo) 80 · X-ray (Bravo) 150   two consulting doctors
 *   820011  2 Sep  N C6   Consultation (Alpha) 80 · Surgery - Spay (Alpha) 500   consult + surgery
 *   820012  3 Sep  S C7   Consultation (Bravo) 100 · 5% DISCOUNT discount line (5.00)   a discount line is no add-on
 *   820013  4 Sep  S C8   Consultation (Bravo) 90 · X-ray (Bravo) 150  CANCELLED
 *   820014  9 Sep  N C9   Consultation (Alpha) 80 · Antibiotic tablets (Alpha) 45, product · Shampoo (Charlie) 30, product
 *   820015 10 Sep  N C10  Consultation (Alpha) 80 · X-ray (Alpha) 150  NO INVOICE PAGE: line items not synced yet
 *   820016 15 Sep  N C11  Consultation (Alpha) 80 · Prescription diet (no staff) 60, product
 *   820017 16 Sep  N C1   Consultation (Bravo) 90 · Vaccination - DHPPi (Alpha) 70
 *   820018 17 Sep  S C12  Consultation (Bravo) 90 · Prescription diet (Bravo) returned: −1 × 60.00, product
 *   820019 18 Sep  S C13  Consultation (Charlie) 50 · Ultrasound (Charlie) 150   other staff: no doctor's consult
 *   820020 22 Sep  N C14  Surgery - Neuter (Alpha) 400 · Antibiotic tablets (Alpha) 30, product   no consult
 */
export const UPSELL_SCENARIO: readonly SyntheticSale[] = [
  {
    saleId: 820001,
    branch: "north",
    customer: 1,
    at: "2026-08-05 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "X-ray", staff: "Dr Bravo", amount: "150.00" },
    ],
  },
  {
    saleId: 820002,
    branch: "north",
    customer: 2,
    at: "2026-08-12 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "Antibiotic tablets", staff: "Dr Alpha", amount: "0.00", itemType: 1 },
    ],
  },
  {
    saleId: 820003,
    branch: "south",
    customer: 3,
    at: "2026-08-19 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "TCVM examination", staff: "Dr Alpha", amount: "60.00" },
    ],
  },
  {
    saleId: 820004,
    branch: "south",
    customer: 4,
    at: "2026-08-20 11:00",
    lines: [
      { name: "Consultation", staff: "Dr Bravo", amount: "90.00" },
      { name: "Blood test", staff: "Dr Bravo", amount: "120.00" },
    ],
  },
  {
    saleId: 820005,
    branch: "north",
    customer: 5,
    at: "2026-08-26 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "Consultation", staff: "Dr Bravo", amount: "80.00" },
      { name: "X-ray", staff: "Dr Bravo", amount: "150.00" },
    ],
  },
  {
    saleId: 820011,
    branch: "north",
    customer: 6,
    at: "2026-09-02 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "Surgery - Spay", staff: "Dr Alpha", amount: "500.00" },
    ],
  },
  {
    saleId: 820012,
    branch: "south",
    customer: 7,
    at: "2026-09-03 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Bravo", amount: "100.00" },
      { name: "5% DISCOUNT", staff: null, amount: "-5.00", itemType: 55 },
    ],
  },
  {
    saleId: 820013,
    branch: "south",
    customer: 8,
    at: "2026-09-04 10:00",
    status: "Cancelled",
    lines: [
      { name: "Consultation", staff: "Dr Bravo", amount: "90.00" },
      { name: "X-ray", staff: "Dr Bravo", amount: "150.00" },
    ],
  },
  {
    saleId: 820014,
    branch: "north",
    customer: 9,
    at: "2026-09-09 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "Antibiotic tablets", staff: "Dr Alpha", amount: "45.00", itemType: 1 },
      { name: "Shampoo", staff: "Charlie", amount: "30.00", itemType: 1 },
    ],
  },
  {
    saleId: 820015,
    branch: "north",
    customer: 10,
    at: "2026-09-10 10:00",
    page: false,
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "X-ray", staff: "Dr Alpha", amount: "150.00" },
    ],
  },
  {
    saleId: 820016,
    branch: "north",
    customer: 11,
    at: "2026-09-15 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Alpha", amount: "80.00" },
      { name: "Prescription diet", staff: null, amount: "60.00", itemType: 1 },
    ],
  },
  {
    saleId: 820017,
    branch: "north",
    customer: 1,
    at: "2026-09-16 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Bravo", amount: "90.00" },
      { name: "Vaccination - DHPPi", staff: "Dr Alpha", amount: "70.00" },
    ],
  },
  {
    saleId: 820018,
    branch: "south",
    customer: 12,
    at: "2026-09-17 10:00",
    lines: [
      { name: "Consultation", staff: "Dr Bravo", amount: "90.00" },
      { name: "Prescription diet", staff: "Dr Bravo", itemType: 1, quantity: -1, unitPrice: "60.00", amount: "-60.00" },
    ],
  },
  {
    saleId: 820019,
    branch: "south",
    customer: 13,
    at: "2026-09-18 10:00",
    lines: [
      { name: "Consultation", staff: "Charlie", amount: "50.00" },
      { name: "Ultrasound", staff: "Charlie", amount: "150.00" },
    ],
  },
  {
    saleId: 820020,
    branch: "north",
    customer: 14,
    at: "2026-09-22 10:00",
    lines: [
      { name: "Surgery - Neuter", staff: "Dr Alpha", amount: "400.00" },
      { name: "Antibiotic tablets", staff: "Dr Alpha", amount: "30.00", itemType: 1 },
    ],
  },
];
