import { UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getDoctorDetail, METRIC_DEFINITIONS, type BranchFigures, type MetricName, type TrendPoint } from "@/analytics";
import { hasRole } from "@/auth/roles";
import { requireUser } from "@/auth/session";
import { LineTrendChart } from "@/components/charts/line-trend-chart";
import { formatMonth } from "@/components/charts/month-label";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { EmptyState } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, formatDateRange, mergeFilterIntoSearchParams, parseFilter, withSearchParams } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit } from "@/lib/money";

export const metadata: Metadata = { title: "Doctor" };

const DEFINITIONS: MetricName[] = ["revenue", "aovPerCustomer", "invoices", "itemsPerInvoice", "sharePercent", "monthlyTrend", "pendingLineItems"];

/**
 * One doctor's detail view (spec story 36): their KPIs for the global filter (the doctor ranking's
 * own figures), monthly trend and branch split, from `getDoctorDetail` (Analytics Service). Linked
 * from every doctor name on the Doctors and Trends pages and from the Trends chart.
 *
 * - An unknown id → 404. A staff member who is not a doctor (other staff, a generic account) → a
 *   page saying so (their revenue is under "Not in the ranking" on the Doctors page).
 * - The page is for ONE doctor, so the global doctor filter is not applied to its figures; picking
 *   another single doctor in the filter bar opens that doctor's page instead.
 * - The filter bar gets the URL's own filter state: the page never writes its doctor into the global
 *   filter, so changing dates or branches, the nav links and "Back to the doctor ranking" keep
 *   whatever doctor selection (usually none) the user had.
 */
