import { RefreshCw, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getDataFreshness } from "@/analytics";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { formatClinicDateTime, formatDateRange } from "@/filters";
import { formatCount, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listSyncRuns, type SyncMode, type SyncRun, type SyncRunStatus } from "@/sync";

export const metadata: Metadata = { title: "Sync status" };

const STATUS: Record<SyncRunStatus, { label: string; className: string }> = {
  succeeded: { label: "Succeeded", className: "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" },
  partial: { label: "Stopped early", className: "bg-amber-500/10 text-amber-900 dark:text-amber-200" },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
  running: { label: "Running", className: "bg-sky-600/10 text-sky-800 dark:text-sky-300" },
};

const MODE: Record<SyncMode, string> = { manual: "Sync now", nightly: "Nightly", backfill: "History backfill" };

/** Every signed-in user: how fresh each branch's data is, and the recent sync runs. */
export default async function SyncStatusPage() {
  await requireUser();
  const sql = getDb();
  const [runs, freshness] = await Promise.all([listSyncRuns(sql, { limit: 50 }), getDataFreshness(sql)]);

  return (
    <PageShell title="Sync status" description="Sync runs, and how fresh each branch's data is.">
      {freshness.length > 0 ? (
        <section aria-labelledby="freshness-heading" className="flex flex-col gap-2">
          <h2 id="freshness-heading" className="text-base font-medium">
            Data as of
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {freshness.map((branch) => (
              <li key={branch.branchId} data-testid="branch-freshness" className="rounded-lg border bg-card px-3 py-2 text-sm">
                <span className="font-medium">{branch.branchName}</span>
                <span className="block text-muted-foreground">
                  {branch.dataAsOf ? formatClinicDateTime(branch.dataAsOf) : "No complete sync yet"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState icon={RefreshCw} title="No sync runs yet">
          <p>Runs appear here once a Kreloses connection has been added and synced.</p>
        </EmptyState>
      ) : (
        <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
          <h2 id="runs-heading" className="text-base font-medium">
            Recent runs
          </h2>
          <ul className="flex flex-col gap-3" aria-label="Sync runs">
            {runs.map((run) => (
              <li key={run.id}>
                <RunCard run={run} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

function RunCard({ run }: { run: SyncRun }) {
  const status = STATUS[run.status];
  const { counts } = run;
  return (
    <article data-testid="sync-run" aria-label={`${run.connectionLabel} sync`} className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 truncate font-medium">
          {run.connectionLabel}
          {run.connectionId === null ? <span className="font-normal text-muted-foreground"> (connection deleted)</span> : null}
        </h3>
        <Badge data-testid="sync-run-status" className={cn("h-6 px-2.5", status.className)}>
          {status.label}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Item label="Kind">{MODE[run.mode]}</Item>
        <Item label="Sales dated">{formatDateRange(run.dateFrom, run.dateTo)}</Item>
        <Item label="Started">{formatClinicDateTime(run.startedAt)}</Item>
        <Item label="Duration">{run.finishedAt ? formatDuration(run.finishedAt.getTime() - run.startedAt.getTime()) : "Still running"}</Item>
        <Item label="Invoices read" testId="sync-run-seen">
          {formatCount(counts.invoicesSeen)}
          <span className="text-muted-foreground"> ({formatCount(counts.pages)} {counts.pages === 1 ? "page" : "pages"})</span>
        </Item>
        <Item label="New" testId="sync-run-inserted">
          {formatCount(counts.inserted)}
        </Item>
        <Item label="Changed" testId="sync-run-updated">
          {formatCount(counts.updated)}
        </Item>
        <Item label="Unchanged" testId="sync-run-unchanged">
          {formatCount(counts.unchanged)}
        </Item>
      </dl>
      {run.status === "partial" && run.checkpoint ? (
        <p className="text-muted-foreground">Stopped at its time limit before page {run.checkpoint.nextPage}; sync again to read the rest.</p>
      ) : null}
      {run.error ? (
        <p data-testid="sync-run-error" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{run.error}</span>
        </p>
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
