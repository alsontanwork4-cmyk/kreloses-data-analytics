import type { SaleListRow, SaleOverviewModel } from "@/kreloses/testing/fake-kreloses";

/**
 * SYNTHETIC sales with KNOWN return patterns for the retention tests (#13; hand-computed figures
 * in `retention.test.ts`). Written compactly here and turned into exactly the shapes Kreloses
 * sends — a `/Sale/Get` row and a `/Sale/Overview` page model per sale, amounts as formatted
 * strings (thousand separators, negatives in parentheses), `SaleDate` as `/Date(ms)/` — so the
 * Sync Engine reads them through the fake Kreloses like any other fixture. No real customers,
 * staff or amounts. Staff names on lines: "Dr Alpha" / "Dr Bravo" (doctors in the synthetic staff
 * list), "Dr Delta" (a doctor missing from it: alias-only), "Charlie" (other staff), none.
 */

/** A line as written below: amounts in sen; `qty` as Kreloses writes it ("1", "(1)" for a return). */
interface Line {
  name: string;
  /** 1 product, 4 service, 55 discount line. */
  type: 1 | 4 | 55;
  qty?: string;
  /** Unit price in sen (positive). */
  price?: number;
  staff: string | null;
}

interface Sale {
  id: number;
  /** Clinic day (Asia/Kuala_Lumpur). */
  day: string;
  /** KL wall-clock time, default 10:00. */
  time?: string;
  branch: "north" | "south";
  /** Synthetic customer number (Customer 1001…); null = walk-in. */
  customer: number | null;
  cancelled?: boolean;
  /** `"page missing"`: the Sale List lists it but its invoice page answers 404 (line items never read). */
  lines: Line[] | "page missing";
}

const A = "Dr Alpha";
const B = "Dr Bravo";
const D = "Dr Delta";
const consult = (staff: string | null): Line => ({ name: "Consultation", type: 4, price: 8000, staff });

/**
 * The sales, oldest first. C = customer; A/B/D = Dr Alpha/Bravo/Delta; N/S = Branch North/South.
 */
