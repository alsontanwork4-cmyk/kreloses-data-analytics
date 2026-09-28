/**
 * Kreloses shows money as formatted strings: thousand separators (`1,234.50`), negatives in
 * parentheses (`(12.00)`) or with a minus sign, sometimes a currency prefix (`RM 1,234.50`,
 * `RM (12.00)`), and `-` or an empty string for nothing. JSON numbers are accepted too. The Reader
 * turns all of them into integer sen (RM 1.00 = 100) so no floating-point arithmetic ever touches
 * money (README "Database").
 */

const DIGITS = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY = /^(?:RM|MYR)\s*/i;
const EMPTY = /^[-–—]?$/;
/** numeric(12,2) holds up to 9,999,999,999.99. */
const MAX_WHOLE_DIGITS = 10;

/**
 * Integer sen for a Kreloses amount; `null` for an empty one (`null`, `""`, `"-"`); `undefined` if
 * it is not an amount at all (a changed format — the caller raises `LayoutChanged`). More than
 * two decimal places is not an amount: rounding would hide a format change.
 */
export function parseAmountSen(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  // A JSON number is read through its decimal text (1199.5 → "1199.5"), never multiplied as a float;
  // anything JavaScript cannot write as a plain 2-dp decimal ("1e+21", "0.30000000000000004") is refused.
  if (typeof value === "number") return Number.isFinite(value) ? parseAmountSen(String(value)) : undefined;
  if (typeof value !== "string") return undefined;

  let text = value.trim();
  if (EMPTY.test(text)) return null;
  let negative = false;
  let parenthesised = false;
  let currency = false;
  // Peel the decorations off in whatever order they come: "(RM 12.00)", "RM (12.00)", "-RM 12.00", "RM -12.00".
  for (let changed = true; changed; ) {
    changed = false;
    if (!parenthesised && text.startsWith("(") && text.endsWith(")")) {
      text = text.slice(1, -1).trim();
      parenthesised = changed = true;
    }
    if (!negative && text.startsWith("-")) {
      text = text.slice(1).trim();
      negative = changed = true;
    }
    if (!currency && CURRENCY.test(text)) {
      text = text.replace(CURRENCY, "");
      currency = changed = true;
    }
  }
  if (negative && parenthesised) return undefined;

  const match = DIGITS.exec(text);
  if (!match) return undefined;
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".") as [string, string?];
  if (whole.replace(/^0+(?=\d)/, "").length > MAX_WHOLE_DIGITS) return undefined;
  const sen = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return (negative || parenthesised) && sen !== 0 ? -sen : sen;
}
