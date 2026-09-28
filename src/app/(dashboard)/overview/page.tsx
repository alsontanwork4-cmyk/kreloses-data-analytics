import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";

import {
  getDataFreshness,
  getOverviewKpis,
  getPendingLineItems,
  getServiceLineKpis,
  METRIC_DEFINITIONS,
  type KpiSet,
  type MetricName,
  type ServiceLineKpiSet,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { EmptyState, NoSalesYet } from "@/components/empty-state";
import { KpiTile } from "@/components/kpi-tile";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { getDb } from "@/db/client";
import { formatClinicDateTime, formatDateRange, parseFilter } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

const DEFINITIONS: MetricName[] = [
  "revenue",
  "invoices",
  "customers",
  "aovPerCustomer",
  "surgeryRevenue",
  "consultRevenue",
  "creditedLine",
  "previousPeriod",
  "lastYear",
  "change",
  "dataAsOf",
];

/** Headline KPIs for the global filter, from the Analytics Service (no maths here). */
export default async function OverviewPage({ searchParams }: PageProps<"/overview">) {
  const user = await requireUser();
  const filterState = parseFilter(await searchParams);
  const { filter } = filterState;
  const sql = getDb();
  // Freshness for the period shown, for every branch (so "nothing synced yet" is told apart from a
  // branch filter that matches nothing).
  const [kpis, freshness, pending, serviceLines] = await Promise.all([
    getOverviewKpis(sql, filter),
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getPendingLineItems(sql, filter),
    getServiceLineKpis(sql, filter),
  ]);
  const dataAsOf = new Map(freshness.map((branch) => [branch.branchId, branch.dataAsOf]));
  const branchServiceLines = new Map(serviceLines.branches.map((branch) => [branch.branchId, branch]));

  return (
    <PageShell
      title="Overview"
      description="Headline KPIs for the selected period, compared with the previous period and the same period last year."
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Revenue, invoices, customers and AOV" icon={LayoutDashboard} />
      ) : kpis.branches.length === 0 ? (
        <EmptyState icon={LayoutDashboard} title="No branch matches this filter">
          <p>Choose “All branches” in the filter bar.</p>
        </EmptyState>
      ) : (
        <>
          <section aria-label="Totals" className="flex flex-col gap-2">
            {filter.doctorIds ? (
              <p data-testid="doctor-filter-note" className="text-sm text-muted-foreground">
                Showing only revenue credited to the selected {filter.doctorIds.length === 1 ? "doctor" : "doctors"}: invoices and
                customers with at least one line credited to them.
              </p>
            ) : null}
            <PendingLineItemsNote filter={filter} pending={pending} />
            {!filter.doctorIds && pending.invoices > 0 ? (
              <p data-testid="service-lines-pending-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                {formatCount(pending.invoices)} {pending.invoices === 1 ? "invoice" : "invoices"} in this period ({formatRinggit(pending.revenue)}){" "}
                {pending.invoices === 1 ? "has" : "have"} line items not synced yet: {pending.invoices === 1 ? "it is" : "they are"} in revenue,
                invoices and customers, but not yet in surgery or consult revenue. The next sync reads {pending.invoices === 1 ? "it" : "them"}.
              </p>
            ) : null}
            <KpiGrid kpis={kpis.total} serviceLines={serviceLines.total} idPrefix="kpi" />
            <p className="text-xs text-muted-foreground">
              Compared with the previous period ({formatDateRange(kpis.previousPeriod.dateFrom, kpis.previousPeriod.dateTo)}) and
              the same period last year ({formatDateRange(kpis.lastYear.dateFrom, kpis.lastYear.dateTo)}).
            </p>
          </section>

          <section aria-labelledby="branches-heading" className="flex flex-col gap-3">
            <h2 id="branches-heading" className="text-base font-medium">
              By branch
            </h2>
            <ul className="flex flex-col gap-4">
              {kpis.branches.map((branch) => {
                const asOf = dataAsOf.get(branch.branchId);
                return (
                  <li key={branch.branchId}>
                    <article
                      aria-labelledby={`branch-${branch.branchId}`}
                      data-testid="branch-kpis"
                      className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3 sm:p-4"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 id={`branch-${branch.branchId}`} className="font-medium">
                          {branch.branchName}
                        </h3>
                        <p data-testid="branch-data-as-of" className="text-xs text-muted-foreground">
                          {asOf ? `Data as of ${formatClinicDateTime(asOf)}` : "Not synced up to the end of this period yet"}
                        </p>
                      </div>
                      <KpiGrid kpis={branch} serviceLines={branchServiceLines.get(branch.branchId)} idPrefix="branch-kpi" size="sm" />
                    </article>
                  </li>
                );
              })}
            </ul>
          </section>

          <details className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">How these numbers are worked out</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
              {DEFINITIONS.map((name) => (
                <li key={name}>{METRIC_DEFINITIONS[name]}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </PageShell>
  );
}

/** The KPI tiles (four, plus surgery and consult revenue); columns follow the space the grid actually has (a container query), not the window. */
function KpiGrid({ kpis, serviceLines, idPrefix, size }: { kpis: KpiSet; serviceLines?: ServiceLineKpiSet; idPrefix: string; size?: "sm" }) {
  return (
    <div className="@container">
      <div className={cn("grid grid-cols-1 gap-3", size === "sm" ? "@xs:grid-cols-2 @3xl:grid-cols-3" : "@md:grid-cols-2 @4xl:grid-cols-3")}>
        <KpiTile title="Revenue" kind="money" kpi={kpis.revenue} testId={`${idPrefix}-revenue`} size={size} />
        <KpiTile title="Invoices" kind="count" kpi={kpis.invoices} testId={`${idPrefix}-invoices`} size={size} />
        <KpiTile title="Customers" kind="count" kpi={kpis.customers} testId={`${idPrefix}-customers`} size={size} />
        <KpiTile title="AOV per customer" kind="money" kpi={kpis.aovPerCustomer} testId={`${idPrefix}-aov`} size={size} />
        {serviceLines ? (
          <>
            <KpiTile title="Surgery revenue" kind="money" kpi={serviceLines.surgeryRevenue} testId={`${idPrefix}-surgery`} size={size} />
            <KpiTile title="Consult revenue" kind="money" kpi={serviceLines.consultRevenue} testId={`${idPrefix}-consult`} size={size} />
          </>
        ) : null}
      </div>
    </div>
  );
}
