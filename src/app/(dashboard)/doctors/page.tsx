import { Stethoscope } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getDataFreshness,
  getDoctorRanking,
  getPendingLineItems,
  getRevenuePerWorkingDay,
  METRIC_DEFINITIONS,
  type MetricName,
  type StaffFigures,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { HorizontalBarChart } from "@/components/charts/horizontal-bar-chart";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { NoSalesYet } from "@/components/empty-state";
import { PendingLineItemsNote } from "@/components/pending-line-items-note";
import { PageShell } from "@/components/shell/page-shell";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, mergeFilterIntoSearchParams, parseFilter, withSearchParams } from "@/filters";
import { formatRinggit } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Doctors" };

/** A ranking row as the table shows it: a doctor, or (split by branch) a doctor at one branch. */
interface RankingRow extends StaffFigures {
  key: string;
  staffId: string;
  name: string;
  aliasOnly: boolean;
  branchName?: string;
  /** Days with a consult or surgery line at either branch (#9). */
  workingDays: number | null;
  revenuePerWorkingDay: string | null;
}

/** A row of the "not in the ranking" table. */
interface GroupRow extends StaffFigures {
  key: string;
  creditedTo: string;
  group: string;
}

const DEFINITIONS: MetricName[] = [
  "doctorRanking",
  "revenue",
  "creditedLine",
  "aovPerCustomer",
  "invoices",
  "itemsPerInvoice",
  "sharePercent",
  "doctor",
  "otherStaff",
  "genericAccounts",
  "noStaffOnLine",
  "pendingLineItems",
  "workingDay",
  "revenuePerWorkingDay",
];

