import type { KpiChange } from "@/analytics";
import { formatCountChange, formatPercentChange } from "@/lib/format";
import { formatRinggitChange, moneyToSen, type Money } from "@/lib/money";

/** Display only (the Daily page): the numbers arrive computed by the Analytics Service (`getDailySales`). */

// Shared with the MCP `daily_sales` tool, so it lives with the other date formats.
export { formatDayWithWeekday } from "@/filters";

export type ComparisonName = "last week" | "last year";

/**
 * One comparison of a daily figure, in words:
 * - a percentage when there is one (`percent` "+50.0%", `amount` "+RM 375.00");
 * - a zero base: the amount and `note` "none last week" (no percentage of nothing);
 * - AOV with no customers on one side, or nothing on either day: only a `note`.
 * `direction` drives the arrow and colour; the sign is always in the text too (never colour alone).
 */
export interface DailyChangeText {
  direction: "up" | "down" | "flat" | "none";
  amount: string | null;
  percent: string | null;
  note: string | null;
}

export function describeDailyChange(
  change: KpiChange<Money | number | null>,
  kind: "money" | "count",
  value: Money | number | null,
  against: ComparisonName,
): DailyChangeText {
  if (value === null) return { direction: "none", amount: null, percent: null, note: "no customers this day" };
  if (change.base === null || change.change === null) return { direction: "none", amount: null, percent: null, note: `no customers ${against}` };
  const changeUnits = kind === "money" ? moneyToSen(change.change as Money) : (change.change as number);
  const amount = kind === "money" ? formatRinggitChange(change.change as Money) : formatCountChange(change.change as number);
  if (change.changePercent === null) {
    // The base is zero: a change, but no percentage of nothing.
    if (changeUnits === 0) return { direction: "none", amount: null, percent: null, note: "none on either day" };
    return { direction: changeUnits > 0 ? "up" : "down", amount, percent: null, note: `none ${against}` };
  }
  const direction = change.changePercent > 0 ? "up" : change.changePercent < 0 ? "down" : "flat";
  return { direction, amount, percent: formatPercentChange(change.changePercent), note: null };
}

/**
 * The same, as one line: `"+RM 375.00 (+50.0%) vs last week"`, `"+RM 585.00 vs last year (none then)"`,
 * `"No customers last week"`.
 */
export function dailyChangeSentence(text: DailyChangeText, against: ComparisonName): string {
  if (text.amount === null) return capitalise(text.note ?? "");
  return text.percent === null ? `${text.amount} vs ${against} (none then)` : `${text.amount} (${text.percent}) vs ${against}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
