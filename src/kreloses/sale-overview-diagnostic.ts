import { grossSen } from "../attribution/credit";

import { describeJsonShape, isRecord } from "./json";
import { parseAmountSen } from "./money";
import { describeDiagnosticError } from "./sale-list-diagnostic";
import { extractPageModel, ITEM_TYPES, parseQuantity, parseSaleOverview, SALE_ITEM_FIELDS, saleOverviewPath } from "./sale-overview";
import type { KrelosesSession } from "./session";

/**
 * For the opt-in live smoke test: opens ONE invoice's Sale Overview page and describes its
 * structure — the page model's keys and types, the line items' field names, which ItemType values
 * occur, how numbers are written, and whether the Reader's assumptions hold (as yes/no and counts)
 * — so the line-item parser (#5) can be checked against the real thing. It never includes a name
 * (item, staff, customer), an amount, a quantity, an invoice number or an id: the owner pastes the
 * report into a PUBLIC issue.
 */
export interface SaleOverviewDiagnostic {
  /** Null when there was no sale to open (see `note`) or the page could not be fetched (`error`). */
  page: SaleOverviewStructure | null;
  note?: string;
  error?: string;
}

export interface SaleOverviewStructure {
  modelFound: string;
  modelShape: string;
  lines: number;
  presentFields: string[];
  missingFields: string[];
  otherFields: string[];
  itemTypes: string;
  numbers: string;
  staffNames: string;
  itemDiscounts: string;
  /** Sold lines whose Amount = Quantity × UnitPrice − DiscountAmount (the Reader assumes Amount is after the item discount). */
  amountAfterItemDiscount: string;
  discountLineAmounts: string;
  linesAddUpToNet: string;
  netMatchesSaleList: string;
  saleIdMatches: string;
  parse: string;
}

/** The sale to open, taken from the Sale List page the diagnostic read (never printed). */
export interface SaleSample {
  saleId: string;
  /** The Sale List's NetAmount, for the "Totals.NetAmount equals the Sale List" check. */
  netSen: number;
}

export async function probeSaleOverview(session: KrelosesSession, sample: SaleSample | null): Promise<SaleOverviewDiagnostic> {
  if (!sample) return { page: null, note: "no active sale on the Sale List page to open" };
  let html: string;
  try {
    html = await session.getHtml(saleOverviewPath(sample.saleId));
  } catch (error) {
    return { page: null, error: describeDiagnosticError(error) };
  }
  return { page: describeOverview(html, sample) };
}

export function formatSaleOverviewDiagnostic(diagnostic: SaleOverviewDiagnostic): string[] {
  const { page } = diagnostic;
  if (!page) {
    return [diagnostic.error ? `Sale Overview: FAILED — ${diagnostic.error}` : `Sale Overview: not checked (${diagnostic.note ?? "no sale"})`];
  }
  const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "none");
  return [
    "Sale Overview (GET /Sale/Overview/<sale>, the first active sale of the page above):",
    `  var model found: ${page.modelFound}`,
    `  Model shape: ${page.modelShape}`,
    `  Line items: ${page.lines}`,
    `  Expected item fields present: ${list(page.presentFields)}`,
    `  Expected item fields missing: ${list(page.missingFields)}`,
    `  Other item fields: ${list(page.otherFields)}`,
    `  ItemType values (count of lines): ${page.itemTypes}`,
    `  Numbers: ${page.numbers}`,
    `  StaffName: ${page.staffNames}`,
    `  Item-level discounts (DiscountAmount not zero): ${page.itemDiscounts}`,
    `  Sold lines with Amount = Quantity × UnitPrice − DiscountAmount: ${page.amountAfterItemDiscount}`,
    `  Discount lines (ItemType 55) Amount sign: ${page.discountLineAmounts}`,
    `  All line Amounts add up to Totals.NetAmount: ${page.linesAddUpToNet}`,
    `  Totals.NetAmount equals the Sale List's NetAmount: ${page.netMatchesSaleList}`,
    `  Sale.SaleId is the sale asked for: ${page.saleIdMatches}`,
    `  Reader parse: ${page.parse}`,
  ];
}

const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;

