import type { KpiChange } from "@/analytics";
import { formatCountChange, formatPercentChange } from "@/lib/format";
import { formatRinggitChange, type Money } from "@/lib/money";

const PERIOD: Record<"previousPeriod" | "lastYear", { short: string; long: string }> = {
  previousPeriod: { short: "previous period", long: "the previous period" },
  lastYear: { short: "last year", long: "the same period last year" },
};

/**
 * The line under a KPI tile for one comparison: the change and percentage with its direction, or,
 * when there is no percentage, which side is missing — nothing in the comparison period, or no
 * value in this period (AOV without customers). Display only: the numbers come computed.
 */
export function describeKpiChange(
  change: KpiChange<Money | number | null>,
  kind: "money" | "count",
  period: "previousPeriod" | "lastYear",
  current: { value: Money | number | null } = { value: 0 },
): { direction: "up" | "down" | "flat" | "none"; text: string } {
  const { short, long } = PERIOD[period];
  const nothing = kind === "money" && (change.base === null || current.value === null) ? "customers" : "sales";
  if (current.value === null) return { direction: "none", text: `No ${nothing} in this period to compare` };
  if (change.changePercent === null || change.change === null) return { direction: "none", text: `No ${nothing} in ${long}` };
  const direction = change.changePercent > 0 ? "up" : change.changePercent < 0 ? "down" : "flat";
  const amount = kind === "money" ? formatRinggitChange(change.change as Money) : formatCountChange(change.change as number);
  return { direction, text: `${amount} (${formatPercentChange(change.changePercent)}) vs ${short}` };
}
