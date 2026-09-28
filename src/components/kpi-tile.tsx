import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import type { Kpi } from "@/analytics";
import { formatCount, formatCountChange, formatPercentChange } from "@/lib/format";
import { formatRinggit, formatRinggitChange, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * One KPI (a value from the Analytics Service) with its changes against the previous period and
 * the same period last year. Pure presentation: every number, change and percentage arrives
 * computed.
 */
export function KpiTile({
  title,
  kpi,
  kind,
  testId,
  size = "default",
}: {
  title: string;
  kpi: Kpi<Money> | Kpi<Money | null> | Kpi<number>;
  kind: "money" | "count";
  testId?: string;
  size?: "default" | "sm";
}) {
  const value = kpi.value === null ? "—" : kind === "money" ? formatRinggit(kpi.value as Money) : formatCount(kpi.value as number);
  return (
    <div
      data-testid={testId}
      className={cn("flex min-w-0 flex-col gap-1 rounded-xl border bg-card", size === "sm" ? "p-3" : "p-4")}
    >
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p data-testid="kpi-value" className={cn("font-semibold tracking-tight tabular-nums", size === "sm" ? "text-lg" : "text-2xl")}>
        {value}
      </p>
      <Change label="vs previous period" testId="kpi-vs-previous" change={kpi.previousPeriod} kind={kind} />
      <Change label="vs last year" testId="kpi-vs-last-year" change={kpi.lastYear} kind={kind} />
    </div>
  );
}

function Change({
  label,
  testId,
  change,
  kind,
}: {
  label: string;
  testId: string;
  change: Kpi<Money | number | null>["previousPeriod"];
  kind: "money" | "count";
}) {
  if (change.changePercent === null || change.change === null) {
    return (
      <p data-testid={testId} className="flex items-start gap-1 text-xs text-muted-foreground">
        <Minus className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>No sales to compare {label}</span>
      </p>
    );
  }
  const direction = change.changePercent > 0 ? "up" : change.changePercent < 0 ? "down" : "flat";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const amount = kind === "money" ? formatRinggitChange(change.change as Money) : formatCountChange(change.change as number);
  return (
    <p
      data-testid={testId}
      className={cn(
        "flex items-start gap-1 text-xs tabular-nums",
        direction === "up" && "text-emerald-700 dark:text-emerald-400",
        direction === "down" && "text-destructive",
        direction === "flat" && "text-muted-foreground",
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        {amount} ({formatPercentChange(change.changePercent)}) <span className="text-muted-foreground">{label}</span>
      </span>
    </p>
  );
}
