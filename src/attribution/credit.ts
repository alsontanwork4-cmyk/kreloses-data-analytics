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
 *    taken off). Everything between those amounts and the invoice's net amount — the invoice's
 *    discount lines (ItemType 55) and any other gap (rounding, adjustments, tax shown on lines) —
 *    is spread across the non-discount lines in proportion to what each line CHARGED (its Amount;
 *    docs/adr/0006 — the spec's "gross" was changed deliberately), with a largest-remainder
 *    allocation in whole sen, ties to the lower line number. That is the line's **credited amount**
 *    (before refunds): the credited amounts of an invoice add up EXACTLY to its net amount.
 * 3. A refund (`invoiceRefundSen`, #6 — an assumption pending live data, docs/adr/0008) is taken off
 *    the lines the same way, in proportion to what each line charged: the line's **refund share**.
 *    Its **revenue** = credited amount − refund share, and the revenue of an invoice's lines adds up
 *    EXACTLY to its revenue base (`invoiceRevenueBaseSen`), to the sen. Revenue metrics sum revenue;
 *    the discount metric uses gross − credited amount, so a refund is never counted as a discount.
 *
 * Edge cases (each unit-tested in credit.test.ts):
 * - Lines that charged ≤ 0 (free lines, returns) take no share while any line charged more than
 *   zero. If no line did: by |gross| (quantity × unit price); if that is zero everywhere: equally.
 * - No non-discount line at all (only discount lines, or no lines): ONE "unitemised remainder"
 *   (`lineNo: null`, no staff) carries the whole net and refund — even a zero one, so every invoice
 *   keeps at least one credited line and still counts as an invoice.
 * - A cancelled invoice has a net and a revenue base of zero, so its lines are credited zero.
 */

/** Kreloses's ItemType of a discount line. Other types (1 product, 4 service, …) are credited. */
export const DISCOUNT_ITEM_TYPE = 55;

/** The invoice header fields attribution needs (money in integer sen). */
export interface AttributionInvoice {
  status: "active" | "cancelled";
  /** Kreloses's NetAmount (after discounts, before tax). */
  netSen: number;
  /** Kreloses's Total (net + tax): refunds are assumed to be tax-inclusive, like it. */
  totalSen: number;
  /** Kreloses's TotalRefunds (see `invoiceRefundSen`). */
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
  /** Its share of the invoice's discount lines and gap (negative = a discount). */
  spreadSen: number;
  /**
   * lineAmountSen + spreadSen: the line's share of the invoice's NET amount, before any refund —
   * what it was finally charged. Gross − this is the line's discount (#12).
   */
  creditedSen: number;
  /** Its share of the invoice's refund (`invoiceRefundSen`), spread like the discounts; ≥ 0. */
  refundSen: number;
  /** creditedSen − refundSen: what revenue metrics count. An invoice's lines add up to its revenue base. */
  revenueSen: number;
}

/**
 * How much of an invoice's net amount a refund takes back — THE one place refunds are interpreted
 * (#6). An ASSUMPTION pending live verification of how Kreloses reports refunds (the Sale List's
 * TotalRefunds vs the invoice page's RefundInfo / CreditNoteInfo; docs/adr/0008, CONTEXT.md
 * "Refund"): if the live data says otherwise, only this function and its SQL twin in
 * `invoices.revenue_base` change.
 *
 * - Kreloses's TotalRefunds is taken to be money given back, tax-inclusive like Total, so the part
 *   of it that was net is `totalRefunds × net ÷ total`, rounded half up to the sen.
 * - Never more than the net, never below zero; nothing when the total is zero or negative.
 * - A return sale (net ≤ 0) already reduces revenue through its own negative net: its refund is the
 *   money given back for it, not a second reduction.
 * - Cancelled invoices: 0 (they count nothing anyway).
 */
export function invoiceRefundSen(invoice: AttributionInvoice): number {
  const { status, netSen, totalSen, totalRefundsSen } = invoice;
  assertSen(netSen, "net amount");
  assertSen(totalSen, "total");
  assertSen(totalRefundsSen, "total refunds");
  if (status !== "active" || netSen <= 0 || totalSen <= 0 || totalRefundsSen <= 0) return 0;
  // floor((2·R·N + T) / (2·T)) = R·N/T rounded half up (all positive). BigInt: no precision loss.
  const two = BigInt(2);
  const share = (two * BigInt(totalRefundsSen) * BigInt(netSen) + BigInt(totalSen)) / (two * BigInt(totalSen));
  return share >= BigInt(netSen) ? netSen : Number(share);
}

/**
 * What an invoice's revenue (the `revenueSen` of its credited lines) adds up to — THE one definition,
 * mirrored in SQL by the generated `invoices.revenue_base` (a test and a runtime check in
 * `saveInvoiceLines` keep them equal; change both together): the net amount of an active invoice
 * less the part of it refunded (`invoiceRefundSen`); zero for a cancelled one. A negative (return)
 * invoice reduces revenue through its own negative net amount.
 */
export function invoiceRevenueBaseSen(invoice: AttributionInvoice): number {
  return netBaseSen(invoice) - invoiceRefundSen(invoice);
}

/** What the credited amounts (before refunds) add up to: the net of an active invoice, else 0. */
function netBaseSen(invoice: AttributionInvoice): number {
  return invoice.status === "active" ? invoice.netSen : 0;
}

/**
 * The credited lines of one invoice: one per non-discount line (in line order), or the single
 * unitemised remainder when there is none. Their `creditedSen` add up to the invoice's net (0 when
 * cancelled) and their `revenueSen` to `invoiceRevenueBaseSen(invoice)`, exactly. Throws
 * `RangeError` for input that cannot be credited (a non-discount line without quantity/price/amount,
 * duplicate line numbers): the Reader never produces it, so it is a bug, not data to guess about.
 */
export function creditInvoice(invoice: AttributionInvoice, lines: readonly AttributionLine[]): CreditedLine[] {
  const baseSen = netBaseSen(invoice);
  assertSen(baseSen, "net amount");
  const refundSen = invoiceRefundSen(invoice);
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
    return [
      { lineNo: null, staffName: null, grossSen: 0, lineAmountSen: 0, spreadSen: baseSen, creditedSen: baseSen, refundSen, revenueSen: baseSen - refundSen },
    ];
  }

  const weights = spreadWeights(credited);
  const poolSen = baseSen - credited.reduce((total, line) => total + line.lineAmountSen, 0);
  const shares = allocateLargestRemainder(poolSen, weights);
  // The refund is spread exactly like the discounts: in proportion to what each line charged.
  const refunds = allocateLargestRemainder(refundSen, weights);
  return credited.map((line, index) => {
    const creditedSen = line.lineAmountSen + shares[index]!;
    return { ...line, spreadSen: shares[index]!, creditedSen, refundSen: refunds[index]!, revenueSen: creditedSen - refunds[index]! };
  });
}

/**
 * What each line's share of the invoice-level spread is proportional to (docs/adr/0006): what the
 * line CHARGED (its `Amount`, after any item-level discount) — a bill discount applies to the amounts
 * after item discounts, and a line that already gave most of its price away is never pushed negative.
 * Lines that charged nothing or less (free, returns) take no share while any line charged more than
 * zero. If none did: by |gross| (quantity × unit price); if that is zero everywhere too: equally.
 */
function spreadWeights(lines: readonly { grossSen: number; lineAmountSen: number }[]): number[] {
  const charged = lines.map((line) => Math.max(line.lineAmountSen, 0));
  if (charged.some((weight) => weight > 0)) return charged;
  const gross = lines.map((line) => Math.abs(line.grossSen));
  if (gross.some((weight) => weight > 0)) return gross;
  return lines.map(() => 1);
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
