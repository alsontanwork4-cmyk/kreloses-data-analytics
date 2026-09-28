/**
 * Attribution & Rules — how an invoice's revenue is credited to the staff named on its lines.
 * PURE: no database, no I/O, integer sen only (never floating point), deterministic.
 *
 * The rules (spec, "Modules → Attribution & Rules"; the earlier hand-built dashboard):
 *
 * 1. Each non-discount line is credited to the staff name on it, or to nobody ("No staff on line")
 *    when the name is empty. Who that name belongs to (staff member, kind) is NOT decided here: the
 *    Analytics Service resolves the name through `staff_aliases` at query time, so remapping a name
 *    never changes these amounts (docs/adr/0005).
 * 2. A line starts from its own charged amount (`Amount`, which already has any item-level discount
 *    taken off). Everything between those amounts and the invoice's revenue base — the invoice's
 *    discount lines (ItemType 55) and any other gap (rounding, adjustments, tax shown on lines) —
 *    is spread across the non-discount lines in proportion to their GROSS amounts (quantity × unit
 *    price), with a largest-remainder allocation in whole sen, ties to the lower line number.
 * 3. So the credited lines of an invoice add up EXACTLY to its revenue base, to the sen.
 *
 * Edge cases (each unit-tested in credit.test.ts):
 * - Weights are |gross| (so a return line on a mixed invoice never flips a spread's sign). If every
 *   line's gross is zero, the lines' |amounts| are used; if those are all zero too, equal shares.
 * - No non-discount line at all (only discount lines, or no lines): ONE "unitemised remainder"
 *   (`lineNo: null`, no staff) carries the whole base — even a zero base, so every invoice keeps
 *   at least one credited line and still counts as an invoice.
 * - A cancelled invoice has a base of zero, so its lines are credited zero.
 */

/** Kreloses's ItemType of a discount line. Other types (1 product, 4 service, …) are credited. */
export const DISCOUNT_ITEM_TYPE = 55;

/** The invoice header fields attribution needs (money in integer sen). */
export interface AttributionInvoice {
  status: "active" | "cancelled";
  /** Kreloses's NetAmount (after discounts, before tax). */
  netSen: number;
  /** Kreloses's TotalRefunds (recorded; see `invoiceRevenueBaseSen`). */
  totalRefundsSen: number;
}

/** One line of the invoice (Kreloses's model.Items[] entry, already parsed). */
export interface AttributionLine {
  /** 1-based position on the invoice; unique per invoice. */
  lineNo: number;
  itemType: number;
  /** Exact decimal ("2", "0.5", "-1"); null only on a discount line. */
  quantity: string | null;
  unitPriceSen: number | null;
  /** The line's charged amount; null only on a discount line. */
  amountSen: number | null;
  /** The staff name on the line as Kreloses shows it (e.g. "Dr Alpha"); null/blank = no staff. */
  staffName: string | null;
}

/** What one non-discount line (or the unitemised remainder) is credited with. */
export interface CreditedLine {
  /** The line credited; null for the unitemised remainder. */
  lineNo: number | null;
  /** The line's staff name, trimmed with inner spaces collapsed; null = "No staff on line". */
  staffName: string | null;
  /** quantity × unit price, rounded half away from zero to the sen (0 for the remainder). */
  grossSen: number;
  /** The line's own charged amount (0 for the remainder). */
  lineAmountSen: number;
  /** Its share of the invoice's discount lines and gap (negative = discount). */
  spreadSen: number;
  /** lineAmountSen + spreadSen. */
  creditedSen: number;
}

/**
 * What an invoice's credited lines must add up to — THE one definition, so refund handling can be
 * refined in one place (#6): the net amount of an active invoice; zero for a cancelled one.
 *
 * Refunds (`totalRefundsSen`) are recorded but NOT subtracted: how Kreloses represents a refund
 * (the Sale List's TotalRefunds vs the Sale Overview's RefundInfo / CreditNoteInfo, and whether a
 * refund also appears as a separate negative "return" sale) is not verified against live data yet.
 * A negative (return) invoice already reduces revenue through its own negative net amount.
 */
export function invoiceRevenueBaseSen(invoice: AttributionInvoice): number {
  return invoice.status === "active" ? invoice.netSen : 0;
}

/**
 * The credited lines of one invoice: one per non-discount line (in line order), or the single
 * unitemised remainder when there is none. Their `creditedSen` add up to
 * `invoiceRevenueBaseSen(invoice)` exactly. Throws `RangeError` for input that cannot be credited
 * (a non-discount line without quantity/price/amount, duplicate line numbers): the Reader never
 * produces it, so it is a bug, not data to guess about.
 */
