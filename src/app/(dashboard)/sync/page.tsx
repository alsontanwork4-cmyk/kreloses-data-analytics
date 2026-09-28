import { RefreshCw, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getDataFreshness } from "@/analytics";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { formatClinicDateTime, formatDateRange, formatIsoDate } from "@/filters";
import { formatCount, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listSyncRuns, type SyncMode, type SyncRun, type SyncRunStatus } from "@/sync";
import { listPermanentlyMissingInvoices, MAX_PAGE_MISSING_ATTEMPTS, type PermanentlyMissingInvoice } from "@/sync/lines";
import { nightlyWindowDays } from "@/sync/nightly";

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
  const [runs, freshness, missing] = await Promise.all([listSyncRuns(sql, { limit: 50 }), getDataFreshness(sql), listPermanentlyMissingInvoices(sql)]);

  return (
    <PageShell
      title="Sync status"
      description={`Sync runs, and how fresh each branch's data is. Every night (at about 03:00, Kuala Lumpur time) each connection re-reads the last ${nightlyWindowDays()} days of sales and opens only new or changed invoices.`}
    >
      {freshness.length > 0 ? (
        <section aria-labelledby="freshness-heading" className="flex flex-col gap-2">
          <h2 id="freshness-heading" className="text-base font-medium">
            Data as of
          </h2>
          <p className="text-xs text-muted-foreground">
            When the latest successful sync that read up to the day it ran finished (a sync of an older month does not count; a
            sync that carried on from an earlier one counts from when that one started).
          </p>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {freshness.map((branch) => (
              <li key={branch.branchId} data-testid="branch-freshness" className="rounded-lg border bg-card px-3 py-2 text-sm">
                <span className="font-medium">{branch.branchName}</span>
                <span className="block text-muted-foreground">
                  {branch.dataAsOf ? formatClinicDateTime(branch.dataAsOf) : "Not synced up to today yet"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {missing.total > 0 ? <PermanentlyMissing total={missing.total} invoices={missing.invoices} /> : null}

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

function PermanentlyMissing({ total, invoices }: { total: number; invoices: PermanentlyMissingInvoice[] }) {
  return (
    <section aria-labelledby="missing-heading" data-testid="permanently-missing" className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
      <h2 id="missing-heading" className="text-base font-medium">
        Invoice pages the sync gave up on
      </h2>
      <p className="text-muted-foreground">
        {formatCount(total)} {total === 1 ? "sale's" : "sales'"} invoice page could not be opened (or, for older sales, read){" "}
        {MAX_PAGE_MISSING_ATTEMPTS} times in a row, so the sync stopped trying. {total === 1 ? "It counts" : "They count"} at the revenue base (net
        less refunds) as &quot;line items not synced yet&quot; (credited to no doctor). If the sale is edited in Kreloses the sync tries again;
        otherwise check it in Kreloses.
      </p>
      <ul className="flex flex-col gap-1">
        {invoices.map((invoice, index) => (
          <li key={`${invoice.saleNumber}-${index}`}>
            {invoice.saleNumber ?? "(no number)"} · {formatIsoDate(invoice.saleDate)} · {invoice.branchName}
          </li>
        ))}
        {total > invoices.length ? <li className="text-muted-foreground">…and {formatCount(total - invoices.length)} more</li> : null}
      </ul>
    </section>
  );
}

function RunCard({ run }: { run: SyncRun }) {
  const readWholeListing = run.coveredLocationIds.length > 0;
  // A partial run that read the whole listing only lacks some invoice pages (see its warning).
  const status = run.status === "partial" && readWholeListing ? { ...STATUS.partial, label: "Some invoice pages missing" } : STATUS[run.status];
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
        <Item label="Kind" testId="sync-run-mode">
          {MODE[run.mode]}
        </Item>
        <Item label="Sales dated">{formatDateRange(run.dateFrom, run.dateTo)}</Item>
        <Item label="Started">{formatClinicDateTime(run.startedAt)}</Item>
        <Item label="Duration" testId="sync-run-duration">
          {run.finishedAt ? formatDuration(run.finishedAt.getTime() - run.startedAt.getTime()) : "Still running"}
        </Item>
        <Item label="Invoices read" testId="sync-run-seen">
          {formatCount(counts.invoicesSeen)}
          <span className="text-muted-foreground"> ({formatCount(counts.pages)} list {counts.pages === 1 ? "page" : "pages"})</span>
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
        <Item label="Line items read" testId="sync-run-line-items">
          {formatCount(counts.lineItemsRead)} {counts.lineItemsRead === 1 ? "invoice" : "invoices"}
          {counts.lineItemsSwept > 0 ? <span className="text-muted-foreground"> ({formatCount(counts.lineItemsSwept)} older)</span> : null}
        </Item>
        <Item label="Invoice pages missing" testId="sync-run-line-items-failed">
          {formatCount(counts.lineItemsFailed)}
          {counts.lineItemsUnreadable > 0 ? (
            <span className="text-muted-foreground" data-testid="sync-run-line-items-unreadable">
              {" "}
              (+{formatCount(counts.lineItemsUnreadable)} older unreadable)
            </span>
          ) : null}
        </Item>
        <Item label="Lines ≠ invoice net" testId="sync-run-line-gaps">
          {formatCount(counts.lineItemGaps)} {counts.lineItemGaps === 1 ? "invoice" : "invoices"}
        </Item>
      </dl>
      {run.chainStartedAt ? (
        <p className="text-muted-foreground" data-testid="sync-run-resumed">
          Carried on from where an earlier run stopped; its data counts as of {formatClinicDateTime(run.chainStartedAt)}, when the first of
          those runs started.
        </p>
      ) : null}
      {run.status === "partial" && run.checkpoint && !readWholeListing ? (
        <p className="text-muted-foreground">
          Stopped at its time limit
          {run.mode === "nightly" ? "" : ` at page ${run.checkpoint.nextPage}`}; the next {run.mode === "nightly" ? "nightly sync" : "sync of these dates"}{" "}
          within a few hours carries on from there (line items still missing are read then).
        </p>
      ) : null}
      {counts.lineItemGaps > 0 ? (
        <p className="text-muted-foreground">
          The lines of {plural(counts.lineItemGaps, "invoice")} did not add up to the invoice&apos;s net amount; the difference was
          shared across its lines in proportion to what each charged, so totals are unaffected.
        </p>
      ) : null}
      {run.warnings.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Warnings">
          {run.warnings.map((warning) => (
            <li
              key={warning.code}
              data-testid="sync-run-warning"
              className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{warning.message}</span>
            </li>
          ))}
        </ul>
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

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
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
