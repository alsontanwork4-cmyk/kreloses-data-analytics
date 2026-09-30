import { Scissors } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getDataFreshness,
  getSurgeryDepartment,
  getTopProcedures,
  getVaccineDentalRevenue,
  METRIC_DEFINITIONS,
  type MetricName,
  type SurgeryFigures,
  type TopProcedure,
  type VaccineDentalFigures,
} from "@/analytics";
import { requireUser } from "@/auth/session";
import { seriesColor } from "@/components/charts/series";
import { StackedBarChart, type StackedSeries } from "@/components/charts/stacked-bar-chart";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { getDb } from "@/db/client";
import { formatIsoDate, mergeFilterIntoSearchParams, parseFilter, withSearchParams } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit } from "@/lib/money";
import { cn } from "@/lib/utils";

import { MixTabs } from "../mix-tabs";

export const metadata: Metadata = { title: "Surgery, vaccines & dental" };

const DEFINITIONS: MetricName[] = [
  "surgeryCase",
  "surgeryOperation",
  "sedationOnlyCase",
  "surgeryFee",
  "wholeVisitValue",
  "postOpFollowUp",
  "serviceVisit",
  "syncedThrough",
  "topProcedures",
  "vaccineRevenue",
  "dentalScalingRevenue",
  "revenue",
  "pendingLineItems",
];

/** How many procedures per list the page offers (`?top=`). */
const TOP_CHOICES = [5, 10, 20] as const;
const DEFAULT_TOP = 5;

/** A row of the cases tables: a doctor, a branch, or the filter's total. */
interface CaseRow extends SurgeryFigures {
  key: string;
  name: string;
  kind: "doctor" | "branch" | "total";
}

interface ProcedureRow extends TopProcedure {
  key: string;
  doctor: string;
  rank: number;
}

interface VaccineDentalRow extends VaccineDentalFigures {
  key: string;
  name: string;
  total: boolean;
}

/** The cases chart: operations and sedation-only cases, stacked (two fixed categories: slots 1 and 2). */
const CASE_SERIES: StackedSeries[] = [
  { key: "operations", label: "Operations", color: seriesColor(1) },
  { key: "sedationOnly", label: "Sedation only", color: seriesColor(2) },
];

