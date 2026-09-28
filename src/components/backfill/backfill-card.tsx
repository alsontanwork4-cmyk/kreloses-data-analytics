import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { formatClinicDateTime, formatDateRange } from "@/filters";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BackfillProgress } from "@/sync/backfill-progress";

import { BackfillControl } from "./backfill-controls";
import { backfillState, invoicesText, monthName, nightsLeftText, requestsLabel, type BackfillTone } from "./labels";

const TONE: Record<BackfillTone, string> = {
  done: "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300",
  working: "bg-sky-600/10 text-sky-800 dark:text-sky-300",
  waiting: "bg-amber-500/10 text-amber-900 dark:text-amber-200",
  stopped: "bg-muted text-muted-foreground",
};

/**
 * One connection's history backfill on Sync status (#8, spec story 12): invoices done / total,
 * months, line items read, tonight's requests against the budget, nights left, the last error —
 * and, for the owner, "Start backfill" / "Pause backfill".
 */
export function BackfillCard({
  progress,
  actions,
}: {
  progress: BackfillProgress;
  /** The owner's controls; absent for managers. */
  actions?: { start: (formData: FormData) => Promise<void>; pause: (formData: FormData) => Promise<void> };
}) {
  const state = backfillState(progress);
  const { invoices, months, night } = progress;
  const percent = invoices.percent;
  const titleId = `backfill-${progress.connectionId}-title`;
  return (
    <article aria-labelledby={titleId} data-testid="backfill" className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="min-w-0 truncate font-medium">
          {progress.connectionLabel}
        </h3>
        <Badge data-testid="backfill-status" className={cn("h-6 px-2.5", TONE[state.tone])}>
          {state.label}
        </Badge>
      </div>

      {progress.status !== "not_started" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span data-testid="backfill-invoices">{invoicesText(progress)}</span>
            {percent !== null ? (
              <span data-testid="backfill-percent" className="font-medium tabular-nums">
                {percent}%
              </span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={`History loaded for ${progress.connectionLabel}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={percent === null ? "Not known yet" : `${percent}%${invoices.estimated ? " (estimated)" : ""}`}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent ?? 0}%` }} />
          </div>
          {invoices.estimated && invoices.total !== null ? (
            <p className="text-xs text-muted-foreground">
              The total is an estimate until every month has been listed (months not listed yet are counted at the average of those that were).
            </p>
          ) : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Item label="Sales dated">{formatDateRange(progress.dateFrom, progress.dateTo)}</Item>
        <Item label="Months done" testId="backfill-months">
          {months.done} of {months.total}
          {months.current && progress.status === "active" ? (
            <span className="text-muted-foreground">
              {" "}
              ({progress.started ? "now" : "starts with"} {monthName(months.current)})
            </span>
          ) : null}
        </Item>
        <Item label="Line items read" testId="backfill-line-items">
          {formatCount(progress.lineItemsRead)} {progress.lineItemsRead === 1 ? "invoice" : "invoices"}
        </Item>
        <Item label={requestsLabel(progress)} testId="backfill-requests">
          {formatCount(night.requestsUsed)} of {formatCount(night.requestBudget)}
        </Item>
        <Item label="Nights left (estimate)" testId="backfill-nights">
          {nightsLeftText(progress)}
        </Item>
        <Item label={progress.status === "complete" ? "Completed" : "Last chunk"} testId="backfill-last-run">
          {progress.status === "complete" && progress.completedAt
            ? formatClinicDateTime(progress.completedAt)
            : progress.lastRunAt
              ? formatClinicDateTime(progress.lastRunAt)
              : progress.status === "active"
                ? `Not yet — next night starts ${formatClinicDateTime(night.nextStart)}`
                : "None"}
        </Item>
      </dl>

      {progress.lastError && progress.status !== "complete" ? (
        <p data-testid="backfill-error" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            Last chunk failed ({formatClinicDateTime(progress.lastError.at)}): {progress.lastError.message}
          </span>
        </p>
      ) : null}

      {actions && progress.status !== "complete" ? (
        <div className="flex flex-wrap items-center gap-2">
          {progress.status === "active" ? (
            <BackfillControl connectionId={progress.connectionId} action={actions.pause} kind="pause" />
          ) : (
            <BackfillControl connectionId={progress.connectionId} action={actions.start} kind="start" />
          )}
          {progress.status === "not_started" ? (
            <span className="text-xs text-muted-foreground">It also starts by itself the first time this connection&apos;s login test works.</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Item({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="break-words">
        {children}
      </dd>
    </div>
  );
}
