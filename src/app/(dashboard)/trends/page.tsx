import { TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  availableTrendMeasures,
  getDataFreshness,
  getMonthlyTrends,
  getPendingLineItems,
  getYearOnYear,
  listTrendDoctors,
  METRIC_DEFINITIONS,
  type MetricName,
  type TrendMeasure,
  type TrendMonth,
  type YearColumn,
  type YearOnYearRow,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { LineTrendChart } from "@/components/charts/line-trend-chart";
import { formatMonth } from "@/components/charts/month-label";
import { stableSeriesSlots } from "@/components/charts/series";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { EmptyState, NoSalesYet } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import {
  filterSearchParamsOnly,
  formatDateRange,
  formatIsoDate,
  mergeFilterIntoSearchParams,
  parseFilter,
  withSearchParams,
  type FilterState,
  type GlobalFilter,
} from "@/filters";
import { listBranchOptions } from "@/filters/options";
import { formatPercentChange } from "@/lib/format";
import { formatRinggit, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Trends" };

/** `?measure=` values (a page-specific param; the filter bar keeps it). Absent = revenue. */
const MEASURE_PARAMS: Record<TrendMeasure, string> = {
  revenue: "revenue",
  aovPerCustomer: "aov",
  surgeryRevenue: "surgery",
  consultRevenue: "consult",
};

const CHART_TITLES: Record<TrendMeasure, string> = {
  revenue: "Monthly revenue by doctor",
  aovPerCustomer: "Monthly AOV per customer by doctor",
  surgeryRevenue: "Monthly surgery revenue by doctor",
  consultRevenue: "Monthly consult revenue by doctor",
};

const DEFINITIONS: MetricName[] = ["monthlyTrend", "yearOnYear", "revenue", "aovPerCustomer", "doctor", "pendingLineItems"];

/** One doctor's row of the monthly table: the selected measure per month (and over the whole period). */
interface MonthlyRow {
  staffId: string;
  name: string;
  aliasOnly: boolean;
  values: (Money | null)[];
  total: Money | null;
}

/**
 * Trends (spec stories 37–39): monthly figures per doctor as a line chart with toggleable series, a
 * measure switch and a branch switch (both URL state), and year on year per doctor and branch —
 * all from the Analytics Service; no maths here.
 */
export default async function TrendsPage({ searchParams }: PageProps<"/trends">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const measures = availableTrendMeasures();
  const requested = typeof params.measure === "string" ? params.measure : undefined;
  const measure = measures.find((info) => MEASURE_PARAMS[info.measure] === requested) ?? measures[0]!;

  const sql = getDb();
  const [trends, yoy, freshness, pending, colourOrder, branches] = await Promise.all([
    getMonthlyTrends(sql, filter),
    getYearOnYear(sql, filter),
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getPendingLineItems(sql, filter),
    listTrendDoctors(sql),
    listBranchOptions(),
  ]);

  const filterQuery = filterSearchParamsOnly(params);
  const doctorHref = (staffId: string) => withSearchParams(`/doctors/${staffId}`, filterQuery);
  const measureHref = (next: TrendMeasure) => {
    const query = mergeFilterIntoSearchParams(params, filterState);
    if (next === "revenue") query.delete("measure");
    else query.set("measure", MEASURE_PARAMS[next]);
    return withSearchParams("/trends", query);
  };
  const withBranches = (branchIds: string[] | undefined): FilterState => {
    const next: GlobalFilter = { dateFrom: filter.dateFrom, dateTo: filter.dateTo, ...(filter.doctorIds ? { doctorIds: filter.doctorIds } : {}) };
    return { range: filterState.range, filter: branchIds ? { ...next, branchIds } : next };
  };
  const branchHref = (branchIds: string[] | undefined) => withSearchParams("/trends", mergeFilterIntoSearchParams(params, withBranches(branchIds)));
  const oneBranch = filter.branchIds?.length === 1 ? filter.branchIds[0] : undefined;

  // Colours by stable key over EVERY doctor (README "Charts"), active Kreloses-listed doctors first so
  // they get the 8 colours; a line past the 8th is drawn in a neutral colour (lines are not summed).
  const colourRank = new Map(colourOrder.map((doctor, index) => [doctor.id, index]));
  const slots = stableSeriesSlots(
    colourOrder.map((doctor) => doctor.id),
    (a, b) => (colourRank.get(a) ?? Number.MAX_SAFE_INTEGER) - (colourRank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const monthLabel = (month: TrendMonth) => formatMonth(month.month);
  const rows: MonthlyRow[] = trends.doctors.map((doctor) => ({
    staffId: doctor.staffId,
    name: doctor.name,
    aliasOnly: doctor.source === "alias_only",
    values: doctor.points.map((point) => point[measure.measure]),
    total: doctor.total[measure.measure],
  }));
  const monthlyColumns: DataTableColumn<MonthlyRow>[] = [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => <DoctorLink href={doctorHref(row.staffId)} name={row.name} aliasOnly={row.aliasOnly} />,
    },
    ...trends.months.map(
      (month, index): DataTableColumn<MonthlyRow> => ({
        key: `m${month.month}`,
        header: `${monthLabel(month)}${month.partialReason === "current_month" ? " (so far)" : month.partial ? " (part)" : ""}`,
        kind: "money",
        value: (row) => row.values[index] ?? null,
      }),
    ),
    { key: "total", header: "Whole period", kind: "money", value: (row) => row.total },
  ];
  const partialNotes = trends.months
    .filter((month) => month.partial)
    .map((month) =>
      month.partialReason === "current_month"
        ? `${monthLabel(month)} is the current month: its figures are for the days so far.`
        : `${monthLabel(month)}: only ${formatDateRange(month.dateFrom, month.dateTo)} is in the date range.`,
    );

  const yoyColumns = yearOnYearColumns(yoy.years, doctorHref, filter.branchIds ? "Selected branches" : "All branches");
  // The year-on-year table covers whole years whatever the date range: its CSV is named after them.
  const yoyRange = yoy.years.length > 0 ? { dateFrom: yoy.years[0]!.dateFrom, dateTo: yoy.years.at(-1)!.dateTo } : filter;

  return (
    <PageShell
      title="Trends"
      description={`Monthly ${listInSentence(measures.map((info) => info.noun))} per doctor, plus year-on-year.`}
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Monthly trends" icon={TrendingUp} />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <SwitchNav
              label="Measure"
              options={measures.map((info) => ({ key: info.measure, label: info.label, href: measureHref(info.measure), current: info.measure === measure.measure }))}
            />
            {branches.length > 1 ? (
              <SwitchNav
                label="Branch"
                options={[
                  { key: "all", label: "All branches", href: branchHref(undefined), current: !filter.branchIds },
                  ...branches.map((branch) => ({ key: branch.id, label: branch.label, href: branchHref([branch.id]), current: oneBranch === branch.id })),
                ]}
              />
            ) : null}
          </div>

          <PendingLineItemsNote filter={filter} pending={pending} doctorsOnly />

          {trends.months.length === 1 ? (
            <p className="text-sm text-muted-foreground" data-testid="one-month-hint">
              This date range covers one month. For a trend, choose{" "}
              <Link
                className="font-medium text-foreground underline underline-offset-4"
                href={withSearchParams("/trends", mergeFilterIntoSearchParams(params, { range: "year-to-date", filter }))}
              >
                Year to date
              </Link>{" "}
              or a custom range.
            </p>
          ) : null}

          {trends.months.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No months to show">
              <p>{formatDateRange(filter.dateFrom, filter.dateTo)} has not started yet. Choose an earlier date range.</p>
            </EmptyState>
          ) : trends.doctors.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No doctor revenue in this period">
              <p>No revenue was credited to a doctor in {formatDateRange(filter.dateFrom, filter.dateTo)}{filter.branchIds ? " at the selected branch" : ""}.</p>
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:p-4">
              <LineTrendChart
                title={CHART_TITLES[measure.measure]}
                valueName={measure.label}
                testId="trend-chart"
                periods={trends.months.map((month) => ({ key: month.month, label: monthLabel(month), partial: month.partial }))}
                series={trends.doctors.map((doctor, index) => ({
                  id: doctor.staffId,
                  label: doctor.name,
                  slot: slots.get(doctor.staffId) ?? null,
                  href: doctorHref(doctor.staffId),
                  values: rows[index]!.values.map((value) => (value === null ? null : Number(value))),
                  valueLabels: rows[index]!.values.map((value) => (value === null ? "—" : formatRinggit(value))),
                }))}
              />
              {partialNotes.length > 0 ? (
                <div className="text-xs text-muted-foreground" data-testid="partial-months">
                  <p>Hollow points are partial months:</p>
                  <ul className="list-disc pl-5">
                    {partialNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          {trends.months.length > 0 ? (
            <DataTable
              caption={`${measure.label} by month`}
              description={
                measure.measure === "aovPerCustomer"
                  ? "Each month: the doctor's revenue that month ÷ the customers they billed that month. Whole period: over the whole date range."
                  : "Revenue credited to each doctor per month, highest total first."
              }
              columns={monthlyColumns}
              rows={rows}
              rowKey={(row) => row.staffId}
              export={{ name: `trends-${MEASURE_PARAMS[measure.measure]}`, filter }}
              empty="No revenue was credited to a doctor in this period."
              testId="trend-table"
            />
          ) : null}

          <DataTable
            caption="Year on year"
            description={
              <>
                Whole calendar years, per doctor and branch
                {yoy.years.at(-1)?.partial ? (
                  <>
                    ; {yoy.years.at(-1)!.year} so far is compared with the same dates in {yoy.years.at(-1)!.year - 1} (to{" "}
                    {formatIsoDate(yoy.years.at(-1)!.comparedWith?.dateTo ?? yoy.years.at(-1)!.dateTo)})
                  </>
                ) : null}
                . The date range does not apply to this table; the branch and doctor filters do.
              </>
            }
            columns={yoyColumns}
            rows={yoy.rows}
            rowKey={(row) => `${row.staffId}:${row.branchId ?? "all"}`}
            rowClassName={(row) => (row.branchId === null ? "bg-muted/30" : undefined)}
            export={{ name: "trends-year-on-year", filter: yoyRange }}
            empty="No revenue has been credited to a doctor yet."
            testId="year-on-year"
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

/** The year-on-year table's columns: revenue and AOV per customer per year, with the change against each year's comparison. */
function yearOnYearColumns(years: YearColumn[], doctorHref: (staffId: string) => string, combinedBranches: string): DataTableColumn<YearOnYearRow>[] {
  const change = (value: (row: YearOnYearRow) => number | null, key: string, header: string): DataTableColumn<YearOnYearRow> => ({
    key,
    header,
    kind: "percent",
    value,
    cell: (row) => <ChangeText value={value(row)} />,
  });
  return [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => <DoctorLink href={doctorHref(row.staffId)} name={row.name} aliasOnly={row.source === "alias_only"} />,
    },
    // A doctor's row for all the filter's branches together: "Selected branches" under a branch filter.
    { key: "branch", header: "Branch", kind: "text", value: (row) => row.branchName ?? combinedBranches },
    ...years.flatMap((year, index): DataTableColumn<YearOnYearRow>[] => {
      const cell = (row: YearOnYearRow) => row.years[index]!;
      const to = year.partial ? ` to ${formatIsoDate(year.dateTo).replace(/ \d{4}$/, "")}` : "";
      const base = year.comparedWith && year.partial ? `${year.year - 1}${to}` : `${year.year - 1}`;
      const compared = year.comparedWith !== null;
      return [
        { key: `rev-${year.year}`, header: `Revenue ${year.year}${to}`, kind: "money", value: (row) => cell(row).revenue },
        ...(compared && year.partial ? [{ key: `revbase-${year.year}`, header: `Revenue ${base}`, kind: "money" as const, value: (row: YearOnYearRow) => cell(row).base?.revenue ?? null }] : []),
        ...(compared ? [change((row) => cell(row).revenueChangePercent, `revchg-${year.year}`, `Revenue change vs ${base}`)] : []),
        { key: `aov-${year.year}`, header: `AOV per customer ${year.year}${to}`, kind: "money", value: (row) => cell(row).aovPerCustomer },
        ...(compared && year.partial
          ? [{ key: `aovbase-${year.year}`, header: `AOV per customer ${base}`, kind: "money" as const, value: (row: YearOnYearRow) => cell(row).base?.aovPerCustomer ?? null }]
          : []),
        ...(compared ? [change((row) => cell(row).aovChangePercent, `aovchg-${year.year}`, `AOV change vs ${base}`)] : []),
      ];
    }),
  ];
}

/** `["a", "b", "c"]` → `"a, b and c"`. */
function listInSentence(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function ChangeText({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn(value > 0 && "text-emerald-700 dark:text-emerald-400", value < 0 && "text-destructive")}>{formatPercentChange(value)}</span>
  );
}

function DoctorLink({ href, name, aliasOnly }: { href: string; name: string; aliasOnly: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Link href={href} className="underline-offset-4 hover:underline">
        {name}
      </Link>
      {aliasOnly ? (
        <Badge variant="outline" className="font-normal" title="Only seen on invoice lines: no Kreloses staff member matches this name">
          Not in staff list
        </Badge>
      ) : null}
    </span>
  );
}

/** A segmented control of links (URL state), e.g. the measure or branch switch. Wraps on a phone. */
function SwitchNav({ label, options }: { label: string; options: { key: string; label: string; href: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex max-w-full flex-wrap items-center gap-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="inline-flex max-w-full flex-wrap rounded-lg border p-0.5">
        {options.map((option) => (
          <Link
            key={option.key}
            href={option.href}
            scroll={false}
            aria-current={option.current ? "true" : undefined}
            className={cn("rounded-md px-3 py-1", option.current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {option.label}
          </Link>
        ))}
      </span>
    </nav>
  );
}
