import { BadgePercent } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getDataFreshness,
  getDiscountTypes,
  getDoctorDiscounts,
  METRIC_DEFINITIONS,
  type DiscountAppliedTo,
  type DiscountFigures,
  type DiscountTypeRow,
  type MetricName,
  type PendingLineItems,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { HorizontalBarChart } from "@/components/charts/horizontal-bar-chart";
import { formatCell } from "@/components/data-table/csv";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, parseFilter, withSearchParams } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit } from "@/lib/money";

export const metadata: Metadata = { title: "Discounts" };

/** A row of the per-doctor table. */
interface DoctorRow extends DiscountFigures {
  staffId: string;
  name: string;
  aliasOnly: boolean;
}

/** A row of the "not in the ranking" table. */
interface GroupRow extends DiscountFigures {
  key: string;
  creditedTo: string;
  group: string;
}

const APPLIED_TO: Record<DiscountAppliedTo, string | null> = {
  item: "Item",
  invoice: "Whole invoice",
  both: "Item and whole invoice",
  difference: null,
};

const DEFINITIONS: MetricName[] = [
  "discount",
  "discountRate",
  "discountedInvoices",
  "discountTypes",
  "creditedLine",
  "doctor",
  "otherStaff",
  "genericAccounts",
  "noStaffOnLine",
  "pendingLineItems",
];

