import { LayoutChanged } from "./errors";
import { describeJsonShape, isRecord } from "./json";
import { parseAmountSen } from "./money";
import type { KrelosesSession } from "./session";

/**
 * An invoice's line items: `GET /Sale/Overview/{SaleId}` is an HTML page that embeds the sale as
 * `var model = {…};` (spec, "Data source → Line items"). The Reader finds that assignment, reads
 * the object literal up to its matching closing brace (skipping braces inside strings), parses it
 * as JSON and checks the parts it relies on:
 *
 * - `model.Items[]`, every entry with `Name`, `Quantity`, `UnitPrice`, `Amount`, `StaffName`,
 *   `ItemType` (1 = product, 4 = service, 55 = discount line), `DiscountName`, `DiscountAmount`;
 * - `model.Sale.SaleId`, when present, must be the sale asked for;
 * - `model.Totals` amounts, when present, must be readable.
 *
 * Numbers are formatted strings (thousand separators, negatives in parentheses; JSON numbers are
 * accepted too): money becomes integer sen, quantities exact decimal strings (up to 4 places;
 * never a float). Anything else raises `LayoutChanged` naming the line and field, never a value.
 *
 * UNVERIFIED (no real page recorded yet; the live smoke test prints the real page's structure):
 * the exact key names inside `Sale` / `Totals`, whether `Amount` is after the item-level discount
 * (assumed yes: it is what the line charged), the sign of a discount line's amounts, and how
 * refunds show in `RefundInfo` / `CreditNoteInfo` (kept raw for #6).
 */

/** Kreloses's ItemType values the app knows (others are kept as sent and credited like products). */
export const ITEM_TYPES = { product: 1, service: 4, discount: 55 } as const;

/** Every field an Items[] entry must have (a missing one means the layout changed). */
export const SALE_ITEM_FIELDS = ["Name", "Quantity", "UnitPrice", "Amount", "StaffName", "ItemType", "DiscountName", "DiscountAmount"] as const;

/** Parts of the page model kept (raw) besides the lines. `Customer` is personal data and is never kept. */
export const KEPT_MODEL_PARTS = ["Sale", "Totals", "Transactions", "RefundInfo", "CreditNoteInfo"] as const;

/** One line (model.Items[] entry). Money in integer sen with Kreloses's sign. */
export interface KrelosesInvoiceLine {
  /** 1-based position in Items[]. */
  lineNo: number;
  /** The item's name ("" if Kreloses sent none). */
  name: string;
  itemType: number;
  /** Exact decimal ("2", "0.5", "-1"). Null only on a discount line (ItemType 55). */
  quantity: string | null;
  unitPriceSen: number | null;
  /** What the line charged (after any item-level discount). Null only on a discount line. */
  amountSen: number | null;
  /** The staff name on the line, a short form such as "Dr Alpha"; null when empty. */
  staffName: string | null;
  discountName: string | null;
  /** The line's item-level discount (0 when none). */
  discountAmountSen: number;
}

/** The invoice totals the page shows (null where the page has no such total). */
export interface KrelosesInvoiceHeader {
  saleId: string;
  grossSen: number | null;
  discountsSen: number | null;
  netSen: number | null;
  taxSen: number | null;
  totalSen: number | null;
  totalPaymentsSen: number | null;
  totalRefundsSen: number | null;
}

export interface KrelosesInvoiceDetail {
  header: KrelosesInvoiceHeader;
  lines: KrelosesInvoiceLine[];
  /** The page model's `Sale`, `Totals`, `Transactions`, `RefundInfo`, `CreditNoteInfo` as sent (null when absent). */
  raw: Record<(typeof KEPT_MODEL_PARTS)[number], unknown>;
}

const SALE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function saleOverviewPath(saleId: string): string {
  return `/Sale/Overview/${saleId}`;
}

/**
 * One invoice's lines and totals. Raises `LayoutChanged` for a page it does not fully understand
 * (or a missing page), `AuthFailed("session_expired")` when the session has expired, and
 * `RateLimited` / `Transient` for Kreloses's own trouble. `RangeError` for a malformed sale id.
 */
export async function getInvoice(session: KrelosesSession, saleId: string): Promise<KrelosesInvoiceDetail> {
  if (!SALE_ID.test(saleId)) throw new RangeError("not a Kreloses sale id");
  const html = await session.getHtml(saleOverviewPath(saleId));
  return parseSaleOverview(html, saleId);
}

/** Parses a Sale Overview page (exported for the live diagnostic). */
export function parseSaleOverview(html: string, saleId: string): KrelosesInvoiceDetail {
  return parseSaleOverviewModel(extractPageModel(html), saleId);
}

const MODEL_ASSIGNMENT = /\b(?:var|let|const)\s+model\s*=\s*/g;

/**
 * The value of the page's `var model = {…};` as parsed JSON. Raises `LayoutChanged` when there is
 * no such assignment of an object, when the object never closes, or when it is not JSON.
 */
export function extractPageModel(html: string): Record<string, unknown> {
  // HTML comments are not code (a comment may well mention `var model = {…}`).
  const page = html.replace(/<!--[\s\S]*?-->/g, " ");
  let problem: string | null = null;
  for (const match of page.matchAll(MODEL_ASSIGNMENT)) {
    const start = match.index + match[0].length;
    if (page[start] !== "{") continue;
    const end = matchingBrace(page, start);
    if (end === null) {
      problem ??= "the page model never ends (no matching closing brace)";
      continue;
    }
    try {
      // An object literal that parses as JSON is always an object.
      return JSON.parse(page.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      problem ??= "the page model is not JSON";
    }
  }
  throw new LayoutChanged(`Sale/Overview: ${problem ?? "no `var model = {…}` in the page"}`);
}

/** Index of the brace closing the one at `start`, skipping string literals ("…", '…', `…`) and escapes. */
function matchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return char === "}" ? index : null;
    }
  }
  return null;
}