/** Surgery department, vaccines and dental (spec stories 44–45), from the Analytics Service; no maths here. */
export default async function MixSurgeryPage({ searchParams }: PageProps<"/mix/surgery">) {
  const user = await requireUser();
  const params = await searchParams;
  const filterState = parseFilter(params);
  const { filter } = filterState;
  const top = TOP_CHOICES.find((choice) => String(choice) === params.top) ?? DEFAULT_TOP;
  const sql = getDb();
  const [freshness, surgery, procedures, vaccinesDental] = await Promise.all([
    getDataFreshness(sql, { dateFrom: filter.dateFrom, dateTo: filter.dateTo }),
    getSurgeryDepartment(sql, filter),
    getTopProcedures(sql, filter, { limit: top }),
    getVaccineDentalRevenue(sql, filter),
  ]);

  const topHref = (choice: number) => {
    const next = mergeFilterIntoSearchParams(params, filterState);
    if (choice === DEFAULT_TOP) next.delete("top");
    else next.set("top", String(choice));
    return withSearchParams("/mix/surgery", next);
  };

  const totalName = filter.doctorIds ? "Selected doctors" : "All cases";
  const totalRow: CaseRow = { ...surgery.total, key: "total", name: totalName, kind: "total" };
  const doctorRows: CaseRow[] = [...surgery.doctors.map((doctor): CaseRow => ({ ...doctor, key: doctor.staffId, kind: "doctor" })), totalRow];
  const branchRows: CaseRow[] = [
    ...surgery.branches.map((branch): CaseRow => ({ ...branch, key: branch.branchId, name: branch.branchName, kind: "branch" })),
    ...(surgery.branches.length > 1 ? [totalRow] : []),
  ];
  const followUpRows: CaseRow[] = [
    totalRow,
    ...branchRows.filter((row) => row.kind === "branch" && row.cases > 0),
    ...doctorRows.filter((row) => row.kind === "doctor"),
  ];

  const caseColumns = (header: string): DataTableColumn<CaseRow>[] => [
    { key: "name", header, kind: "text", value: (row) => row.name },
    { key: "cases", header: "Cases", kind: "count", value: (row) => row.cases },
    { key: "operations", header: "Operations", kind: "count", value: (row) => row.operations },
    { key: "sedation-only", header: "Sedation only", kind: "count", value: (row) => row.sedationOnly },
    { key: "fees", header: "Surgery fees", kind: "money", value: (row) => row.surgeryFees },
    { key: "whole-visit", header: "Whole-visit value", kind: "money", value: (row) => row.wholeVisitValue },
    { key: "average-fee", header: "Average fee per case", label: "Avg fee", kind: "money", value: (row) => row.averageSurgeryFee },
    { key: "average-whole-visit", header: "Average whole visit per case", label: "Avg whole visit", kind: "money", value: (row) => row.averageWholeVisitValue, priority: "secondary" },
    { key: "fee-share", header: "Fees as share of whole visit", label: "Fee share", kind: "percent", value: (row) => row.surgeryFeeSharePercent, priority: "secondary" },
  ];
  const followUpColumns: DataTableColumn<CaseRow>[] = [
    { key: "name", header: "Cases of", kind: "text", value: (row) => row.name },
    { key: "rate", header: "Follow-up rate", kind: "percent", value: (row) => row.followUp.followUpPercent },
    { key: "followed-up", header: "Followed up within 14 days", label: "Followed up", kind: "count", value: (row) => row.followUp.followedUp },
    { key: "mature", header: "Cases counted", kind: "count", value: (row) => row.followUp.mature },
    { key: "not-yet-mature", header: "Not yet mature (excluded)", label: "Not yet mature", kind: "count", value: (row) => row.followUp.notYetMature },
    { key: "walk-ins", header: "Walk-ins (excluded)", label: "Walk-ins", kind: "count", value: (row) => row.followUp.withoutCustomer, priority: "secondary" },
    { key: "cases", header: "Cases", kind: "count", value: (row) => row.cases, priority: "secondary" },
  ];

  const overallRows: ProcedureRow[] = procedures.overall.map((procedure, index) => ({ ...procedure, key: procedure.itemKey, doctor: totalName, rank: index + 1 }));
  const doctorProcedureRows: ProcedureRow[] = procedures.doctors.flatMap((doctor) =>
    doctor.procedures.map((procedure, index) => ({ ...procedure, key: `${doctor.staffId}:${procedure.itemKey}`, doctor: doctor.name, rank: index + 1 })),
  );
  const procedureColumns = (withDoctor: boolean): DataTableColumn<ProcedureRow>[] => [
    ...(withDoctor ? [{ key: "doctor", header: "Doctor", kind: "text", value: (row: ProcedureRow) => row.doctor } satisfies DataTableColumn<ProcedureRow>] : []),
    // Overall, the procedure is the row header (the rows are in rank order; the CSV keeps the rank).
    { key: "rank", header: "#", kind: "count", value: (row) => row.rank, exportOnly: !withDoctor },
    { key: "procedure", header: "Procedure", kind: "text", value: (row) => row.name },
    { key: "cases", header: "Cases", kind: "count", value: (row) => row.cases },
    { key: "fees", header: "Fees", kind: "money", value: (row) => row.fees },
    { key: "average-fee", header: "Average fee", kind: "money", value: (row) => row.averageFee },
  ];

  const vaccineRows: VaccineDentalRow[] = [
    ...vaccinesDental.doctors.map((doctor) => ({ ...doctor, key: doctor.staffId, total: false })),
    { ...vaccinesDental.total, key: "total", name: filter.doctorIds ? "Selected doctors" : "All revenue", total: true },
  ];
  const vaccineColumns: DataTableColumn<VaccineDentalRow>[] = [
    { key: "name", header: "Doctor", kind: "text", value: (row) => row.name },
    { key: "vaccine", header: "Vaccine revenue", kind: "money", value: (row) => row.vaccineRevenue },
    { key: "vaccine-share", header: "Vaccine share", kind: "percent", value: (row) => row.vaccineSharePercent },
    { key: "dental", header: "Dental-scaling revenue", kind: "money", value: (row) => row.dentalScalingRevenue },
    { key: "dental-share", header: "Dental-scaling share", kind: "percent", value: (row) => row.dentalScalingSharePercent },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue, priority: "secondary" },
  ];

  const pending = surgery.pendingLineItems;
  const pendingOne = pending.invoices === 1;
  // Sales but no case in the filter: the case tables show their empty message, not a row of zeros.
  const noCases = surgery.total.cases === 0;
  const NO_CASES = "No surgery cases in this period.";
  // Total rows are shaded; in the follow-up table (whole filter, branches, then doctors) the branch subtotals too.
  const totalShade = (row: { kind?: CaseRow["kind"]; total?: boolean }) => (row.kind === "total" || row.total ? "bg-muted/40" : undefined);
  const subtotalShade = (row: CaseRow) => (row.kind === "total" || row.kind === "branch" ? "bg-muted/40" : undefined);

  return (
    <PageShell
      title="Mix"
      description="Surgery cases (operations vs sedation only), surgery fee vs whole-visit value, top procedures and post-op follow-up; vaccine and dental-scaling revenue."
      filter={filterState}
    >
      <MixTabs current="surgery" params={params} />
      {freshness.length === 0 ? (
        <NoSalesYet user={user} filter={filter} what="Surgery, vaccine and dental figures" icon={Scissors} />
      ) : (
        <>
          {pending.invoices > 0 ? (
            <p data-testid="surgery-pending-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              {formatCount(pending.invoices)} {pendingOne ? "sale" : "sales"} in this period ({formatRinggit(pending.revenue)}) {pendingOne ? "has" : "have"} line items
              not synced yet, so any surgery case, vaccine or dental scaling on {pendingOne ? "it is" : "them is"} not counted here yet. The next sync reads{" "}
              {pendingOne ? "it" : "them"}.
            </p>
          ) : null}

          <section aria-labelledby="surgery-heading" className="flex min-w-0 flex-col gap-5">
            <div>
              <h2 id="surgery-heading" className="text-lg font-semibold tracking-tight">
                Surgery
              </h2>
              <p className="text-sm text-muted-foreground">
                A case is a sale with a surgery line; an operation has an actual procedure, otherwise it is sedation only. A case counts for every doctor
                with a surgery line on it.
              </p>
            </div>

            {surgery.doctors.length > 0 ? (
              <div className="rounded-xl border bg-card p-3 sm:p-4">
                <StackedBarChart
                  title="Surgery cases by doctor"
                  testId="surgery-cases-chart"
                  series={CASE_SERIES}
                  rows={surgery.doctors.map((doctor) => ({
                    id: doctor.staffId,
                    label: doctor.name,
                    values: { operations: doctor.operations, sedationOnly: doctor.sedationOnly },
                    valueLabels: { operations: formatCount(doctor.operations), sedationOnly: formatCount(doctor.sedationOnly) },
                    totalLabel: `${formatCount(doctor.cases)} ${doctor.cases === 1 ? "case" : "cases"}`,
                  }))}
                />
              </div>
            ) : null}

            <DataTable
              caption="Surgery cases by doctor"
              description="Surgery fees are the doctor's own surgery lines on their cases; the whole-visit value is everything on those sales, whoever it is credited to."
              columns={caseColumns("Doctor")}
              rows={noCases ? [] : doctorRows}
              rowKey={(row) => row.key}
              rowClassName={totalShade}
              export={{ name: "surgery-cases-by-doctor", filter }}
              empty={NO_CASES}
              testId="surgery-doctors"
              headingLevel={3}
            />

            <DataTable
              caption="Surgery cases by branch"
              description="Every case once, at the branch of its sale."
              columns={caseColumns("Branch")}
              rows={noCases ? [] : branchRows}
              rowKey={(row) => row.key}
              rowClassName={totalShade}
              export={{ name: "surgery-cases-by-branch", filter }}
              empty={NO_CASES}
              testId="surgery-branches"
              headingLevel={3}
            />

            <DataTable
              caption="Post-op follow-up within 14 days"
              description={
                <>
                  Share of cases whose customer came back for another service visit (any doctor, any branch) 1–14 days later.
                  {surgery.syncedThrough && surgery.matureThrough
                    ? ` Sales are synced through ${formatIsoDate(surgery.syncedThrough)}, so cases after ${formatIsoDate(surgery.matureThrough)} are not yet mature and are left out; walk-ins cannot be followed up.`
                    : ""}
                </>
              }
              columns={followUpColumns}
              rows={noCases ? [] : followUpRows}
              rowKey={(row) => `${row.kind}:${row.key}`}
              rowClassName={subtotalShade}
              export={{ name: "surgery-follow-up", filter }}
              empty={NO_CASES}
              testId="surgery-follow-up"
              headingLevel={3}
            />

            <div className="flex min-w-0 flex-col gap-3">
              <nav aria-label="Top procedures" className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
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
                caption={`Top ${procedures.limit} procedures`}
                description="Operations by fees (the revenue of the procedure's lines), with the cases they were sold on and the average fee per case."
                columns={procedureColumns(false)}
                rows={overallRows}
                rowKey={(row) => row.key}
                export={{ name: "top-procedures", filter }}
                empty="No operations in this period."
                testId="top-procedures"
                headingLevel={3}
              />
              <DataTable
                caption={`Top ${procedures.limit} procedures per doctor`}
                description="Each doctor's operations by the fees of the lines credited to them."
                columns={procedureColumns(true)}
                rows={doctorProcedureRows}
                rowKey={(row) => row.key}
                export={{ name: "top-procedures-by-doctor", filter }}
                empty="No operations credited to a doctor in this period."
                testId="top-procedures-by-doctor"
                headingLevel={3}
              />
            </div>
          </section>

          <DataTable
            caption="Vaccines and dental scaling"
            description="Vaccine and dental-scaling revenue per doctor, each as a share of the doctor's revenue."
            columns={vaccineColumns}
            rows={vaccineRows}
            rowKey={(row) => row.key}
            rowClassName={totalShade}
            export={{ name: "vaccines-dental", filter }}
            testId="vaccines-dental"
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
