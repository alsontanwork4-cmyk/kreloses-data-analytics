import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import type { DailyMetric } from "@/analytics";
import { formatCount } from "@/lib/format";
import { formatRinggit, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";

import { dailyChangeSentence, describeDailyChange, type ComparisonName, type DailyChangeText } from "./format";

/**
 * How the Daily page shows a change: an arrow, a colour AND a signed number, so the direction never
 * depends on colour alone. Pure presentation: every figure arrives computed (`getDailySales`).
 */
const TONE: Record<DailyChangeText["direction"], string> = {
  up: "text-emerald-700 dark:text-emerald-400",
  down: "text-destructive",
  flat: "text-muted-foreground",
  none: "text-muted-foreground",
};

function DirectionIcon({ direction }: { direction: DailyChangeText["direction"] }) {
  if (direction === "none") return null;
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return <Icon className="size-3.5 shrink-0" aria-hidden />;
}

/** A table cell: the percentage (or, over a zero base, the amount) with its arrow; the amount (or why there is none) below. */
export function ChangeCell({
  metric,
  kind,
  against,
  title,
}: {
  metric: DailyMetric<Money> | DailyMetric<Money | null> | DailyMetric<number>;
  kind: "money" | "count";
  against: ComparisonName;
  /** Tooltip, e.g. what the base was and on which day. */
  title?: string;
}) {
  const change = against === "last week" ? metric.lastWeek : metric.lastYear;
  const text = describeDailyChange(change, kind, metric.value, against);
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={title}>
      <span className={cn("inline-flex items-center gap-0.5 font-medium", TONE[text.direction])}>
        <DirectionIcon direction={text.direction} />
        {text.percent ?? text.amount ?? "—"}
      </span>
      <span className="text-xs font-normal text-muted-foreground">{text.percent !== null ? text.amount : text.note}</span>
    </span>
  );
}

/** A headline figure for the day with its two comparisons. */
export function DailyTile({
  title,
  metric,
  kind,
  testId,
}: {
  title: string;
  metric: DailyMetric<Money> | DailyMetric<Money | null> | DailyMetric<number>;
  kind: "money" | "count";
  testId: string;
}) {
  const value = metric.value === null ? "—" : kind === "money" ? formatRinggit(metric.value as Money) : formatCount(metric.value as number);
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p data-testid="daily-value" className="text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {(["last week", "last year"] as const).map((against) => {
        const text = describeDailyChange(against === "last week" ? metric.lastWeek : metric.lastYear, kind, metric.value, against);
        return (
          <p
            key={against}
            data-testid={against === "last week" ? "daily-vs-last-week" : "daily-vs-last-year"}
            className={cn("flex items-start gap-1 text-xs tabular-nums", TONE[text.direction])}
          >
            <span className="mt-px">
              <DirectionIcon direction={text.direction} />
            </span>
            <span className="min-w-0 break-words">{dailyChangeSentence(text, against)}</span>
          </p>
        );
      })}
    </div>
  );
}
