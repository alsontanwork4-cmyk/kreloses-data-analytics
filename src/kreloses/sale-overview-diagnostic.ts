import { grossSen } from "../attribution/credit";

import { describeJsonShape, isRecord } from "./json";
import { parseAmountSen } from "./money";
import { describeDiagnosticError } from "./sale-list-diagnostic";
import { extractPageModel, ITEM_TYPES, parseQuantity, parseSaleOverview, SALE_ITEM_FIELDS, saleOverviewPath } from "./sale-overview";
import type { KrelosesSession } from "./session";

/**
 * For the opt-in live smoke test: opens a few invoices' Sale Overview pages — the first active
 * sale of the Sale List page read, the first with a discount, the first with a refund or a
 * negative net — and describes their structure in AGGREGATE: the model's keys and types, the line
 * items' field names, how many lines have each ItemType, how numbers are written, and counts of
 * pages/lines where the Reader's assumptions hold (including the gap monitor: pages whose lines do
 * not add up). Never a name (item, staff, customer), an amount, a quantity, an invoice number or
 * an id — sale ids are replaced by `<sale>` even inside error messages: the owner pastes the
 * report into a PUBLIC issue.
 */
export interface SaleOverviewDiagnostic {
  /** Each page opened, in order: what it was chosen as, and the error if it could not be fetched. */
  pages: { label: string; error?: string }[];
  /** Over the pages that could be fetched; null when none could (or none was chosen: see `note`). */
  structure: SaleOverviewStructure | null;
  note?: string;
}

export interface SaleOverviewStructure {
  fetched: number;
  modelsFound: number;
  firstModelShape: string;
  sameTopLevelKeys: boolean;
  lines: number;
  presentFields: string[];
  missingFields: string[];
  otherFields: string[];
  itemTypes: string;
  numbers: string;
  linesWithStaff: number;
  itemDiscounts: number;
  soldLines: number;
  soldLinesAfterDiscount: number;
  discountLineSigns: string;
  /** Pages whose Σ line Amounts = Totals.NetAmount, of the pages with a model. */
  addUpToTotals: number;
  /** Pages whose Σ line Amounts = the Sale List's NetAmount (what the sync's gap monitor checks). */
  addUpToSaleList: number;
  totalsMatchSaleList: number;
  saleIdMatches: number;
  refundInfo: { pages: number; shape: string | null };
  creditNoteInfo: { pages: number; shape: string | null };
  parsed: number;
  /** Parse failures, per page label (ids redacted). */
  parseFailures: { label: string; error: string }[];
}

/** A sale to open (from the Sale List page the diagnostic read). NEVER printed. */
export interface SaleSample {
  saleId: string;
  /** The Sale List's NetAmount, for the "equals the Sale List" checks. */
  netSen: number;
  /** Why it was chosen, e.g. "first active sale". Printed. */
  label: string;
}

export async function probeSaleOverviews(session: KrelosesSession, samples: readonly SaleSample[]): Promise<SaleOverviewDiagnostic> {
  if (samples.length === 0) return { pages: [], structure: null, note: "no active sale on the Sale List page to open" };
  const pages: SaleOverviewDiagnostic["pages"] = [];
  const fetched: { sample: SaleSample; html: string }[] = [];
  for (const sample of samples) {
    try {
      fetched.push({ sample, html: await session.getHtml(saleOverviewPath(sample.saleId)) });
      pages.push({ label: sample.label });
    } catch (error) {
      pages.push({ label: sample.label, error: redactSaleId(describeDiagnosticError(error), sample.saleId) });
    }
  }
  return { pages, structure: fetched.length > 0 ? describeOverviews(fetched) : null };
}