export function creditInvoice(invoice: AttributionInvoice, lines: readonly AttributionLine[]): CreditedLine[] {
  const baseSen = invoiceRevenueBaseSen(invoice);
  assertSen(baseSen, "revenue base");
  const seen = new Set<number>();
  for (const line of lines) {
    if (!Number.isInteger(line.lineNo) || line.lineNo < 1) throw new RangeError(`bad line number ${line.lineNo}`);
    if (seen.has(line.lineNo)) throw new RangeError(`line ${line.lineNo} appears twice`);
    seen.add(line.lineNo);
  }

  const credited = [...lines]
    .filter((line) => line.itemType !== DISCOUNT_ITEM_TYPE)
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => {
      if (line.quantity === null || line.unitPriceSen === null || line.amountSen === null) {
        throw new RangeError(`line ${line.lineNo} has no quantity, unit price or amount`);
      }
      assertSen(line.unitPriceSen, `line ${line.lineNo} unit price`);
      assertSen(line.amountSen, `line ${line.lineNo} amount`);
      return { lineNo: line.lineNo, staffName: cleanStaffName(line.staffName), grossSen: grossSen(line.quantity, line.unitPriceSen), lineAmountSen: line.amountSen };
    });

  if (credited.length === 0) {
    return [{ lineNo: null, staffName: null, grossSen: 0, lineAmountSen: 0, spreadSen: baseSen, creditedSen: baseSen }];
  }

  const poolSen = baseSen - credited.reduce((total, line) => total + line.lineAmountSen, 0);
  const byGross = credited.map((line) => Math.abs(line.grossSen));
  const byAmount = credited.map((line) => Math.abs(line.lineAmountSen));
  const weights = byGross.some((weight) => weight > 0) ? byGross : byAmount.some((weight) => weight > 0) ? byAmount : credited.map(() => 1);
  const shares = allocateLargestRemainder(poolSen, weights);
  return credited.map((line, index) => ({
    ...line,
    spreadSen: shares[index]!,
    creditedSen: line.lineAmountSen + shares[index]!,
  }));
}

/**
 * `totalSen` split in proportion to `weights` (non-negative, not all zero) in whole sen: each part
 * is floor(|total| × weight ÷ Σweights), and the sen left over go one each to the largest
 * remainders, ties to the earlier position. Parts carry the total's sign and sum to it exactly.
 * BigInt inside, so no product ever loses precision.
 */
export function allocateLargestRemainder(totalSen: number, weights: readonly number[]): number[] {
  assertSen(totalSen, "amount to allocate");
  if (weights.length === 0) throw new RangeError("nothing to allocate to");
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) throw new RangeError("weights must be non-negative integers");
  const sum = weights.reduce((total, weight) => total + BigInt(weight), BigInt(0));
  if (sum === BigInt(0)) throw new RangeError("weights must not all be zero");

  const magnitude = BigInt(Math.abs(totalSen));
  const parts = weights.map((weight, index) => {
    const product = magnitude * BigInt(weight);
    return { index, quotient: product / sum, remainder: product % sum };
  });
  let leftover = magnitude - parts.reduce((total, part) => total + part.quotient, BigInt(0));
  const byRemainder = [...parts].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const part of byRemainder) {
    if (leftover === BigInt(0)) break;
    part.quotient += BigInt(1);
    leftover -= BigInt(1);
  }
  const sign = totalSen < 0 ? -1 : 1;
  return parts.map((part) => (part.quotient === BigInt(0) ? 0 : sign * Number(part.quotient)));
}

const QUANTITY = /^(-)?(\d{1,12})(?:\.(\d{1,6}))?$/;

/**
 * quantity × unit price in sen, exact, rounded half away from zero (as Postgres rounds `numeric`).
 * `quantity` is a plain decimal string ("2", "0.5", "-1.25"); anything else throws `RangeError`.
 */
export function grossSen(quantity: string, unitPriceSen: number): number {
  const match = QUANTITY.exec(quantity);
  if (!match) throw new RangeError(`not a decimal quantity: "${quantity}"`);
  assertSen(unitPriceSen, "unit price");
  const [, minus, whole, fraction = ""] = match;
  const scale = BigInt(10) ** BigInt(fraction.length);
  const scaledQuantity = BigInt(`${whole}${fraction}`);
  const product = scaledQuantity * BigInt(Math.abs(unitPriceSen));
  const rounded = (product * BigInt(2) + scale) / (scale * BigInt(2)); // floor(product / scale + 1/2)
  const negative = (minus === "-") !== unitPriceSen < 0;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError("gross amount too large");
  return negative && result !== 0 ? -result : result;
}

/** Trimmed, inner whitespace collapsed; null when empty. */
function cleanStaffName(name: string | null): string | null {
  const cleaned = name?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned === "" ? null : cleaned;
}

function assertSen(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is not a whole number of sen: ${value}`);
}