function describeOverview(html: string, sample: SaleSample): SaleOverviewStructure {
  let model: Record<string, unknown> | null = null;
  let modelFound: string;
  try {
    model = extractPageModel(html);
    modelFound = "yes";
  } catch (error) {
    modelFound = `no (${describeDiagnosticError(error)})`;
  }
  let parse: string;
  try {
    parse = model ? `OK (${parseSaleOverview(html, sample.saleId).lines.length} lines)` : "not attempted (no model)";
  } catch (error) {
    parse = `FAILED — ${describeDiagnosticError(error)}`;
  }

  const items = (model && Array.isArray(model.Items) ? model.Items : []).filter(isRecord);
  const inEveryItem = (key: string) => items.length > 0 && items.every((item) => Object.hasOwn(item, key));
  const expected = new Set<string>(SALE_ITEM_FIELDS);
  const otherKeys = [...new Set(items.flatMap((item) => Object.keys(item)))].filter((key) => !expected.has(key) && inEveryItem(key));
  const unprintable = otherKeys.filter((key) => !SCHEMA_KEY.test(key)).length;

  const typeOf = (item: Record<string, unknown>): number | null => {
    const value = item.ItemType;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\s*\d{1,4}\s*$/.test(value)) return Number(value);
    return null;
  };
  const typeCounts = new Map<string, number>();
  for (const item of items) {
    const type = typeOf(item);
    const label = type === null ? "<not a number>" : type >= 0 && type < 1000 ? String(type) : "<out of range>";
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
  }
  const discountLines = items.filter((item) => typeOf(item) === ITEM_TYPES.discount);
  const soldLines = items.filter((item) => typeOf(item) !== ITEM_TYPES.discount);
  const sen = (value: unknown) => parseAmountSen(value);

  const withStaff = items.filter((item) => typeof item.StaffName === "string" && item.StaffName.trim() !== "").length;
  const itemDiscounts = items.filter((item) => {
    const amount = sen(item.DiscountAmount);
    return typeof amount === "number" && amount !== 0;
  }).length;
  const afterDiscount = soldLines.filter((item) => {
    const quantity = parseQuantity(item.Quantity);
    const price = sen(item.UnitPrice);
    const amount = sen(item.Amount);
    const discount = sen(item.DiscountAmount) ?? 0;
    if (typeof quantity !== "string" || typeof price !== "number" || typeof amount !== "number" || typeof discount !== "number") return false;
    try {
      return grossSen(quantity, price) - discount === amount;
    } catch {
      return false;
    }
  }).length;
  const signs = { negative: 0, positive: 0, zero: 0, unreadable: 0 };
  for (const item of discountLines) {
    const amount = sen(item.Amount);
    if (typeof amount !== "number") signs.unreadable += 1;
    else if (amount < 0) signs.negative += 1;
    else if (amount > 0) signs.positive += 1;
    else signs.zero += 1;
  }
  const totals = model && isRecord(model.Totals) ? model.Totals : null;
  const net = totals ? sen(totals.NetAmount) : undefined;
  const lineSum = items.reduce<number | null>((total, item) => {
    const amount = sen(item.Amount);
    return total === null || typeof amount !== "number" ? (amount === null ? total : null) : total + amount;
  }, 0);
  const sale = model && isRecord(model.Sale) ? model.Sale : null;
  const saleId = sale && (typeof sale.SaleId === "number" || typeof sale.SaleId === "string") ? String(sale.SaleId).trim() : null;

  return {
    modelFound,
    modelShape: model ? describeJsonShape(model) : "none",
    lines: items.length,
    presentFields: SALE_ITEM_FIELDS.filter(inEveryItem),
    missingFields: SALE_ITEM_FIELDS.filter((field) => !inEveryItem(field)),
    otherFields: [...otherKeys.filter((key) => SCHEMA_KEY.test(key)).sort(), ...(unprintable > 0 ? [`<${unprintable} unprintable>`] : [])],
    itemTypes: [...typeCounts.entries()].map(([type, count]) => `${type} × ${count}`).join(", ") || "none",
    numbers: describeNumbers(items),
    staffNames: `on ${withStaff} of ${items.length} lines (names not shown)`,
    itemDiscounts: `${itemDiscounts} of ${items.length} lines`,
    amountAfterItemDiscount: `${afterDiscount} of ${soldLines.length}`,
    discountLineAmounts:
      discountLines.length === 0
        ? "no discount lines"
        : `negative ${signs.negative}, positive ${signs.positive}, zero ${signs.zero}, unreadable ${signs.unreadable}`,
    linesAddUpToNet: typeof net !== "number" || lineSum === null ? "unknown (a total or amount is missing or unreadable)" : lineSum === net ? "yes" : "no",
    netMatchesSaleList: typeof net !== "number" ? "unknown (no readable Totals.NetAmount)" : net === sample.netSen ? "yes" : "no",
    saleIdMatches: saleId === null ? "no Sale.SaleId" : saleId === sample.saleId ? "yes" : "NO",
    parse,
  };
}

function describeNumbers(items: Record<string, unknown>[]): string {
  const values = items.flatMap((item) => [item.Quantity, item.UnitPrice, item.Amount, item.DiscountAmount]);
  const kinds = new Set(values.map((value) => (value === null || value === "" ? "empty" : typeof value === "string" ? "strings" : typeof value === "number" ? "numbers" : "other")));
  const strings = values.filter((value): value is string => typeof value === "string");
  const yesNo = (test: (value: string) => boolean) => (strings.some(test) ? "yes" : "no");
  const quantities = items.map((item) => parseQuantity(item.Quantity)).filter((value): value is string => typeof value === "string");
  const order = ["strings", "numbers", "empty", "other"] as const;
  return [
    order.filter((kind) => kinds.has(kind)).join(", ") || "none",
    `thousand separators: ${yesNo((value) => /\d,\d{3}/.test(value))}`,
    `negatives in parentheses: ${yesNo((value) => /\(.*\d.*\)/.test(value))}`,
    `minus signs: ${yesNo((value) => /-\s*(RM\s*)?\d/i.test(value))}`,
    `currency prefix: ${yesNo((value) => /RM|MYR/i.test(value))}`,
    `fractional quantities: ${quantities.some((value) => value.includes(".")) ? "yes" : "no"}`,
  ].join("; ");
}