export function formatSaleOverviewDiagnostic(diagnostic: SaleOverviewDiagnostic): string[] {
  if (diagnostic.pages.length === 0) return [`Sale Overview pages: not checked (${diagnostic.note ?? "no sale"})`];
  const lines = [
    "Sale Overview pages (GET /Sale/Overview/<sale>, structure only):",
    `  Pages opened: ${diagnostic.pages.length} (${diagnostic.pages.map((page) => page.label).join(", ")})`,
  ];
  for (const page of diagnostic.pages) if (page.error) lines.push(`  Page "${page.label}": FAILED — ${page.error}`);
  const s = diagnostic.structure;
  if (!s) return lines;
  const of = (count: number, total: number, noun: string) => `${count} of ${total} ${noun}${total === 1 ? "" : "s"}`;
  const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "none");
  const withModel = s.modelsFound;
  lines.push(
    `  var model found: ${of(s.modelsFound, s.fetched, "page")}`,
    `  Model shape (first page): ${s.firstModelShape}`,
    `  Same top-level model keys on every page: ${s.sameTopLevelKeys ? "yes" : "no"}`,
    `  Line items: ${s.lines} on ${withModel} ${withModel === 1 ? "page" : "pages"}`,
    `  Expected item fields present: ${list(s.presentFields)}`,
    `  Expected item fields missing: ${list(s.missingFields)}`,
    `  Other item fields: ${list(s.otherFields)}`,
    `  ItemType values (count of lines): ${s.itemTypes}`,
    `  Numbers: ${s.numbers}`,
    `  StaffName: on ${s.linesWithStaff} of ${s.lines} lines (names not shown)`,
    `  Item-level discounts (DiscountAmount not zero): ${s.itemDiscounts} of ${s.lines} lines`,
    `  Sold lines with Amount = Quantity × UnitPrice − DiscountAmount: ${s.soldLinesAfterDiscount} of ${s.soldLines}`,
    `  Discount lines (ItemType 55) Amount sign: ${s.discountLineSigns}`,
    `  Pages whose line Amounts add up to Totals.NetAmount: ${s.addUpToTotals} of ${withModel}`,
    `  Pages whose line Amounts add up to the Sale List's NetAmount: ${s.addUpToSaleList} of ${withModel}`,
    `  Pages whose Totals.NetAmount equals the Sale List's NetAmount: ${s.totalsMatchSaleList} of ${withModel}`,
    `  Pages whose Sale.SaleId is the sale asked for: ${s.saleIdMatches} of ${withModel}`,
    `  RefundInfo: on ${s.refundInfo.pages} of ${withModel} pages${s.refundInfo.shape ? `; shape ${s.refundInfo.shape}` : ""}`,
    `  CreditNoteInfo: on ${s.creditNoteInfo.pages} of ${withModel} pages${s.creditNoteInfo.shape ? `; shape ${s.creditNoteInfo.shape}` : ""}`,
    `  Reader parse: OK on ${of(s.parsed, s.fetched, "page")}${s.parseFailures.map((failure) => `; page "${failure.label}": FAILED — ${failure.error}`).join("")}`,
  );
  return lines;
}

const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;

/** `text` with every occurrence of the sale id (as a whole token) replaced by `<sale>`. */
function redactSaleId(text: string, saleId: string): string {
  const escaped = saleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "<sale>");
}

