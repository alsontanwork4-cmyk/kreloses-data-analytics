import { ListChecks, ShoppingBasket } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getConsultAttachRates,
  getDataFreshness,
  getItemsPerInvoiceTrend,
  listTrendDoctors,
  METRIC_DEFINITIONS,
  type AttachFigures,
  type AttachRate,
  type AttachRateSet,
  type DoctorItemsPerInvoiceTrend,
  type MetricName,
  type TrendMonth,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { GroupedBarChart, type GroupedSeries } from "@/components/charts/grouped-bar-chart";
import { LineTrendChart } from "@/components/charts/line-trend-chart";
import { formatMonth } from "@/components/charts/month-label";
import { seriesColor, stableSeriesSlots } from "@/components/charts/series";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { EmptyState, NoSalesYet } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, formatDateRange, mergeFilterIntoSearchParams, parseFilter, withSearchParams } from "@/filters";
import { clinicNow } from "@/lib/clinic-clock";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Upsell" };

const DEFINITIONS: MetricName[] = [
  "consultInvoice",
  "attachRate",
  "diagnosticsAttach",
  "productAttach",
  "secondServiceAttach",
  "anyAddOnAttach",
  "itemsPerInvoiceTrend",
  "itemsPerInvoice",
  "pendingLineItems",
];

/** How add-ons are counted: the whole invoice (default) or only the doctor's own lines (`?addons=own`, page-specific; the filter bar keeps it). */
type AddOnView = "wholeInvoice" | "ownLines";
const OWN_LINES_PARAM = "own";

/** The three add-on kinds, in fixed order: the chart's series take slots 1–3 in this order. */
const ADD_ONS: { key: Exclude<keyof AttachFigures, "anyAddOn">; label: string }[] = [
  { key: "diagnostics", label: "Diagnostics" },
  { key: "products", label: "Products" },
  { key: "secondService", label: "Second service" },
];
const CHART_SERIES: GroupedSeries[] = ADD_ONS.map((kind, index) => ({ key: kind.key, label: kind.label, color: seriesColor(index + 1) }));

/** A row of the attach-rate table: a doctor, or all doctors together. */
interface AttachRow extends AttachRateSet {
  key: string;
  name: string;
  staffId: string | null;
  aliasOnly: boolean;
}

/** A row of the monthly items-per-invoice table. */
type ItemsRow = DoctorItemsPerInvoiceTrend;

/**
 * Upsell (spec stories 46–47): per doctor, how often consult invoices include diagnostics, products
 * or a second service (whole invoice or the doctor's own lines), and average items per invoice per
 * month — all from the Analytics Service; no maths here.
 */