export const RETENTION_SALES: readonly Sale[] = [
  // C1001 — loyal to Dr Alpha, every year.
  { id: 800001, day: "2024-01-08", branch: "north", customer: 1001, lines: [consult(A)] },
  // C1002 — Dr Bravo in 2024, then only ever another doctor (Dr Alpha) in 2025.
  { id: 800002, day: "2024-05-06", branch: "north", customer: 1002, lines: [{ name: "Surgery - Spay", type: 4, price: 90000, staff: B }] },
  // C1003 — a same-day visit with two doctors across two invoices (one visit, attributed to both).
  { id: 800003, day: "2024-07-01", time: "10:00", branch: "north", customer: 1003, lines: [consult(A), { name: "X-ray", type: 4, qty: "2", price: 15000, staff: B }] },
  { id: 800004, day: "2024-07-01", time: "16:00", branch: "north", customer: 1003, lines: [{ name: "Dental scaling", type: 4, price: 60000, staff: B }] },
  // C1004 — Dr Alpha's service; Dr Bravo only sold a product on it (not a visit for Dr Bravo).
  {
    id: 800005,
    day: "2024-09-02",
    branch: "north",
    customer: 1004,
    lines: [consult(A), { name: "Flea spot-on", type: 1, price: 4500, staff: B }],
  },
  // C1005 — Dr Bravo; the 2025 "return" was cancelled.
  { id: 800006, day: "2024-10-07", branch: "south", customer: 1005, lines: [consult(B)] },
  { id: 800007, day: "2025-01-06", branch: "south", customer: 1005, cancelled: true, lines: [consult(B)] },
  { id: 800008, day: "2025-02-10", branch: "north", customer: 1001, lines: [consult(A)] },
  // C1004 comes back only for a product (with a discount line): not a service visit.
  {
    id: 800009,
    day: "2025-03-03",
    branch: "north",
    customer: 1004,
    lines: [
      { name: "Prescription diet 2kg", type: 1, price: 18000, staff: A },
      { name: "RM10 OFF", type: 55, price: 1000, staff: null },
    ],
  },
  { id: 800010, day: "2025-04-07", branch: "north", customer: 1009, lines: [consult(A)] },
  // C1010 — Dr Bravo at North in 2025, at South in 2026 (branch filter).
  { id: 800011, day: "2025-05-05", branch: "north", customer: 1010, lines: [consult(B)] },
  { id: 800012, day: "2025-06-02", branch: "north", customer: 1002, lines: [consult(A)] },
  { id: 800013, day: "2025-07-07", branch: "south", customer: 1003, lines: [consult(B)] },
  // C1011 — Dr Alpha in 2025; in 2026 only a returned service (quantity (1)) and a sale whose page is missing.
  { id: 800014, day: "2025-08-04", branch: "north", customer: 1011, lines: [consult(A)] },
  // C1014 — Dr Alpha at North, back 28 days later at South (Dr Bravo): a return, whichever branch.
  { id: 800035, day: "2025-10-06", branch: "north", customer: 1014, lines: [consult(A)] },
  { id: 800036, day: "2025-11-03", branch: "south", customer: 1014, lines: [consult(B)] },
  // Walk-ins (no customer): never a visit, whatever is on them — on the last two days of 2025.
  { id: 800033, day: "2025-12-30", branch: "north", customer: null, lines: [consult(A)] },
  { id: 800034, day: "2025-12-31", branch: "south", customer: null, lines: [{ name: "Flea spot-on", type: 1, price: 4500, staff: null }] },
  // C1006 — first visit 5 Jan 2026 (Dr Alpha), back after exactly 90 days (5 Apr) to Dr Bravo.
  { id: 800015, day: "2026-01-05", branch: "south", customer: 1006, lines: [consult(A)] },
  {
    id: 800016,
    day: "2026-01-12",
    branch: "north",
    customer: 1001,
    lines: [consult(A), { name: "Vaccination - DHPP", type: 4, price: 12000, staff: A }],
  },
  { id: 800017, day: "2026-01-19", branch: "south", customer: 1010, lines: [consult(B)] },
  // A walk-in (no customer) with Dr Alpha's service: never a visit.
  { id: 800018, day: "2026-01-26", branch: "north", customer: null, lines: [consult(A)] },
  // C1007 — first visit 2 Feb 2026 (Dr Bravo), back after 91 days (4 May).
  { id: 800019, day: "2026-02-02", branch: "south", customer: 1007, lines: [consult(B)] },
  // C1009 — back in 2026 only for a service by non-doctor staff (still a service visit).
  { id: 800020, day: "2026-02-09", branch: "north", customer: 1009, lines: [{ name: "Nail clipping", type: 4, price: 3000, staff: "Charlie" }] },
  // C1008 — two invoices on one day (Dr Delta): one visit, and not a return.
  { id: 800021, day: "2026-03-02", time: "10:00", branch: "north", customer: 1008, lines: [consult(D)] },
  { id: 800022, day: "2026-03-02", time: "15:00", branch: "north", customer: 1008, lines: [{ name: "Wound dressing", type: 4, price: 4500, staff: D }] },
  { id: 800023, day: "2026-03-09", branch: "north", customer: 1011, lines: [{ name: "Consultation", type: 4, qty: "(1)", price: 8000, staff: A }] },
  { id: 800024, day: "2026-03-16", branch: "north", customer: 1011, lines: "page missing" },
  { id: 800025, day: "2026-03-23", branch: "south", customer: 1003, lines: [consult(B)] },
  { id: 800026, day: "2026-04-05", branch: "south", customer: 1006, lines: [consult(B)] },
  { id: 800027, day: "2026-05-04", branch: "south", customer: 1007, lines: [consult(B)] },
  // C1013 — 2 Jul 2026 (Dr Bravo), exactly 90 days before the last synced day, back on it (Dr Delta).
  { id: 800028, day: "2026-07-02", branch: "north", customer: 1013, lines: [consult(B)] },
  // C1012 — Dr Alpha on 3 Aug 2026 (not yet mature), back 7 days later (no staff on the line).
  { id: 800029, day: "2026-08-03", branch: "south", customer: 1012, lines: [consult(A)] },
  { id: 800030, day: "2026-08-10", branch: "south", customer: 1012, lines: [consult(null)] },
  { id: 800031, day: "2026-09-30", branch: "north", customer: 1001, lines: [consult(A)] },
  { id: 800032, day: "2026-09-30", branch: "north", customer: 1013, lines: [consult(D)] },
];