export default async function DoctorPage({ params, searchParams }: PageProps<"/doctors/[id]">) {
  const user = await requireUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filterState = parseFilter(query);
  const { filter } = filterState;
  const chosen = filter.doctorIds;
  if (chosen?.length === 1 && chosen[0] !== id) {
    // parseFilter only accepts [A-Za-z0-9_-] ids, so this stays a same-origin /doctors/<id> path.
    redirect(withSearchParams(`/doctors/${encodeURIComponent(chosen[0]!)}`, mergeFilterIntoSearchParams(query, filterState)));
  }

  const detail = await getDoctorDetail(getDb(), id, filter);
  if (detail.status === "not_found") notFound();

  const rankingHref = withSearchParams("/doctors", filterSearchParamsOnly(query));
  const backToRanking = (
    <Button asChild size="sm" variant="outline">
      <Link href={rankingHref}>Back to the doctor ranking</Link>
    </Button>
  );

  if (detail.status === "not_a_doctor") {
    const { name, kind } = detail.staff;
    const owner = hasRole(user, "owner");
    return (
      <PageShell title={name} description="Not a doctor" filter={filterState}>
        <EmptyState
          icon={UserX}
          title={`${name} is not a doctor`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {backToRanking}
              {owner ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={withSearchParams("/settings/doctors", filterSearchParamsOnly(query))}>Settings → Doctors</Link>
                </Button>
              ) : null}
            </div>
          }
        >
          <p>
            {name} is recorded as {kind === "other" ? "other staff (e.g. a nurse or groomer)" : "a generic account (a shared login)"}, so there are no
            doctor figures for them: their revenue is listed under “Not in the ranking” on the Doctors page.{" "}
            {owner ? "If they are a doctor, change their kind in Settings → Doctors." : "The clinic owner can change this in Settings → Doctors."}
          </p>
        </EmptyState>
      </PageShell>
    );
  }

  const { doctor, figures } = detail;
  const monthColumns: DataTableColumn<TrendPoint>[] = [
    {
      key: "month",
      header: "Month",
      kind: "text",
      value: (point) => {
        const month = detail.months.find((candidate) => candidate.month === point.month);
        return `${formatMonth(point.month)}${month?.partialReason === "current_month" ? " (so far)" : month?.partial ? " (part)" : ""}`;
      },
    },
    { key: "revenue", header: "Revenue", kind: "money", value: (point) => point.revenue },
    { key: "aov", header: "AOV per customer", kind: "money", value: (point) => point.aovPerCustomer },
    { key: "invoices", header: "Invoices", kind: "count", value: (point) => point.invoices },
    { key: "customers", header: "Customers", kind: "count", value: (point) => point.customers },
  ];
  const branchColumns: DataTableColumn<BranchFigures>[] = [
    { key: "branch", header: "Branch", kind: "text", value: (row) => row.branchName },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    { key: "share", header: "Share of revenue", kind: "percent", value: (row) => row.sharePercent },
    { key: "aov", header: "AOV per customer", kind: "money", value: (row) => row.aovPerCustomer },
    { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices },
    { key: "items", header: "Items per invoice", kind: "decimal", value: (row) => row.itemsPerInvoice },
    { key: "customers", header: "Customers", kind: "count", value: (row) => row.customers, priority: "secondary" },
  ];

  return (
    <PageShell title={doctor.name} description="Revenue, AOV per customer, invoices and basket size for the selected period, by month and branch." filter={filterState}>
      {doctor.source === "alias_only" || !doctor.active ? (
        <p className="flex flex-wrap gap-2">
          {doctor.source === "alias_only" ? (
            <Badge variant="outline" className="font-normal" title="Only seen on invoice lines: no Kreloses staff member matches this name">
              Not in staff list
            </Badge>
          ) : null}
          {!doctor.active ? (
            <Badge variant="outline" className="font-normal" title="Kreloses no longer lists this staff member; their history is kept">
              Inactive
            </Badge>
          ) : null}
        </p>
      ) : null}

      <PendingLineItemsNote filter={filter} pending={detail.pendingLineItems} doctorsOnly />

      <section aria-label="Key figures" className="@container">
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-6">
          <Stat title="Revenue" value={formatRinggit(figures.revenue)} testId="doctor-revenue" />
          <Stat title="AOV per customer" value={figures.aovPerCustomer === null ? "—" : formatRinggit(figures.aovPerCustomer)} testId="doctor-aov" />
          <Stat title="Invoices" value={formatCount(figures.invoices)} testId="doctor-invoices" />
          <Stat title="Items per invoice" value={figures.itemsPerInvoice === null ? "—" : figures.itemsPerInvoice.toFixed(2)} testId="doctor-items" />
          <Stat title="Share of revenue" value={figures.sharePercent === null ? "—" : `${figures.sharePercent.toFixed(1)}%`} testId="doctor-share" />
          <Stat title="Customers" value={formatCount(figures.customers)} testId="doctor-customers" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {formatDateRange(detail.period.dateFrom, detail.period.dateTo)}
          {filter.branchIds ? ", selected branches" : ", all branches"}. Share is of all revenue in the period and branches ({formatRinggit(detail.totalRevenue)}).
        </p>
      </section>

      {figures.invoices === 0 ? (
        <EmptyState title={`No revenue credited to ${doctor.name} in this period`} action={backToRanking}>
          <p>Choose a longer date range in the filter bar to see their trend.</p>
        </EmptyState>
      ) : (
        <>
          {detail.months.length > 0 ? (
            <div className="rounded-xl border bg-card p-3 sm:p-4">
              <LineTrendChart
                title="Monthly revenue"
                valueName="Revenue"
                testId="doctor-trend-chart"
                periods={detail.months.map((month) => ({ key: month.month, label: formatMonth(month.month), partial: month.partial }))}
                series={[
                  {
                    id: doctor.staffId,
                    label: doctor.name,
                    slot: 1,
                    values: detail.monthly.map((point) => Number(point.revenue)),
                    valueLabels: detail.monthly.map((point) => formatRinggit(point.revenue)),
                  },
                ]}
              />
            </div>
          ) : null}

          <DataTable
            caption="By month"
            description="AOV per customer in a month: that month's revenue ÷ the customers billed that month."
            columns={monthColumns}
            rows={detail.monthly}
            rowKey={(point) => point.month}
            export={{ name: `${doctor.name} by month`, filter }}
            testId="doctor-months"
          />

          <DataTable
            caption="By branch"
            description="AOV per customer counted per branch. Share is of all revenue in the period and branches."
            columns={branchColumns}
            rows={detail.branches}
            rowKey={(row) => row.branchId}
            export={{ name: `${doctor.name} by branch`, filter }}
            testId="doctor-branches"
          />

          <div>{backToRanking}</div>
        </>
      )}

      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">How these numbers are worked out</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          {DEFINITIONS.map((name) => (
            <li key={name}>{METRIC_DEFINITIONS[name]}</li>
          ))}
        </ul>
      </details>
    </PageShell>
  );
}

function Stat({ title, value, testId }: { title: string; value: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p data-testid="stat-value" className="text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
    </div>
  );
}
