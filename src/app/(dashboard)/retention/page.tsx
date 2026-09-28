import { Repeat } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getDataFreshness,
  getRetention,
  METRIC_DEFINITIONS,
  type MetricName,
  type NewVsReturning,
  type NinetyDayReturns,
  type Retention,
  type YearCohort,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { HorizontalBarChart } from "@/components/charts/horizontal-bar-chart";
import { formatCell } from "@/components/data-table/csv";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, formatIsoDate, parseFilter, withSearchParams } from "@/filters";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = { title: "Retention" };

/** Who a row is about: the whole clinic (the selected branches) or one doctor. */
interface Who {
  key: string;
  /** Null for the whole-clinic row. */
  staffId: string | null;
  name: string;
  aliasOnly: boolean;
}

type NewVsReturningRow = Who & NewVsReturning;
type ReturnsRow = Who & NinetyDayReturns;
type CohortRow = Who & YearCohort;

const DEFINITIONS: MetricName[] = ["serviceVisit", "newVsReturning", "returnRate90", "yearlyCohort", "syncedThrough", "doctor", "pendingLineItems"];

/** Retention (spec stories 48–50) from the Analytics Service; no maths here. */
export default async function RetentionPage({ searchParams }: PageProps<"/retention">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const sql = getDb();
  const [report, freshness] = await Promise.all([getRetention(sql, filter), getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo })]);

  const filterQuery = filterSearchParamsOnly(params);
  const clinic: Who = {
    key: "clinic",
    staffId: null,
    name: filter.branchIds ? "Selected branches (all staff)" : "Whole clinic (all staff)",
    aliasOnly: false,
  };
  const doctors: (Who & { figures: Retention["doctors"][number] })[] = report.doctors.map((doctor) => ({
    key: doctor.staffId,
    staffId: doctor.staffId,
    name: doctor.name,
    aliasOnly: doctor.source === "alias_only",
    figures: doctor,
  }));

  const whoColumn = <Row extends Who>(): DataTableColumn<Row> => ({
    key: "doctor",
    header: "Doctor",
    kind: "text",
    value: (row) => row.name,
    cell: (row) =>
      row.staffId === null ? (
        <span className="font-medium">{row.name}</span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={withSearchParams(`/doctors/${row.staffId}`, filterQuery)} className="underline-offset-4 hover:underline">
            {row.name}
          </Link>
          {row.aliasOnly ? (
            <Badge variant="outline" className="font-normal" title="Only seen on invoice lines: no Kreloses staff member matches this name">
              Not in staff list
            </Badge>
          ) : null}
        </span>
      ),
  });

  const newVsReturningRows: NewVsReturningRow[] = [
    ...(report.clinic.newVsReturning.customers > 0 ? [{ ...clinic, ...report.clinic.newVsReturning }] : []),
    ...doctors.filter((doctor) => doctor.figures.newVsReturning.customers > 0).map(({ figures, ...who }) => ({ ...who, ...figures.newVsReturning })),
  ];
  const newVsReturningColumns: DataTableColumn<NewVsReturningRow>[] = [
    whoColumn<NewVsReturningRow>(),
    { key: "customers", header: "Customers seen", kind: "count", value: (row) => row.customers },
    { key: "new", header: "New", kind: "count", value: (row) => row.newCustomers, priority: "secondary" },
    { key: "new-percent", header: "New share", kind: "percent", value: (row) => row.newPercent },
    { key: "returning", header: "Returning", kind: "count", value: (row) => row.returningCustomers, priority: "secondary" },
    { key: "returning-percent", header: "Returning share", kind: "percent", value: (row) => row.returningPercent },
  ];

  const returnsRows: ReturnsRow[] = [
    ...(report.clinic.returns90.visits > 0 ? [{ ...clinic, ...report.clinic.returns90 }] : []),
    ...doctors.filter((doctor) => doctor.figures.returns90.visits > 0).map(({ figures, ...who }) => ({ ...who, ...figures.returns90 })),
  ];
  const returnsColumns: DataTableColumn<ReturnsRow>[] = [
    whoColumn<ReturnsRow>(),
    { key: "rate", header: "90-day return rate", kind: "percent", value: (row) => row.returnPercent },
    { key: "returned", header: "Returned within 90 days", kind: "count", value: (row) => row.returned },
    { key: "mature", header: "Visits counted", kind: "count", value: (row) => row.mature },
    { key: "not-yet-mature", header: "Not yet mature (excluded)", kind: "count", value: (row) => row.notYetMature },
    { key: "visits", header: "Visits in period", kind: "count", value: (row) => row.visits, priority: "secondary" },
  ];
  const chartDoctors = report.doctors.filter((doctor) => doctor.returns90.returnPercent !== null);

  const years = report.clinic.cohorts.map((cohort) => cohort.year);
  const cohortRows: CohortRow[] = years.flatMap((year) => [
    ...report.clinic.cohorts.filter((cohort) => cohort.year === year).map((cohort) => ({ ...clinic, ...cohort, key: `clinic:${year}` })),
    ...doctors.flatMap(({ figures, ...who }) =>
      figures.cohorts.filter((cohort) => cohort.year === year).map((cohort) => ({ ...who, ...cohort, key: `${who.key}:${year}` })),
    ),
  ]);
  const cohortColumns: DataTableColumn<CohortRow>[] = [
    whoColumn<CohortRow>(),
    { key: "year", header: "Cohort year", kind: "text", value: (row) => String(row.year) },
    {
      key: "status",
      header: "Status",
      kind: "text",
      value: (row) => (row.accruing ? "Still accruing" : "Complete"),
      cell: (row) =>
        row.accruing ? (
          <Badge variant="secondary" className="font-normal" title={`${row.year + 1} is not over in the synced sales yet: more customers may still come back`}>
            Still accruing
          </Badge>
        ) : (
          "Complete"
        ),
    },
    { key: "customers", header: "Cohort size", kind: "count", value: (row) => row.customers },
    { key: "retained-any-percent", header: "Retention (any doctor)", kind: "percent", value: (row) => row.retainedAnyDoctorPercent },
    { key: "retained-same-percent", header: "Retention (same doctor)", kind: "percent", value: (row) => row.retainedSameDoctorPercent },
    { key: "retained-any", header: "Back next year (any doctor)", kind: "count", value: (row) => row.retainedAnyDoctor, priority: "secondary" },
    { key: "retained-same", header: "Back next year (same doctor)", kind: "count", value: (row) => row.retainedSameDoctor, priority: "secondary" },
  ];

  const pendingOne = report.pendingInvoices === 1;
  return (
    <PageShell
      title="Retention"
      description="New vs returning customers, yearly cohorts and 90-day return rates per doctor, counted in service visits."
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Retention figures" icon={Repeat} />
      ) : (
        <>
          {report.syncedThrough && report.historyFrom ? (
            <p className="text-sm text-muted-foreground" data-testid="retention-synced-through">
              Sales synced from <span className="font-medium text-foreground">{formatIsoDate(report.historyFrom)}</span> through{" "}
              <span className="font-medium text-foreground">{formatIsoDate(report.syncedThrough)}</span>
              {filter.branchIds ? " at the selected branches" : ""}. Returns are only seen up to that day.
            </p>
          ) : null}
          {report.pendingInvoices > 0 ? (
            <p data-testid="retention-pending-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              {formatCount(report.pendingInvoices)} {pendingOne ? "sale has" : "sales have"} line items not synced yet, so{" "}
              {pendingOne ? "it does" : "they do"} not count as service visits here yet. The next sync reads {pendingOne ? "it" : "them"}.
            </p>
          ) : null}

          <div className="flex min-w-0 flex-col gap-3">
            {report.limitedHistory && report.historyFrom ? (
              <p data-testid="limited-history-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                The synced sales only go back to {formatIsoDate(report.historyFrom)}, close to the start of this period, so some customers counted as
                new may have had service visits before then.
              </p>
            ) : null}
            <DataTable
              caption="New vs returning customers"
              description="Customers seen for a service visit in the period. New = their first service visit in the synced history (with any doctor) is in the period."
              columns={newVsReturningColumns}
              rows={newVsReturningRows}
              rowKey={(row) => row.key}
              export={{ name: "retention-new-vs-returning", filter }}
              empty="No service visits in this period."
              testId="new-vs-returning"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {chartDoctors.length > 0 ? (
              <div className="rounded-xl border bg-card p-3 sm:p-4">
                <HorizontalBarChart
                  title="90-day return rate by doctor"
                  valueName="Return rate"
                  testId="return-rate-chart"
                  data={chartDoctors.map((doctor) => ({
                    id: doctor.staffId,
                    label: doctor.name,
                    value: doctor.returns90.returnPercent!,
                    valueLabel: formatCell("percent", doctor.returns90.returnPercent),
                  }))}
                />
              </div>
            ) : null}
            <DataTable
              caption="90-day return rate"
              description={
                <>
                  Share of the period&apos;s service visits followed by another service visit (any doctor) 1–90 days later.
                  {report.matureThrough ? ` Visits after ${formatIsoDate(report.matureThrough)} are not yet mature and are left out.` : ""}
                </>
              }
              columns={returnsColumns}
              rows={returnsRows}
              rowKey={(row) => row.key}
              export={{ name: "retention-90-day-returns", filter }}
              empty="No service visits in this period."
              testId="returns-90"
            />
          </div>

          <DataTable
            caption="Yearly cohorts"
            description="Customers seen for a service in a calendar year who came back for a service visit the next year. By calendar year: the date range does not apply; branch and doctor filters do."
            columns={cohortColumns}
            rows={cohortRows}
            rowKey={(row) => row.key}
            export={{ name: "retention-cohorts", filter }}
            empty="No cohort yet: a year's cohort appears once the next year has started in the synced sales."
            testId="cohorts"
          />

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