export default async function UpsellPage({ searchParams }: PageProps<"/upsell">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const view: AddOnView = params.addons === OWN_LINES_PARAM ? "ownLines" : "wholeInvoice";

  const sql = getDb();
  const [freshness, rates, trend, colourOrder] = await Promise.all([
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getConsultAttachRates(sql, filter),
    // "Today" decides the current (partial) month; the e2e suite freezes it with CLINIC_NOW.
    getItemsPerInvoiceTrend(sql, filter, { now: clinicNow() }),
    listTrendDoctors(sql),
  ]);

  const filterQuery = filterSearchParamsOnly(params);
  const doctorHref = (staffId: string) => withSearchParams(`/doctors/${staffId}`, filterQuery);
  const viewHref = (next: AddOnView) => {
    const query = mergeFilterIntoSearchParams(params, filterState);
    if (next === "ownLines") query.set("addons", OWN_LINES_PARAM);
    else query.delete("addons");
    return withSearchParams("/upsell", query);
  };

  const attachRows: AttachRow[] = [
    ...rates.doctors.map((doctor) => ({ ...doctor, key: doctor.staffId, aliasOnly: doctor.source === "alias_only" })),
    ...(rates.doctors.length > 0 ? [{ ...rates.allDoctors, key: "all-doctors", name: "All doctors", staffId: null, aliasOnly: false }] : []),
  ];
  const figures = (row: AttachRow) => row[view];
  const rateColumn = (key: keyof AttachFigures, header: string): DataTableColumn<AttachRow>[] => [
    {
      key,
      header,
      kind: "percent",
      value: (row) => figures(row)[key].percent,
      cell: (row) => <RateCell rate={figures(row)[key]} of={row.consultInvoices} />,
    },
    { key: `${key}-invoices`, header: `${header} (consult invoices)`, kind: "count", exportOnly: true, value: (row) => figures(row)[key].invoices },
  ];
  const attachColumns: DataTableColumn<AttachRow>[] = [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => (row.staffId ? <DoctorLink href={doctorHref(row.staffId)} name={row.name} aliasOnly={row.aliasOnly} /> : row.name),
    },
    { key: "consults", header: "Consult invoices", kind: "count", value: (row) => row.consultInvoices },
    ...ADD_ONS.flatMap((kind) => rateColumn(kind.key, kind.label)),
    ...rateColumn("anyAddOn", "Any add-on"),
  ];

  // Colours by stable key over EVERY doctor, in the Trends page's order (README "Charts"), so each
  // doctor has the same colour on both pages whatever the filter shows.
  const colourRank = new Map(colourOrder.map((doctor, index) => [doctor.id, index]));
  const slots = stableSeriesSlots(
    colourOrder.map((doctor) => doctor.id),
    (a, b) => (colourRank.get(a) ?? Number.MAX_SAFE_INTEGER) - (colourRank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const monthLabel = (month: TrendMonth) => formatMonth(month.month);
  const monthHeader = (month: TrendMonth) => `${monthLabel(month)}${month.partialReason === "current_month" ? " (so far)" : month.partial ? " (part)" : ""}`;
  const itemsColumns: DataTableColumn<ItemsRow>[] = [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => <DoctorLink href={doctorHref(row.staffId)} name={row.name} aliasOnly={row.source === "alias_only"} />,
    },
    ...trend.months.flatMap((month, index): DataTableColumn<ItemsRow>[] => [
      { key: `m${month.month}`, header: monthHeader(month), kind: "decimal", value: (row) => row.points[index]!.itemsPerInvoice },
      { key: `m${month.month}-lines`, header: `${monthHeader(month)} item lines`, kind: "count", exportOnly: true, value: (row) => row.points[index]!.itemLines },
      { key: `m${month.month}-invoices`, header: `${monthHeader(month)} invoices`, kind: "count", exportOnly: true, value: (row) => row.points[index]!.invoices },
    ]),
    { key: "total", header: "Whole period", kind: "decimal", value: (row) => row.total.itemsPerInvoice },
    { key: "total-lines", header: "Whole period item lines", kind: "count", exportOnly: true, value: (row) => row.total.itemLines },
    { key: "total-invoices", header: "Whole period invoices", kind: "count", exportOnly: true, value: (row) => row.total.invoices },
  ];
  const partialNotes = trend.months
    .filter((month) => month.partial)
    .map((month) =>
      month.partialReason === "current_month"
        ? `${monthLabel(month)} is the current month: its figures are for the days so far.`
        : `${monthLabel(month)}: only ${formatDateRange(month.dateFrom, month.dateTo)} is in the date range.`,
    );
  const period = formatDateRange(filter.dateFrom, filter.dateTo);

  return (
    <PageShell title="Upsell" description="How often each doctor's consults include diagnostics, products or a second service, and items per invoice over time." filter={filterState}>
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Upsell rates" icon={ShoppingBasket} />
      ) : (
        <>
          <PendingLineItemsNote filter={filter} pending={rates.pendingLineItems} doctorsOnly />

          <section className="flex flex-col gap-3" aria-labelledby="attach-heading">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <h2 id="attach-heading" className="text-lg font-semibold">
                Consult attach rates
              </h2>
              <nav aria-label="Count add-ons on" className="flex max-w-full flex-wrap items-center gap-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Count add-ons on</span>
                <span className="inline-flex max-w-full flex-wrap rounded-lg border p-0.5">
                  {(
                    [
                      { view: "wholeInvoice", label: "Whole invoice" },
                      { view: "ownLines", label: "Doctor's own lines" },
                    ] as const
                  ).map((option) => (
                    <Link
                      key={option.view}
                      href={viewHref(option.view)}
                      scroll={false}
                      aria-current={option.view === view ? "true" : undefined}
                      className={cn("rounded-md px-3 py-1", option.view === view ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
                    >
                      {option.label}
                    </Link>
                  ))}
                </span>
              </nav>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="attach-view-note">
              {view === "wholeInvoice"
                ? "Add-ons anywhere on the consult invoice count, whoever they are credited to (the visit's basket)."
                : "Only add-ons credited to the consulting doctor count."}{" "}
              An add-on is a non-consult line that charged more than RM 0.00.
            </p>

            {rates.doctors.length === 0 ? (
              <EmptyState icon={ShoppingBasket} title="No consults in this period">
                <p>
                  No consult line was credited to a doctor in {period}
                  {filter.branchIds ? " at the selected branch" : ""}
                  {filter.doctorIds ? " for the selected doctors" : ""}.
                </p>
              </EmptyState>
            ) : (
              <>
                <div className="rounded-xl border bg-card p-3 sm:p-4">
                  <GroupedBarChart
                    title={view === "wholeInvoice" ? "Share of consult invoices with each add-on" : "Share of consult invoices with each add-on (doctor's own lines)"}
                    testId="attach-chart"
                    series={CHART_SERIES}
                    domain={[0, 100]}
                    rows={attachRows.map((row) => ({
                      id: row.key,
                      label: row.name,
                      values: Object.fromEntries(ADD_ONS.map((kind) => [kind.key, figures(row)[kind.key].percent ?? 0])),
                      valueLabels: Object.fromEntries(ADD_ONS.map((kind) => [kind.key, formatPercent(figures(row)[kind.key].percent)])),
                    }))}
                  />
                </div>
                <DataTable
                  caption={view === "wholeInvoice" ? "Attach rates on consult invoices" : "Attach rates on consult invoices (doctor's own lines)"}
                  description="Of each doctor's consult invoices, the share that also had diagnostics, a product or a second (non-consult) service; any add-on is at least one of them. All doctors: every doctor's consult invoices together (the doctor filter does not change it)."
                  columns={attachColumns}
                  rows={attachRows}
                  rowKey={(row) => row.key}
                  rowClassName={(row) => (row.staffId === null ? "bg-muted/40" : undefined)}
                  export={{ name: view === "wholeInvoice" ? "upsell-attach-rates" : "upsell-attach-rates-own-lines", filter }}
                  testId="attach-rates"
                  headingLevel={3}
                />
              </>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="items-heading">
            <h2 id="items-heading" className="text-lg font-semibold">
              Items per invoice over time
            </h2>
            {trend.months.length === 0 ? (
              <EmptyState icon={ListChecks} title="No months to show">
                <p>{period} has not started yet. Choose an earlier date range.</p>
              </EmptyState>
            ) : trend.doctors.length === 0 ? (
              <EmptyState icon={ListChecks} title="No doctor sales in this period">
                <p>
                  No line was credited to a doctor in {period}
                  {filter.branchIds ? " at the selected branch" : ""}.
                </p>
              </EmptyState>
            ) : (
              <>
                <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:p-4">
                  <LineTrendChart
                    title="Average items per invoice by doctor"
                    valueName="Items per invoice"
                    axisFormat="decimal"
                    testId="items-per-invoice-chart"
                    periods={trend.months.map((month) => ({ key: month.month, label: monthLabel(month), partial: month.partial }))}
                    series={trend.doctors.map((doctor) => ({
                      id: doctor.staffId,
                      label: doctor.name,
                      slot: slots.get(doctor.staffId) ?? null,
                      href: doctorHref(doctor.staffId),
                      values: doctor.points.map((point) => point.itemsPerInvoice),
                      valueLabels: doctor.points.map((point) => (point.itemsPerInvoice === null ? "—" : point.itemsPerInvoice.toFixed(2))),
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
                <DataTable
                  caption="Items per invoice by month"
                  description="Each doctor's credited lines ÷ the invoices with a line credited to them, per month (as on the Doctors page). The CSV also has the lines and invoices behind each figure."
                  columns={itemsColumns}
                  rows={trend.doctors}
                  rowKey={(row) => row.staffId}
                  export={{ name: "upsell-items-per-invoice", filter }}
                  testId="items-per-invoice"
                  headingLevel={3}
                />
              </>
            )}
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

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1)}%`;
}

/** An attach rate: the percentage, with the invoices behind it ("2 of 7") underneath. */
function RateCell({ rate, of }: { rate: AttachRate; of: number }) {
  if (rate.percent === null) return <>—</>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{formatPercent(rate.percent)}</span>
      <span className="text-xs text-muted-foreground">
        {formatCount(rate.invoices)} of {formatCount(of)}
      </span>
    </span>
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
