import { ArrowDownRight, ArrowUpRight, PieChart } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getDataFreshness,
  getPendingLineItems,
  getServiceLinesByDoctor,
  getServiceMix,
  getTopItemsByDoctor,
  METRIC_DEFINITIONS,
  MIX_BUCKET_LABELS,
  MIX_BUCKETS,
  type ClinicMixBucket,
  type DoctorServiceLines,
  type MetricName,
  type MixComparison,
  type MixComparisonResult,
  type MixShare,
  type ServiceLineFigures,
  type TopItem,
} from "@/analytics";
import { MIX_GROUPS } from "@/attribution";
import { hasRole } from "@/auth/roles";
import { requireUser } from "@/auth/session";
import { seriesColor } from "@/components/charts/series";
import { StackedBarChart, type StackedSeries } from "@/components/charts/stacked-bar-chart";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { NoSalesYet } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { getDb } from "@/db/client";
import { mergeFilterIntoSearchParams, parseFilter, withSearchParams } from "@/filters";
import { formatRinggit, moneyToSen, type Money } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Mix" };

const DEFINITIONS: MetricName[] = ["mixGroup", "serviceMix", "mixShare", "mixComparison", "topItems", "surgeryRevenue", "consultRevenue", "revenue", "pendingLineItems"];

/** How many top items per doctor the page offers (`?top=`). */
const TOP_CHOICES = [3, 5, 10] as const;
const DEFAULT_TOP = 5;

/** A mix row: a doctor, all doctors together (the clinic average) or the whole clinic. */
interface MixRow {
  key: string;
  name: string;
  revenue: Money;
  kind: "doctor" | "all_doctors" | "clinic";
  groups: Partial<Record<ClinicMixBucket, MixShare | MixComparison>>;
}

interface TopItemRow extends TopItem {
  key: string;
  doctor: string;
  rank: number;
}

interface ServiceLineRow extends ServiceLineFigures {
  key: string;
  name: string;
}

/** The chart's series: the eight groups in fixed palette order (colour follows the group), unmapped in a neutral. */
const MIX_SERIES: StackedSeries[] = [
  ...MIX_GROUPS.map((group, index) => ({ key: group, label: MIX_BUCKET_LABELS[group], color: seriesColor(index + 1) })),
  { key: "unmapped", label: MIX_BUCKET_LABELS.unmapped, color: "var(--muted-foreground)" },
];

