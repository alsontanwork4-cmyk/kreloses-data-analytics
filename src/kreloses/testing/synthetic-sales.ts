import { moneyToSen, type Money } from "../../lib/money";

import type { SaleListRow, SaleOverviewModel } from "./fake-kreloses";

/**
 * SYNTHETIC Kreloses sales built from a short description: for each sale, its Sale List row (as
 * `POST /Sale/Get` returns it, like `__fixtures__/sale-list-rows.json`) and its Sale Overview page
 * model (`GET /Sale/Overview/{id}`, like `__fixtures__/sale-overviews.json`). A test serves them
 * from its own fake — `createFakeKreloses({ saleList: { rows }, saleOverviews: overviews })` (or
 * `createSyncHarness(sql, { fake: … })`), or the e2e fake's control endpoint
 * (`e2e/support/fake-kreloses-control.ts`) — instead of editing the shared fixture files, and can
 * place sales on dates relative to "today" (e2e).
 *
 * Shapes follow the shared fixtures: `/Date(ms)/` sale dates, formatted amounts ("1,234.50",
 * negatives in parentheses), ItemType 1 (product) / 4 (service), short staff names on lines. The
 * lines add up to the net amount (no discount lines, no tax), so each line is credited exactly its
 * own amount. A line is one unit at its amount unless it gives `quantity` and `unitPrice` (a charged
 * amount below quantity × unit price is an item-level discount). Customer `n` is Kreloses customer
 * `90000 + n`, "Customer 000n"; `null` is a walk-in.
 *
 * No `import.meta` and no file reads: the Playwright specs import this module too.
 */
export interface SyntheticSale {
  saleId: number;
  branch: "north" | "south";
  /** Customer number (`90000 + n`), or null for a walk-in. */
  customer: number | null;
  /** When the sale was made, as clinic (Asia/Kuala_Lumpur) wall-clock time: `"YYYY-MM-DD HH:mm"`. */
  at: string;
  /** Default `Active`. */
  status?: "Active" | "Cancelled";
  lines: SyntheticLine[];
  /** False: Kreloses has no invoice page for it (the fake answers 404), so its line items are never read. */
  page?: boolean;
}

export interface SyntheticLine {
  name: string;
  /** Short staff name as Kreloses prints it on the line ("Dr Alpha"); null = no staff. */
  staff: string | null;
  /** The charged amount (after any item-level discount); by default quantity 1 at this unit price. */
  amount: Money;
  /** Default 4 (service). */
  itemType?: 1 | 4;
  /** Quantity as Kreloses writes it ("2", "0.5", "(1)" for a return is written from a negative). Default 1. */
  quantity?: number;
  /** Price per unit; required with a `quantity` other than 1. Default: `amount`. */
  unitPrice?: Money;
}

const BRANCHES = {
  north: { id: 1101, name: "Branch North", prefix: "N" },
  south: { id: 1102, name: "Branch South", prefix: "S" },
} as const;

/** Sale List rows and Sale Overview models (by sale id) for `sales`. */
export function syntheticSales(sales: readonly SyntheticSale[]): {
  rows: SaleListRow[];
  overviews: Record<string, SaleOverviewModel>;
} {
  const rows: SaleListRow[] = [];
  const overviews: Record<string, SaleOverviewModel> = {};
  for (const sale of sales) {
    rows.push(saleListRow(sale));
    if (sale.page !== false) overviews[String(sale.saleId)] = saleOverviewModel(sale);
  }
  return { rows, overviews };
}

function saleListRow(sale: SyntheticSale): SaleListRow {
  const branch = BRANCHES[sale.branch];
  const net = formatAmount(netSen(sale));
  return {
    SaleId: sale.saleId,
    SaleName: saleName(sale),
    Location: branch.name,
    LocationId: branch.id,
    CustomerId: sale.customer === null ? null : customerId(sale.customer),
    CustomerName: sale.customer === null ? null : customerName(sale.customer),
    SaleDate: aspNetDate(sale.at),
    SaleStatusName: sale.status ?? "Active",
    GrossAmount: net,
    Discounts: "0.00",
    NetAmount: net,
    TaxAmount: "0.00",
    Total: net,
    PaymentStatusName: "Paid",
    TotalPayments: net,
    TotalRefunds: "0.00",
  };
}