/** Doctor ranking (spec stories 31–34) from the Analytics Service; no maths here. */
export default async function DoctorsPage({ searchParams }: PageProps<"/doctors">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const splitByBranch = params.split === "branch";
  const sql = getDb();
  const [ranking, freshness, pending, workingDays] = await Promise.all([
    getDoctorRanking(sql, filter, { splitByBranch }),
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getPendingLineItems(sql, filter),
    getRevenuePerWorkingDay(sql, filter, { splitByBranch }),
  ]);

  const filterQuery = filterSearchParamsOnly(params);
  const splitHref = (split: boolean) => {
    const next = mergeFilterIntoSearchParams(params, filterState);
    if (split) next.set("split", "branch");
    else next.delete("split");
    return withSearchParams("/doctors", next);
  };

  const rankingRows = ranking.doctors.flatMap((doctor): RankingRow[] => {
    const days = workingDays[doctor.staffId];
    const base = { staffId: doctor.staffId, name: doctor.name, aliasOnly: doctor.source === "alias_only", workingDays: days?.workingDays ?? 0 };
    return splitByBranch
      ? (doctor.branches ?? []).map((branch) => ({
          ...branch,
          ...base,
          key: `${doctor.staffId}:${branch.branchId}`,
          branchName: branch.branchName,
          revenuePerWorkingDay: days?.branches?.find((row) => row.branchId === branch.branchId)?.revenuePerWorkingDay ?? null,
        }))
      : [{ ...doctor, ...base, key: doctor.staffId, revenuePerWorkingDay: days?.revenuePerWorkingDay ?? null }];
  });
  const rankingColumns: DataTableColumn<RankingRow>[] = [
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
    ...(splitByBranch ? [{ key: "branch", header: "Branch", kind: "text" as const, value: (row: RankingRow) => row.branchName ?? "" }] : []),
    ...figureColumns<RankingRow>(),
    // Working days are counted at any branch, so split by branch every row of a doctor repeats the same count.
    { key: "working-days", header: splitByBranch ? "Working days (any branch)" : "Working days", kind: "count", value: (row) => row.workingDays, priority: "secondary" },
    { key: "per-working-day", header: "Revenue per working day", kind: "money", value: (row) => row.revenuePerWorkingDay },
  ];

  const groupRows: GroupRow[] = [
    ...ranking.groups.other.members.map((member) => ({ ...member, key: `other:${member.staffId}`, creditedTo: member.name, group: "Other staff" })),
    ...ranking.groups.generic.members.map((member) => ({ ...member, key: `generic:${member.staffId}`, creditedTo: member.name, group: "Generic account" })),
    ...(ranking.groups.noStaff.invoices > 0 ? [{ ...ranking.groups.noStaff, key: "no-staff", creditedTo: "No staff on line", group: "—" }] : []),
    ...(ranking.groups.pending.invoices > 0
      ? [{ ...ranking.groups.pending, key: "pending", creditedTo: "Line items not synced yet", group: "—" }]
      : []),
  ];
  const groupColumns: DataTableColumn<GroupRow>[] = [
    { key: "credited-to", header: "Credited to", kind: "text", value: (row) => row.creditedTo },
    { key: "group", header: "Group", kind: "text", value: (row) => row.group },
    ...figureColumns<GroupRow>(),
  ];

  return (
    <PageShell
      title="Doctors"
      description="Revenue, AOV per customer, invoices, items per invoice and share of revenue for each doctor, by branch."
      filter={filterState}
    >
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Doctor rankings" icon={Stethoscope} />
      ) : (
        <>
          <PendingLineItemsNote filter={filter} pending={pending} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="total-revenue">
              All revenue in this period{filter.branchIds ? " and branch" : ""}:{" "}
              <span className="font-medium text-foreground tabular-nums">{formatRinggit(ranking.totalRevenue)}</span>
            </p>
            <nav aria-label="Ranking layout" className="inline-flex rounded-lg border p-0.5 text-sm">
              {[
                { split: false, label: "All branches together" },
                { split: true, label: "Split by branch" },
              ].map((option) => (
                <Link
                  key={option.label}
                  href={splitHref(option.split)}
                  scroll={false}
                  aria-current={option.split === splitByBranch ? "true" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1",
                    option.split === splitByBranch ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {option.label}
                </Link>
              ))}
            </nav>
          </div>

          {ranking.doctors.length > 0 ? (
            <div className="rounded-xl border bg-card p-3 sm:p-4">
              <HorizontalBarChart
                title="Revenue by doctor"
                valueName="Revenue"
                testId="doctor-revenue-chart"
                data={ranking.doctors.map((doctor) => ({
                  id: doctor.staffId,
                  label: doctor.name,
                  value: Number(doctor.revenue),
                  valueLabel: formatRinggit(doctor.revenue),
                }))}
              />
            </div>
          ) : null}

          <DataTable
            caption={splitByBranch ? "Doctor ranking by branch" : "Doctor ranking"}
            description={`Highest revenue first. Share is of all revenue in the period and branches. Working days are days with a consult or surgery line at either branch${filter.branchIds || splitByBranch ? ", so revenue per working day is this branch's revenue per day worked anywhere" : ""}.`}
            columns={rankingColumns}
            rows={rankingRows}
            rowKey={(row) => row.key}
            export={{ name: splitByBranch ? "doctors-by-branch" : "doctors", filter }}
            empty="No revenue was credited to a doctor in this period."
            testId="doctor-ranking"
          />

          <DataTable
            caption="Not in the ranking"
            description="Non-doctor staff, generic accounts and lines with no staff are kept apart so they never mix with doctors."
            columns={groupColumns}
            rows={groupRows}
            rowKey={(row) => row.key}
            export={{ name: "doctors-other-groups", filter }}
            empty="All revenue in this period was credited to doctors."
            testId="staff-groups"
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

/** The metric columns shared by both tables (same order, same CSV headers). */
function figureColumns<Row extends StaffFigures>(): DataTableColumn<Row>[] {
  return [
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    { key: "share", header: "Share of revenue", kind: "percent", value: (row) => row.sharePercent },
    { key: "aov", header: "AOV per customer", kind: "money", value: (row) => row.aovPerCustomer },
    { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices },
    { key: "items", header: "Items per invoice", kind: "decimal", value: (row) => row.itemsPerInvoice },
    { key: "customers", header: "Customers", kind: "count", value: (row) => row.customers, priority: "secondary" },
  ];
}