/** Service mix per doctor (spec stories 40–43), from the Analytics Service; no maths here. */
export default async function MixPage({ searchParams }: PageProps<"/mix">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const top = TOP_CHOICES.find((choice) => String(choice) === params.top) ?? DEFAULT_TOP;
  const sql = getDb();
  const [freshness, mix, topItems, serviceLines, pending] = await Promise.all([
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getServiceMix(sql, filter),
    getTopItemsByDoctor(sql, filter, { limit: top }),
    getServiceLinesByDoctor(sql, filter),
    getPendingLineItems(sql, filter),
  ]);

  const topHref = (choice: number) => {
    const next = mergeFilterIntoSearchParams(params, filterState);
    if (choice === DEFAULT_TOP) next.delete("top");
    else next.set("top", String(choice));
    return withSearchParams("/mix", next);
  };

  // Clinic-only buckets appear as columns only when they hold revenue.
  const extraBuckets = (["no_item", "pending"] as const).filter((bucket) => moneyToSen(mix.clinic.groups[bucket].revenue) !== 0);
  const mixRows: MixRow[] = [
    ...mix.doctors.map((doctor): MixRow => ({ key: doctor.staffId, name: doctor.name, revenue: doctor.revenue, kind: "doctor", groups: doctor.groups })),
    ...(mix.doctors.length > 0 ? [{ key: "all-doctors", name: "All doctors (clinic average)", revenue: mix.allDoctors.revenue, kind: "all_doctors" as const, groups: mix.allDoctors.groups }] : []),
    { key: "clinic", name: "Whole clinic", revenue: mix.clinic.revenue, kind: "clinic", groups: mix.clinic.groups },
  ];
  const buckets: ClinicMixBucket[] = [...MIX_BUCKETS, ...extraBuckets];

  const revenueColumns: DataTableColumn<MixRow>[] = [
    { key: "name", header: "Doctor", kind: "text", value: (row) => row.name },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    ...buckets.map(
      (bucket): DataTableColumn<MixRow> => ({ key: bucket, header: MIX_BUCKET_LABELS[bucket], kind: "money", value: (row) => row.groups[bucket]?.revenue ?? null }),
    ),
  ];
  const shareColumns: DataTableColumn<MixRow>[] = [
    { key: "name", header: "Doctor", kind: "text", value: (row) => row.name },
    ...MIX_BUCKETS.map(
      (bucket): DataTableColumn<MixRow> => ({
        key: bucket,
        header: MIX_BUCKET_LABELS[bucket],
        kind: "percent",
        value: (row) => row.groups[bucket]?.sharePercent ?? null,
        cell: (row) => <ShareCell cell={row.groups[bucket]} />,
      }),
    ),
    // The CSV also has what each cell marks: the difference from all doctors and above / below / in line.
    ...MIX_BUCKETS.flatMap((bucket): DataTableColumn<MixRow>[] => [
      {
        key: `${bucket}-difference`,
        header: `${MIX_BUCKET_LABELS[bucket]} vs average (points)`,
        kind: "decimal",
        exportOnly: true,
        value: (row) => comparisonOf(row.groups[bucket])?.differencePoints ?? null,
      },
      {
        key: `${bucket}-comparison`,
        header: `${MIX_BUCKET_LABELS[bucket]} vs average`,
        kind: "text",
        exportOnly: true,
        value: (row) => {
          const comparison = comparisonOf(row.groups[bucket])?.comparison;
          return comparison ? COMPARISON_LABELS[comparison] : null;
        },
      },
    ]),
  ];

  const topRows: TopItemRow[] = topItems.doctors.flatMap((doctor) =>
    doctor.items.map((item, index) => ({ ...item, key: `${doctor.staffId}:${item.itemKey}`, doctor: doctor.name, rank: index + 1 })),
  );
  const topColumns: DataTableColumn<TopItemRow>[] = [
    { key: "doctor", header: "Doctor", kind: "text", value: (row) => row.doctor },
    { key: "rank", header: "#", kind: "count", value: (row) => row.rank },
    { key: "item", header: "Item", kind: "text", value: (row) => row.name },
    { key: "group", header: "Group", kind: "text", value: (row) => MIX_BUCKET_LABELS[row.group] },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    { key: "share", header: "Share of doctor's revenue", kind: "percent", value: (row) => row.sharePercent },
    { key: "lines", header: "Lines", kind: "count", value: (row) => row.lines, priority: "secondary" },
    { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices, priority: "secondary" },
  ];

  const serviceRows: ServiceLineRow[] = [
    ...serviceLines.doctors.map((doctor: DoctorServiceLines) => ({ ...doctor, key: doctor.staffId })),
    { ...serviceLines.total, key: "total", name: filter.doctorIds ? "Selected doctors" : "All revenue" },
  ];
  const serviceColumns: DataTableColumn<ServiceLineRow>[] = [
    { key: "name", header: "Doctor", kind: "text", value: (row) => row.name },
    { key: "surgery", header: "Surgery revenue", kind: "money", value: (row) => row.surgeryRevenue },
    { key: "surgery-share", header: "Surgery share", kind: "percent", value: (row) => row.surgerySharePercent },
    { key: "consult", header: "Consult revenue", kind: "money", value: (row) => row.consultRevenue },
    { key: "consult-share", header: "Consult share", kind: "percent", value: (row) => row.consultSharePercent },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue, priority: "secondary" },
  ];
  const unmapped = mix.clinic.groups.unmapped.revenue;
  const hasUnmapped = moneyToSen(unmapped) !== 0;

  return (
    <PageShell title="Mix" description="Revenue by service group per doctor, compared with the clinic average; top items; surgery and consult revenue." filter={filterState}>
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Service mix" icon={PieChart} />
      ) : (
        <>
          <PendingLineItemsNote filter={filter} pending={pending} />
          {hasUnmapped ? (
            <p data-testid="unmapped-note" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              {formatRinggit(unmapped)} in this period is on items no rule recognises (“Unmapped”).{" "}
              {hasRole(user, "owner") ? (
                <Link href={withSearchParams("/settings/items", mergeFilterIntoSearchParams({}, filterState))} className="font-medium text-foreground underline underline-offset-4">
                  Assign them to a group
                </Link>
              ) : (
                "The clinic owner can assign them to a group in Settings."
              )}
            </p>
          ) : null}

          {mix.doctors.length > 0 ? (
            <div className="rounded-xl border bg-card p-3 sm:p-4">
              <StackedBarChart
                title="Revenue by service group"
                testId="mix-chart"
                series={MIX_SERIES}
                rows={mix.doctors.map((doctor) => ({
                  id: doctor.staffId,
                  label: doctor.name,
                  values: Object.fromEntries(MIX_BUCKETS.map((bucket) => [bucket, Number(doctor.groups[bucket].revenue)])),
                  valueLabels: Object.fromEntries(MIX_BUCKETS.map((bucket) => [bucket, formatRinggit(doctor.groups[bucket].revenue)])),
                  totalLabel: formatRinggit(doctor.revenue),
                }))}
              />
            </div>
          ) : null}

          <DataTable
            caption="Revenue by service group"
            description="Each doctor's revenue split by the group of each line's item. Groups add up to revenue; the whole clinic also includes other staff, lines with no staff and sales not synced yet."
            columns={revenueColumns}
            rows={mixRows}
            rowKey={(row) => row.key}
            rowClassName={(row) => (row.kind === "doctor" ? undefined : "bg-muted/40")}
            export={{ name: "mix-revenue", filter }}
            testId="mix-revenue"
          />

          <DataTable
            caption="Mix compared with the clinic average"
            description={`Each group's share of the doctor's revenue, and how far it is from all doctors together (percentage points); an arrow marks a share at least ${mix.thresholdPoints} points above (↗) or below (↘) that average.`}
            columns={shareColumns}
            rows={mixRows.filter((row) => row.kind !== "clinic")}
            rowKey={(row) => row.key}
            rowClassName={(row) => (row.kind === "doctor" ? undefined : "bg-muted/40")}
            export={{ name: "mix-share", filter }}
            empty="No revenue was credited to a doctor in this period."
            testId="mix-share"
          />

          <DataTable
            caption="Surgery and consult revenue"
            description="Surgery and consult lines per doctor, and each as a share of the doctor's revenue."
            columns={serviceColumns}
            rows={serviceRows}
            rowKey={(row) => row.key}
            rowClassName={(row) => (row.key === "total" ? "bg-muted/40" : undefined)}
            export={{ name: "surgery-consult", filter }}
            testId="service-lines"
          />

          <div className="flex flex-col gap-2">
            <nav aria-label="Top items per doctor" className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
              {TOP_CHOICES.map((choice) => (
                <Link
                  key={choice}
                  href={topHref(choice)}
                  scroll={false}
                  aria-current={choice === top ? "true" : undefined}
                  className={cn("rounded-md px-3 py-1", choice === top ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
                >
                  Top {choice}
                </Link>
              ))}
            </nav>
            <DataTable
              caption={`Top ${top} items per doctor`}
              description="Each doctor's items by the revenue credited to them."
              columns={topColumns}
              rows={topRows}
              rowKey={(row) => row.key}
              export={{ name: "top-items", filter }}
              empty="No revenue was credited to a doctor in this period."
              testId="top-items"
            />
          </div>

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

const COMPARISON_LABELS: Record<MixComparisonResult, string> = { above: "Above", below: "Below", in_line: "In line" };

/** The comparison of a doctor's cell (the all-doctors row has none). */
function comparisonOf(cell: MixShare | MixComparison | undefined): MixComparison | null {
  return cell && "comparison" in cell ? cell : null;
}

/** A share, with the difference from the clinic average marked when it is above / below the threshold. */
function ShareCell({ cell }: { cell: MixShare | MixComparison | undefined }) {
  if (!cell || cell.sharePercent === null) return <>—</>;
  const share = `${cell.sharePercent.toFixed(1)}%`;
  if (!("comparison" in cell) || cell.comparison === null || cell.differencePoints === null) return <>{share}</>;
  const points = `${cell.differencePoints > 0 ? "+" : cell.differencePoints < 0 ? "−" : "±"}${Math.abs(cell.differencePoints).toFixed(1)} pts`;
  const Icon = cell.comparison === "above" ? ArrowUpRight : cell.comparison === "below" ? ArrowDownRight : null;
  return (
    <span
      data-comparison={cell.comparison}
      title={`${points} vs all doctors (${cell.averageSharePercent?.toFixed(1)}%)`}
      className="relative inline-flex flex-col items-end leading-tight"
    >
      <span>{share}</span>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 text-xs",
          cell.comparison === "above" && "font-medium text-emerald-700 dark:text-emerald-400",
          cell.comparison === "below" && "font-medium text-destructive",
          cell.comparison === "in_line" && "text-muted-foreground",
        )}
      >
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {points}
        {/* `relative` on the cell keeps this absolutely positioned text inside the table's scroll box. */}
        <span className="sr-only">{cell.comparison === "above" ? " above average" : cell.comparison === "below" ? " below average" : " in line with average"}</span>
      </span>
    </span>
  );
}

