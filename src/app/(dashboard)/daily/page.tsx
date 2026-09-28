import { CalendarDays } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  DAILY_GROUP_LABELS,
  defaultDailyDay,
  getDailySales,
  getDataFreshness,
  getPendingLineItems,
  METRIC_DEFINITIONS,
  resolveDailyDay,
  type DailyFigures,
  type DailyMetric,
  type MetricName,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { EmptyState, NoSalesYet } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { clinicToday, formatClinicDateTime, mergeFilterIntoSearchParams, parseFilter, serializeFilter, withSearchParams, type IsoDate } from "@/filters";
import { clinicNow } from "@/lib/clinic-clock";
import { formatCount } from "@/lib/format";
import { formatRinggit, type Money } from "@/lib/money";

import { ChangeCell, DailyTile } from "./change";
import { DayPicker } from "./day-picker";
import { formatDayWithWeekday, type ComparisonName } from "./format";

export const metadata: Metadata = { title: "Daily" };

const DEFINITIONS: MetricName[] = [
  "dailySales",
  "sameWeekdayLastWeek",
  "sameDateLastYear",
  "revenue",
  "invoices",
  "customers",
  "aovPerCustomer",
  "change",
  "otherStaff",
  "genericAccounts",
  "noStaffOnLine",
  "pendingLineItems",
  "dataAsOf",
];

/** A row of the "By branch" table. */
interface BranchRow extends DailyFigures {
  key: string;
  name: string;
  dataAsOf: Date | null;
}

/** A row of the "By doctor" table: a doctor, or one of the groups never ranked with doctors. */
interface StaffRow extends DailyFigures {
  key: string;
  name: string;
  /** Set for doctors (links to their page). */
  staffId: string | null;
  aliasOnly: boolean;
}

/**
 * The morning review (spec stories 53–54): one clinic day — yesterday by default, `?day=` otherwise —
 * by branch and by doctor, compared with the same weekday last week and the same date last year.
 * Every figure comes from the Analytics Service (`getDailySales`); no maths here. The global
 * filter's branch and doctor apply; its date range does not (the page says so).
 */
export default async function DailyPage({ searchParams }: PageProps<"/daily">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const now = clinicNow();
  const day = resolveDailyDay(params.day, now);
  const yesterday = defaultDailyDay(now);
  const dayFilter = { ...filter, dateFrom: day, dateTo: day };

  const sql = getDb();
  // Freshness for every branch (so "nothing synced yet" is told apart from a branch filter that matches nothing).
  const [daily, freshness, pending] = await Promise.all([
    getDailySales(sql, day, filter),
    getDataFreshness(sql, { dateFrom: day, dateTo: day }),
    getPendingLineItems(sql, dayFilter),
  ]);
  const dataAsOf = new Map(freshness.map((branch) => [branch.branchId, branch.dataAsOf]));
  const { lastWeek, lastYear } = daily.comparisonDays;

  // Links from a doctor to their page keep the branch and doctor, for this day only.
  const doctorQuery = serializeFilter({ range: "custom", filter: dayFilter });
  const pickerParams = mergeFilterIntoSearchParams(params, filterState);

  const branchRows: BranchRow[] = daily.branches.map((branch) => ({
    ...branch,
    key: branch.branchId,
    name: branch.branchName,
    dataAsOf: dataAsOf.get(branch.branchId) ?? null,
  }));
  const branchColumns: DataTableColumn<BranchRow>[] = [
    {
      key: "branch",
      header: "Branch",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span>{row.name}</span>
          <span data-testid="branch-data-as-of" className="text-xs font-normal text-muted-foreground">
            {row.dataAsOf ? `Data as of ${formatClinicDateTime(row.dataAsOf)}` : "Not synced up to this day yet"}
          </span>
        </span>
      ),
    },
    ...figureColumns<BranchRow>({ lastWeek, lastYear }),
  ];

  const staffRows: StaffRow[] = [
    ...daily.doctors.map((doctor) => ({ ...doctor, key: doctor.staffId, staffId: doctor.staffId, aliasOnly: doctor.source === "alias_only" })),
    ...daily.groups.map((group) => ({ ...group, key: group.group, name: DAILY_GROUP_LABELS[group.group], staffId: null, aliasOnly: false })),
  ];
  const staffColumns: DataTableColumn<StaffRow>[] = [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) =>
        row.staffId ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={withSearchParams(`/doctors/${row.staffId}`, doctorQuery)} className="underline-offset-4 hover:underline">
              {row.name}
            </Link>
            {row.aliasOnly ? (
              <Badge variant="outline" className="font-normal" title="Only seen on invoice lines: no Kreloses staff member matches this name">
                Not in staff list
              </Badge>
            ) : null}
          </span>
        ) : (
          <span className="font-normal text-muted-foreground italic">{row.name}</span>
        ),
    },
    ...figureColumns<StaffRow>({ lastWeek, lastYear }),
  ];

  return (
    <PageShell
      title="Daily"
      description="One day's revenue, invoices and AOV per customer by branch and doctor, compared with the same weekday last week and the same date last year."
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={dayFilter} what="Daily sales" icon={CalendarDays} />
      ) : (
        <>
          <DayPicker day={day} today={clinicToday(now)} yesterday={yesterday} params={pickerParams} />

          {daily.branches.length === 0 ? (
            <EmptyState icon={CalendarDays} title="No branch matches this filter">
              <p>Choose “All branches” in the filter bar.</p>
            </EmptyState>
          ) : (
            <>
              <section aria-labelledby="daily-day" className="flex flex-col gap-3">
                <div>
                  <h2 id="daily-day" data-testid="daily-day" className="text-lg font-semibold tracking-tight">
                    {formatDayWithWeekday(day)}
                    {day === yesterday ? <span className="ml-2 text-sm font-normal text-muted-foreground">(yesterday)</span> : null}
                  </h2>
                  <p data-testid="daily-comparison-days" className="text-xs text-muted-foreground">
                    Compared with {formatDayWithWeekday(lastWeek)} (same weekday last week) and {formatDayWithWeekday(lastYear)} (same
                    date last year).
                  </p>
                </div>
                {filter.doctorIds ? (
                  <p data-testid="doctor-filter-note" className="text-sm text-muted-foreground">
                    Showing only revenue credited to the selected {filter.doctorIds.length === 1 ? "doctor" : "doctors"}: invoices and
                    customers with at least one line credited to them.
                  </p>
                ) : null}
                <PendingLineItemsNote filter={dayFilter} pending={pending} />
                <div className="@container">
                  <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
                    <DailyTile title="Revenue" kind="money" metric={daily.total.revenue} testId="daily-revenue" />
                    <DailyTile title="AOV per customer" kind="money" metric={daily.total.aovPerCustomer} testId="daily-aov" />
                    <DailyTile title="Invoices" kind="count" metric={daily.total.invoices} testId="daily-invoices" />
                    <DailyTile title="Customers" kind="count" metric={daily.total.customers} testId="daily-customers" />
                  </div>
                </div>
              </section>

              <DataTable
                caption="By branch"
                description="Each change is against the same weekday last week and the same date last year."
                columns={branchColumns}
                rows={branchRows}
                rowKey={(row) => row.key}
                export={{ name: "daily-branches", filter: dayFilter }}
                testId="daily-branches"
              />
              <DataTable
                caption="By doctor"
                description="Doctors with sales on this day or on either comparison day, highest revenue first; other staff, generic accounts and lines with no staff below, never ranked with doctors."
                columns={staffColumns}
                rows={staffRows}
                rowKey={(row) => row.key}
                export={{ name: "daily-doctors", filter: dayFilter }}
                empty="No revenue was credited to anyone on this day or on either comparison day."
                testId="daily-doctors"
              />
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
        </>
      )}
    </PageShell>
  );
}