function describeOverviews(pages: { sample: SaleSample; html: string }[]): SaleOverviewStructure {
  const models: { sample: SaleSample; model: Record<string, unknown> }[] = [];
  const parseFailures: SaleOverviewStructure["parseFailures"] = [];
  let parsed = 0;
  for (const { sample, html } of pages) {
    try {
      models.push({ sample, model: extractPageModel(html) });
    } catch {
      // Counted below (not found); the parse attempt reports why.
    }
    try {
      parseSaleOverview(html, sample.saleId);
      parsed += 1;
    } catch (error) {
      parseFailures.push({ label: sample.label, error: redactSaleId(describeDiagnosticError(error), sample.saleId) });
    }
  }

  const items = models.flatMap(({ model }) => (Array.isArray(model.Items) ? model.Items : []).filter(isRecord));
  const inEveryItem = (key: string) => items.length > 0 && items.every((item) => Object.hasOwn(item, key));
  const expected = new Set<string>(SALE_ITEM_FIELDS);
  const otherKeys = [...new Set(items.flatMap((item) => Object.keys(item)))].filter((key) => !expected.has(key) && inEveryItem(key));
  const unprintable = otherKeys.filter((key) => !SCHEMA_KEY.test(key)).length;

  const typeCounts = new Map<string, number>();
  for (const item of items) {
    const type = itemType(item);
    const label = type === null ? "<not a number>" : type >= 0 && type < 1000 ? String(type) : "<out of range>";
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
  }
  const discountLines = items.filter((item) => itemType(item) === ITEM_TYPES.discount);
  const soldLines = items.filter((item) => itemType(item) !== ITEM_TYPES.discount);
  const signs = { negative: 0, positive: 0, zero: 0, unreadable: 0 };
  for (const item of discountLines) {
    const amount = parseAmountSen(item.Amount);
    if (typeof amount !== "number") signs.unreadable += 1;
    else if (amount < 0) signs.negative += 1;
    else if (amount > 0) signs.positive += 1;
    else signs.zero += 1;
  }

  const perPage = models.map(({ sample, model }) => {
    const pageItems = (Array.isArray(model.Items) ? model.Items : []).filter(isRecord);
    const lineSum = pageItems.reduce<number | null>((total, item) => {
      const amount = parseAmountSen(item.Amount);
      if (total === null || amount === undefined) return null;
      return total + (amount ?? 0);
    }, 0);
    const totals = isRecord(model.Totals) ? model.Totals : null;
    const net = totals ? parseAmountSen(totals.NetAmount) : undefined;
    const sale = isRecord(model.Sale) ? model.Sale : null;
    const saleId = sale && (typeof sale.SaleId === "number" || typeof sale.SaleId === "string") ? String(sale.SaleId).trim() : null;
    return {
      addUpToTotals: typeof net === "number" && lineSum === net,
      addUpToSaleList: lineSum === sample.netSen,
      totalsMatchSaleList: typeof net === "number" && net === sample.netSen,
      saleIdMatches: saleId === sample.saleId,
    };
  });
  const count = (test: (page: (typeof perPage)[number]) => boolean) => perPage.filter(test).length;
  const part = (name: string) => {
    const present = models.map(({ model }) => model[name]).filter((value) => value !== null && value !== undefined);
    return { pages: present.length, shape: present.length > 0 ? describeJsonShape(present[0]) : null };
  };
  const keySets = models.map(({ model }) => Object.keys(model).sort().join(","));

  return {
    fetched: pages.length,
    modelsFound: models.length,
    firstModelShape: models[0] ? describeJsonShape(models[0].model) : "none",
    sameTopLevelKeys: keySets.every((keys) => keys === keySets[0]),
    lines: items.length,
    presentFields: SALE_ITEM_FIELDS.filter(inEveryItem),
    missingFields: SALE_ITEM_FIELDS.filter((field) => !inEveryItem(field)),
    otherFields: [...otherKeys.filter((key) => SCHEMA_KEY.test(key)).sort(), ...(unprintable > 0 ? [`<${unprintable} unprintable>`] : [])],
    itemTypes: [...typeCounts.entries()].map(([type, lines]) => `${type} × ${lines}`).join(", ") || "none",
    numbers: describeNumbers(items),
    linesWithStaff: items.filter((item) => typeof item.StaffName === "string" && item.StaffName.trim() !== "").length,
    itemDiscounts: items.filter((item) => {
      const amount = parseAmountSen(item.DiscountAmount);
      return typeof amount === "number" && amount !== 0;
    }).length,
    soldLines: soldLines.length,
    soldLinesAfterDiscount: soldLines.filter(chargedAfterItemDiscount).length,
    discountLineSigns:
      discountLines.length === 0
        ? "no discount lines"
        : `negative ${signs.negative}, positive ${signs.positive}, zero ${signs.zero}, unreadable ${signs.unreadable}`,
    addUpToTotals: count((page) => page.addUpToTotals),
    addUpToSaleList: count((page) => page.addUpToSaleList),
    totalsMatchSaleList: count((page) => page.totalsMatchSaleList),
    saleIdMatches: count((page) => page.saleIdMatches),
    refundInfo: part("RefundInfo"),
    creditNoteInfo: part("CreditNoteInfo"),
    parsed,
    parseFailures,
  };
}

function itemType(item: Record<string, unknown>): number | null {
  const value = item.ItemType;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*\d{1,4}\s*$/.test(value)) return Number(value);
  return null;
}

/** Amount = Quantity × UnitPrice − DiscountAmount (the Reader assumes Amount is after the item discount). */
function chargedAfterItemDiscount(item: Record<string, unknown>): boolean {
  const quantity = parseQuantity(item.Quantity);
  const price = parseAmountSen(item.UnitPrice);
  const amount = parseAmountSen(item.Amount);
  const discount = parseAmountSen(item.DiscountAmount) ?? 0;
  if (typeof quantity !== "string" || typeof price !== "number" || typeof amount !== "number" || typeof discount !== "number") return false;
  try {
    return grossSen(quantity, price) - discount === amount;
  } catch {
    return false;
  }
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