/** Discounts (spec stories 51–52) from the Analytics Service; no maths here. */
export default async function DiscountsPage({ searchParams }: PageProps<"/discounts">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const sql = getDb();
  const [discounts, types, freshness] = await Promise.all([
    getDoctorDiscounts(sql, filter),
    getDiscountTypes(sql, filter),
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
  ]);
  const filterQuery = filterSearchParamsOnly(params);
  const { total } = discounts;
  const selected = filter.doctorIds ? (filter.doctorIds.length === 1 ? "the selected doctor" : "the selected doctors") : null;

  const doctorRows: DoctorRow[] = discounts.doctors.map((doctor) => ({ ...doctor, aliasOnly: doctor.source === "alias_only" }));
  const doctorColumns: DataTableColumn<DoctorRow>[] = [
    {
      key: "doctor",
      header: "Doctor",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => (
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
    },
    ...figureColumns<DoctorRow>(),
  ];

  const groupRows: GroupRow[] = [
    ...discounts.groups.other.members.map((member) => ({ ...member, key: `other:${member.staffId}`, creditedTo: member.name, group: "Other staff" })),
    ...discounts.groups.generic.members.map((member) => ({ ...member, key: `generic:${member.staffId}`, creditedTo: member.name, group: "Generic account" })),
    ...(discounts.groups.noStaff.invoices > 0 ? [{ ...discounts.groups.noStaff, key: "no-staff", creditedTo: "No staff on line", group: "—" }] : []),
  ];
  const groupColumns: DataTableColumn<GroupRow>[] = [
    { key: "credited-to", header: "Credited to", kind: "text", value: (row) => row.creditedTo },
    { key: "group", header: "Group", kind: "text", value: (row) => row.group },
    ...figureColumns<GroupRow>(),
  ];

  const typeColumns: DataTableColumn<DiscountTypeRow>[] = [
    { key: "discount", header: "Discount", kind: "text", value: (row) => row.label },
    { key: "applied-to", header: "Applied to", kind: "text", value: (row) => APPLIED_TO[row.appliedTo], priority: "secondary" },
    { key: "amount", header: "Amount", kind: "money", value: (row) => row.amount },
    { key: "share", header: "Share of discounts", kind: "percent", value: (row) => row.sharePercent },
    { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices },
    { key: "lines", header: "Lines", kind: "count", value: (row) => row.lines, priority: "secondary" },
  ];

  return (
    <PageShell
      title="Discounts"
      description="What discounting costs: each doctor's discount total, discount rate and share of invoices discounted, and the discount types used."
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Discounts" icon={BadgePercent} />
      ) : (
        <>
          <section aria-label="Totals" className="flex flex-col gap-2">
            {selected ? (
              <p data-testid="doctor-filter-note" className="text-sm text-muted-foreground">
                Showing only lines credited to {selected}, and the part of each discount that fell on them.
              </p>
            ) : null}
            <PendingDiscountsNote pending={discounts.pendingLineItems} />
            <div className="@container">
              <dl className="grid grid-cols-1 gap-3 @md:grid-cols-3">
                <StatTile testId="total-discount" title="Discounts" value={formatRinggit(total.discount)} detail={`off ${formatRinggit(total.gross)} gross`} />
                <StatTile
                  testId="total-discount-rate"
                  title="Discount rate"
                  value={formatCell("percent", total.discountRatePercent)}
                  detail="discount ÷ gross"
                />
                <StatTile
                  testId="total-discounted-invoices"
                  title="Invoices discounted"
                  value={formatCell("percent", total.discountedInvoicesPercent)}
                  detail={`${formatCount(total.discountedInvoices)} of ${formatCount(total.invoices)} ${total.invoices === 1 ? "invoice" : "invoices"} (over RM 0.05)`}
                />
              </dl>
            </div>
          </section>

          {discounts.doctors.length > 0 ? (
            <div className="rounded-xl border bg-card p-3 sm:p-4">
              <HorizontalBarChart
                title="Discount by doctor"
                valueName="Discount"
                testId="doctor-discount-chart"
                data={discounts.doctors.map((doctor) => ({
                  id: doctor.staffId,
                  label: doctor.name,
                  value: Number(doctor.discount),
                  valueLabel: formatRinggit(doctor.discount),
                }))}
              />
            </div>
          ) : null}

          <DataTable
            caption="Discounts by doctor"
            description="Highest discount first. Discount = gross (quantity × unit price) − charged, on sold lines (returns are left out); an invoice counts as discounted when the doctor's share of its discount is over RM 0.05."
            columns={doctorColumns}
            rows={doctorRows}
            rowKey={(row) => row.staffId}
            export={{ name: "discounts-by-doctor", filter }}
            empty="No lines were credited to a doctor in this period."
            testId="doctor-discounts"
          />

          <DataTable
            caption="Not in the ranking"
            description="Non-doctor staff, generic accounts and lines with no staff, kept apart from doctors."
            columns={groupColumns}
            rows={groupRows}
            rowKey={(row) => row.key}
            export={{ name: "discounts-other-groups", filter }}
            empty={
              selected
                ? `Only lines credited to ${selected} are shown.`
                : total.invoices === 0
                  ? "No sales with synced line items in this period."
                  : "All lines in this period were credited to doctors."
            }
            testId="discount-groups"
          />

          <DataTable
            caption="Discount types"
            description={
              selected
                ? `The part of each discount that fell on ${selected}${filter.doctorIds?.length === 1 ? "'s" : "'"} lines, highest first.`
                : "Every discount name used, highest amount first. The amounts add up to the total discount."
            }
            columns={typeColumns}
            rows={types.types}
            rowKey={(row) => row.key}
            export={{ name: "discount-types", filter }}
            empty="No discounts were given in this period."
            testId="discount-types"
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

/** The metric columns shared by the doctor and group tables (same order, same CSV headers). */
function figureColumns<Row extends DiscountFigures>(): DataTableColumn<Row>[] {
  return [
    { key: "discount", header: "Discount", kind: "money", value: (row) => row.discount },
    { key: "rate", header: "Discount rate", kind: "percent", value: (row) => row.discountRatePercent },
    { key: "discounted-share", header: "Invoices discounted", kind: "percent", value: (row) => row.discountedInvoicesPercent },
    { key: "discounted", header: "Discounted invoices", kind: "count", value: (row) => row.discountedInvoices, priority: "secondary" },
    { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices, priority: "secondary" },
    { key: "gross", header: "Gross", kind: "money", value: (row) => row.gross, priority: "secondary" },
    { key: "charged", header: "Charged", kind: "money", value: (row) => row.charged, priority: "secondary" },
  ];
}

function StatTile({ title, value, detail, testId }: { title: string; value: string; detail: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-4">
      <dt className="text-xs font-medium text-muted-foreground">{title}</dt>
      <dd data-testid="stat-value" className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </dd>
      <dd data-testid="stat-detail" className="text-xs text-muted-foreground">
        {detail}
      </dd>
    </div>
  );
}

/**
 * Sales whose line items are not synced yet have no known gross, so they are never in a discount
 * figure (with or without a doctor filter); say how many there are instead of hiding them.
 */
function PendingDiscountsNote({ pending }: { pending: PendingLineItems }) {
  if (pending.invoices === 0) return null;
  const one = pending.invoices === 1;
  return (
    <p data-testid="pending-line-items-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
      {formatCount(pending.invoices)} {one ? "invoice" : "invoices"} in this period ({formatRinggit(pending.revenue)}) {one ? "has" : "have"} line
      items not synced yet, so {one ? "its" : "their"} discounts are not included here. The next sync reads {one ? "it" : "them"}.
    </p>
  );
}