function parseSaleOverviewModel(model: Record<string, unknown>, saleId: string): KrelosesInvoiceDetail {
  const fail = (message: string): never => {
    throw new LayoutChanged(`Sale/Overview: ${message}`, { shape: describeJsonShape(model) });
  };
  const items = model.Items;
  if (!Array.isArray(items)) return fail("no Items list in the page model");

  const sale = isRecord(model.Sale) ? model.Sale : null;
  if (sale && Object.hasOwn(sale, "SaleId") && identifier(sale.SaleId) !== saleId) fail("the page is for another sale");

  const totals = isRecord(model.Totals) ? model.Totals : null;
  const total = (field: string): number | null => {
    if (!totals || !Object.hasOwn(totals, field)) return null;
    const sen = parseAmountSen(totals[field]);
    return sen === undefined ? fail(`Totals.${field} is not an amount in a format Kreloses is known to send`) : sen;
  };

  return {
    header: {
      saleId,
      grossSen: total("GrossAmount"),
      discountsSen: total("Discounts"),
      netSen: total("NetAmount"),
      taxSen: total("TaxAmount"),
      totalSen: total("Total"),
      totalPaymentsSen: total("TotalPayments"),
      totalRefundsSen: total("TotalRefunds"),
    },
    lines: items.map((item, index) => parseItem(item, index + 1, fail)),
    raw: Object.fromEntries(KEPT_MODEL_PARTS.map((part) => [part, model[part] ?? null])) as KrelosesInvoiceDetail["raw"],
  };
}

function parseItem(item: unknown, lineNo: number, fail: (message: string) => never): KrelosesInvoiceLine {
  const where = `Items[${lineNo}]`;
  if (!isRecord(item)) return fail(`${where} is not an object`);
  for (const field of SALE_ITEM_FIELDS) if (!Object.hasOwn(item, field)) fail(`${where}: no ${field}`);

  const itemType = wholeNumber(item.ItemType) ?? fail(`${where}: ItemType is not a whole number`);
  const discount = itemType === ITEM_TYPES.discount;
  const amount = (field: "UnitPrice" | "Amount" | "DiscountAmount"): number | null => {
    const sen = parseAmountSen(item[field]);
    if (sen === undefined) return fail(`${where}: ${field} is not an amount in a format Kreloses is known to send`);
    return sen;
  };
  const quantity = parseQuantity(item.Quantity);
  if (quantity === undefined) fail(`${where}: Quantity is not a quantity in a format Kreloses is known to send`);
  const unitPriceSen = amount("UnitPrice");
  const amountSen = amount("Amount");
  if (!discount) {
    if (quantity === null) fail(`${where}: no Quantity on a line that is not a discount`);
    if (unitPriceSen === null) fail(`${where}: no UnitPrice on a line that is not a discount`);
    if (amountSen === null) fail(`${where}: no Amount on a line that is not a discount`);
  }
  return {
    lineNo,
    name: optionalText(item.Name, () => fail(`${where}: Name is not text`)) ?? "",
    itemType,
    quantity: quantity ?? null,
    unitPriceSen,
    amountSen,
    staffName: optionalText(item.StaffName, () => fail(`${where}: StaffName is not text`)),
    discountName: optionalText(item.DiscountName, () => fail(`${where}: DiscountName is not text`)),
    discountAmountSen: amount("DiscountAmount") ?? 0,
  };
}

const QUANTITY = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,4}))?$/;
/** numeric(12,4): up to 8 whole digits. */
const MAX_QUANTITY_WHOLE_DIGITS = 8;

/**
 * An exact decimal quantity ("2", "0.5", "-1") from Kreloses's formats: JSON numbers, thousand
 * separators, negatives in parentheses or with a minus sign, up to 4 decimal places. Null for an
 * empty value (`null`, `""`, `"-"`), undefined for anything else.
 */
export function parseQuantity(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? parseQuantity(String(value)) : undefined;
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (/^[-–—]?$/.test(text)) return null;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
    negative = true;
  } else if (text.startsWith("-")) {
    text = text.slice(1).trim();
    negative = true;
  }
  if (!QUANTITY.test(text)) return undefined;
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".") as [string, string?];
  const wholeDigits = whole.replace(/^0+(?=\d)/, "");
  if (wholeDigits.length > MAX_QUANTITY_WHOLE_DIGITS) return undefined;
  const trimmedFraction = fraction.replace(/0+$/, "");
  const normalised = trimmedFraction ? `${wholeDigits}.${trimmedFraction}` : wholeDigits;
  return negative && normalised !== "0" ? `-${normalised}` : normalised;
}

/** An integer from a JSON number or a digit string. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\s*-?\d{1,9}\s*$/.test(value)) return Number(value.trim());
  return null;
}

/** Trimmed text with inner whitespace collapsed; null for null/empty; `invalid()` for a non-string. */
function optionalText(value: unknown, invalid: () => never): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return invalid();
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

/** A non-empty string or a finite number, as a trimmed string; otherwise null. */
function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}