const BRANCHES = { north: { id: 1101, name: "Branch North", code: "N" }, south: { id: 1102, name: "Branch South", code: "S" } } as const;

/** The Sale List rows and invoice page models the fake Kreloses serves for `RETENTION_SALES`. */
export function retentionFakeData(): { rows: SaleListRow[]; overviews: Record<string, SaleOverviewModel> } {
  const rows: SaleListRow[] = [];
  const overviews: Record<string, SaleOverviewModel> = {};
  for (const sale of RETENTION_SALES) {
    const branch = BRANCHES[sale.branch];
    const saleDate = `/Date(${Date.parse(`${sale.day}T${sale.time ?? "10:00"}:00+08:00`)})/`;
    const status = sale.cancelled ? "Cancelled" : "Active";
    const lines = sale.lines === "page missing" ? [consult(A)] : sale.lines;
    const items = lines.map((line, index) => item(sale.id, index, line));
    const grossSen = lines.filter((line) => line.type !== 55).reduce((sum, line) => sum + lineAmountSen(line), 0);
    const discountSen = lines.filter((line) => line.type === 55).reduce((sum, line) => sum + (line.price ?? 0), 0);
    const netSen = grossSen - discountSen;
    const customer = sale.customer === null ? null : { CustomerId: 90000 + sale.customer, Name: `Customer ${sale.customer}` };
    const totals = {
      GrossAmount: money(grossSen),
      Discounts: money(discountSen),
      NetAmount: money(netSen),
      TaxAmount: "0.00",
      Total: money(netSen),
      TotalPayments: money(Math.max(netSen, 0)),
      TotalRefunds: money(Math.max(-netSen, 0)),
    };
    rows.push({
      SaleId: sale.id,
      SaleName: `INV-${branch.code}-R${sale.id % 1000}`,
      Location: branch.name,
      LocationId: branch.id,
      CustomerId: customer?.CustomerId ?? null,
      CustomerName: customer?.Name ?? null,
      SaleDate: saleDate,
      SaleStatusName: status,
      ...totals,
      PaymentStatusName: "Paid",
    });
    if (sale.lines === "page missing") continue;
    overviews[String(sale.id)] = {
      Sale: {
        SaleId: sale.id,
        SaleName: `INV-${branch.code}-R${sale.id % 1000}`,
        SaleDate: saleDate,
        LocationId: branch.id,
        Location: branch.name,
        SaleStatusName: status,
        InvoiceCategory: "Standard",
        Notes: null,
      },
      Customer: customer ? { ...customer, Phone: `000-000 ${sale.customer}`, Email: null } : null,
      Items: items,
      Totals: { ...totals, Balance: "0.00" },
      Transactions: [],
      RefundInfo: null,
      CreditNoteInfo: null,
    };
  }
  return { rows, overviews };
}

/** Quantity × unit price in sen (a quantity in parentheses is negative). */
function lineAmountSen(line: Line): number {
  const qty = line.qty ?? "1";
  const negative = /^\(.*\)$/.test(qty);
  return (negative ? -1 : 1) * Number(qty.replace(/[()]/g, "")) * (line.price ?? 0);
}

function item(saleId: number, index: number, line: Line): Record<string, unknown> {
  const base = { SaleItemId: saleId * 10 + index + 1, Name: line.name, StaffName: line.staff ?? "", ItemType: line.type };
  if (line.type === 55) {
    return { ...base, Quantity: null, UnitPrice: null, Amount: money(-(line.price ?? 0)), DiscountName: line.name, DiscountAmount: money(line.price ?? 0) };
  }
  return {
    ...base,
    Quantity: line.qty ?? "1",
    UnitPrice: money(line.price ?? 0),
    Amount: money(lineAmountSen(line)),
    DiscountName: null,
    DiscountAmount: "0.00",
  };
}

/** Sen → Kreloses's money text: `"1,234.50"`, negatives in parentheses `"(80.00)"`. */
function money(sen: number): string {
  const abs = Math.abs(sen);
  const text = `${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return sen < 0 ? `(${text})` : text;
}
