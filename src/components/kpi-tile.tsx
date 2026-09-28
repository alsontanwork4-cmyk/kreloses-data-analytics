import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import type { Kpi } from "@/analytics";
import { formatCount } from "@/lib/format";
import { formatRinggit, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";

import { describeKpiChange } from "./kpi-change";

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
      <Change testId="kpi-vs-previous" kpi={kpi} kind={kind} period="previousPeriod" />
      <Change testId="kpi-vs-last-year" kpi={kpi} kind={kind} period="lastYear" />
    </div>
  );
}

function Change({
  testId,
  kpi,
  kind,
  period,
}: {
  testId: string;
  kpi: Kpi<Money> | Kpi<Money | null> | Kpi<number>;
  kind: "money" | "count";
  period: "previousPeriod" | "lastYear";
}) {
  const { direction, text } = describeKpiChange(kpi[period], kind, period, { value: kpi.value });
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <p
      data-testid={testId}
      className={cn(
        "flex items-start gap-1 text-xs tabular-nums",
        direction === "up" && "text-emerald-700 dark:text-emerald-400",
        direction === "down" && "text-destructive",
        (direction === "flat" || direction === "none") && "text-muted-foreground",
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
