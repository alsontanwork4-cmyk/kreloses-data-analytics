/**
 * Money (RM) outside SQL, per the README convention: amounts travel as exact decimal strings with
 * two places (`"1234.50"`, `"-120.00"`, what Postgres `numeric(12,2)` returns) or as integer sen
 * (`123450`). Arithmetic in JS happens only on integer sen, never on floats.
 */

/** An exact RM amount with two decimal places, e.g. `"1234.50"` or `"-120.00"`. */
export type Money = string;

const MONEY = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** `"1234.5"` → `123450`. Throws on anything that is not a plain decimal amount. */
export function moneyToSen(value: Money): number {
  const match = MONEY.exec(value.trim());
  if (!match) throw new TypeError(`Not a money amount: "${value}"`);
  const [, minus, whole, fraction = ""] = match;
  const sen = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(sen)) throw new RangeError(`Money amount too large: "${value}"`);
  return minus && sen !== 0 ? -sen : sen;
}

/** `123450` → `"1234.50"`; `-12000` → `"-120.00"`. */
export function senToMoney(sen: number): Money {
  if (!Number.isSafeInteger(sen)) throw new RangeError(`Not a whole number of sen: ${sen}`);
  const abs = Math.abs(sen);
  return `${sen < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const GROUPED = new Intl.NumberFormat("en-MY", { useGrouping: true, maximumFractionDigits: 0 });

/** For display only: `"1234.50"` → `"RM 1,234.50"`, `"-120.00"` → `"−RM 120.00"`. */
export function formatRinggit(value: Money): string {
  const sen = moneyToSen(value);
  const abs = Math.abs(sen);
  return `${sen < 0 ? "−" : ""}RM ${GROUPED.format(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** For display only: a change, always signed: `"+RM 3,555.40"`, `"−RM 7,244.60"`, `"RM 0.00"`. */
export function formatRinggitChange(value: Money): string {
  const sen = moneyToSen(value);
  return sen > 0 ? `+${formatRinggit(value)}` : formatRinggit(value);
}