type AnyMetric = DailyMetric<Money> | DailyMetric<Money | null> | DailyMetric<number>;

interface MetricSpec {
  key: string;
  header: string;
  kind: "money" | "count";
  get: (figures: DailyFigures) => AnyMetric;
  /** How the value and its two changes show: `primary` always; `secondary` from `sm` up (the CSV always has everything). */
  value: "primary" | "secondary";
  changes: "primary" | "secondary" | "export";
}

/** In display (and CSV) order. Revenue and AOV per customer are the owner's two goals, so they lead. */
const METRICS: MetricSpec[] = [
  { key: "revenue", header: "Revenue", kind: "money", get: (figures) => figures.revenue, value: "primary", changes: "primary" },
  { key: "aov", header: "AOV per customer", kind: "money", get: (figures) => figures.aovPerCustomer, value: "primary", changes: "primary" },
  { key: "invoices", header: "Invoices", kind: "count", get: (figures) => figures.invoices, value: "primary", changes: "secondary" },
  { key: "customers", header: "Customers", kind: "count", get: (figures) => figures.customers, value: "secondary", changes: "export" },
];

/**
 * Per metric: its value, then for each comparison day the base (CSV only), the change (shown with
 * its percentage, see `ChangeCell`) and the percentage (CSV only), so the CSV has every number.
 */
function figureColumns<Row extends DailyFigures>(days: Record<"lastWeek" | "lastYear", IsoDate>): DataTableColumn<Row>[] {
  return METRICS.flatMap((metric): DataTableColumn<Row>[] => {
    const comparison = (period: "lastWeek" | "lastYear", against: ComparisonName): DataTableColumn<Row>[] => {
      const slug = against.replace(" ", "-");
      const base = (row: Row) => metric.get(row)[period].base;
      return [
        { key: `${metric.key}-${slug}`, header: `${metric.header} ${against}`, kind: metric.kind, value: base, exportOnly: true },
        {
          key: `${metric.key}-vs-${slug}`,
          header: `${metric.header} vs ${against}`,
          // Right after its metric's column, so the screen says just "vs last week" (screen readers get the metric too;
          // `relative` keeps the visually hidden text inside the table's scroll box on a phone).
          label: (
            <span className="relative">
              <span className="sr-only">{metric.header} </span>vs {against}
            </span>
          ),
          kind: metric.kind,
          value: (row) => metric.get(row)[period].change,
          cell: (row) => (
            <ChangeCell
              metric={metric.get(row)}
              kind={metric.kind}
              against={against}
              title={`${formatDayWithWeekday(days[period])}: ${formatBase(metric.kind, base(row))}`}
            />
          ),
          priority: metric.changes === "secondary" ? "secondary" : "primary",
          exportOnly: metric.changes === "export",
        },
        {
          key: `${metric.key}-vs-${slug}-percent`,
          header: `${metric.header} vs ${against}`,
          kind: "percent",
          value: (row) => metric.get(row)[period].changePercent,
          exportOnly: true,
        },
      ];
    };
    return [
      { key: metric.key, header: metric.header, kind: metric.kind, value: (row) => metric.get(row).value, priority: metric.value },
      ...comparison("lastWeek", "last week"),
      ...comparison("lastYear", "last year"),
    ];
  });
}

function formatBase(kind: "money" | "count", value: Money | number | null): string {
  if (value === null) return "no customers";
  return kind === "money" ? formatRinggit(value as Money) : formatCount(value as number);
}