function saleOverviewModel(sale: SyntheticSale): SaleOverviewModel {
  const branch = BRANCHES[sale.branch];
  const net = formatAmount(netSen(sale));
  return {
    Sale: {
      SaleId: sale.saleId,
      SaleName: saleName(sale),
      SaleDate: aspNetDate(sale.at),
      LocationId: branch.id,
      Location: branch.name,
      SaleStatusName: sale.status ?? "Active",
      InvoiceCategory: "Standard",
      Notes: null,
    },
    Customer:
      sale.customer === null
        ? null
        : { CustomerId: customerId(sale.customer), Name: customerName(sale.customer), Phone: `000-000 ${String(sale.customer).padStart(4, "0")}`, Email: null },
    Items: sale.lines.map((line, index) => {
      const { quantity, unitPriceSen, discountSen } = lineUnits(line);
      return {
        SaleItemId: sale.saleId * 10 + index + 1,
        Name: line.name,
        Quantity: quantity < 0 ? `(${-quantity})` : String(quantity),
        UnitPrice: formatAmount(unitPriceSen),
        Amount: formatAmount(moneyToSen(line.amount)),
        StaffName: line.staff ?? "",
        ItemType: line.itemType ?? 4,
        DiscountName: discountSen > 0 ? "Item discount" : null,
        DiscountAmount: formatAmount(discountSen),
      };
    }),
    Totals: {
      GrossAmount: net,
      Discounts: "0.00",
      NetAmount: net,
      TaxAmount: "0.00",
      Total: net,
      TotalPayments: net,
      TotalRefunds: "0.00",
      Balance: "0.00",
    },
    Transactions: [{ TransactionId: sale.saleId * 10, PaymentMethod: "Card", Amount: net, TransactionDate: aspNetDate(sale.at) }],
    RefundInfo: null,
    CreditNoteInfo: null,
  };
}

/** A line's quantity and unit price, and the item-level discount (quantity × unit price − amount, when positive). */
function lineUnits(line: SyntheticLine): { quantity: number; unitPriceSen: number; discountSen: number } {
  const quantity = line.quantity ?? 1;
  if (quantity !== 1 && line.unitPrice === undefined) throw new Error(`Synthetic line "${line.name}": a quantity other than 1 needs a unitPrice`);
  const unitPriceSen = line.unitPrice === undefined ? moneyToSen(line.amount) : moneyToSen(line.unitPrice);
  const grossSen = Math.round(quantity * unitPriceSen);
  return { quantity, unitPriceSen, discountSen: Math.max(0, grossSen - moneyToSen(line.amount)) };
}

function netSen(sale: SyntheticSale): number {
  return sale.lines.reduce((sum, line) => sum + moneyToSen(line.amount), 0);
}

function saleName(sale: SyntheticSale): string {
  return `INV-${BRANCHES[sale.branch].prefix}-${String(sale.saleId).padStart(6, "0")}`;
}

function customerId(customer: number): number {
  return 90000 + customer;
}

function customerName(customer: number): string {
  return `Customer ${String(customer).padStart(4, "0")}`;
}

const AT = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;

/** `"2026-09-27 00:30"` (KL, UTC+8) → ASP.NET's `"/Date(1790440200000)/"` (ms since the epoch, UTC). */
export function aspNetDate(at: string): string {
  const match = AT.exec(at);
  if (!match) throw new Error(`Not a clinic time "YYYY-MM-DD HH:mm": ${at}`);
  const ms = new Date(`${match[1]}T${match[2]}:${match[3]}:00+08:00`).getTime();
  if (Number.isNaN(ms)) throw new Error(`Not a clinic time: ${at}`);
  return `/Date(${ms})/`;
}

/** Integer sen → Kreloses's formatting: `"1,234.50"`, negatives in parentheses `"(120.00)"`. */
function formatAmount(sen: number): string {
  const abs = Math.abs(sen);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${whole}.${String(abs % 100).padStart(2, "0")}`;
  return sen < 0 ? `(${text})` : text;
}
