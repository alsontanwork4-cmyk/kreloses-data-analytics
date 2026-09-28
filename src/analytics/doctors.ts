import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";

import { branchScope, factsScope, revenueFacts } from "./facts";
import { itemsPerInvoiceSql } from "./items-per-invoice";
import type { DateRange } from "./periods";

/**
 * Doctor metrics (spec stories 31–34): who earns what, from credited lines (`revenueFacts`).
 * Definitions in `METRIC_DEFINITIONS` (./definitions.ts); every figure is summed/averaged in SQL
 * on exact `numeric`.
 */

/** The figures shown for a doctor, another staff member or a group, in the filter's period. */
export interface StaffFigures {
  /** Revenue credited (`METRIC_DEFINITIONS.revenue`), RM. */
  revenue: Money;
  /** Invoices with at least one line credited here. */
  invoices: number;
  /** Distinct customers with at least one line credited here (walk-ins are nobody). */
  customers: number;
  /** revenue ÷ customers, rounded to the sen; null without customers (`aovPerCustomer`). */
  aovPerCustomer: Money | null;
  /** Credited item lines ÷ invoices, 2 decimals; null without item lines' invoices (`itemsPerInvoice`). */
  itemsPerInvoice: number | null;
  /** revenue ÷ all revenue in the period and branches × 100, 1 decimal; null when that is zero (`sharePercent`). */
  sharePercent: number | null;
}

/** A staff member's row (a doctor in the ranking, or a member of the other / generic groups). */
export interface StaffRow extends StaffFigures {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  /** `alias_only`: known only from invoice lines (e.g. a deleted doctor; no Kreloses staff match). */
  source: "kreloses" | "alias_only";
  /** False once Kreloses no longer lists them. */
  active: boolean;
}

export interface BranchFigures extends StaffFigures {
  branchId: string;
  branchName: string;
}

export interface DoctorRow extends StaffRow {
  /** With `splitByBranch`: the doctor's figures per branch they have credited lines in, by branch name. */
  branches?: BranchFigures[];
}

export interface StaffGroup extends StaffFigures {
  /** The group's staff, by revenue. */
  members: StaffRow[];
}

export interface DoctorRanking {
  period: DateRange;
  /** All revenue in the period and branches (every group, pending included; the doctor filter does not apply): the share denominator. */
  totalRevenue: Money;
  /** Staff of kind doctor with credited lines in the filter, by revenue (highest first), then name. */
  doctors: DoctorRow[];
  /** Never mixed into the ranking. */
  groups: {
    /** Non-doctor staff (kind `other`: nurses, groomers…). */
    other: StaffGroup;
    /** Shared accounts (kind `generic`, e.g. a branch "general" login). */
    generic: StaffGroup;
    /** Lines with no staff name ("No staff on line"). */
    noStaff: StaffFigures;
    /** Invoices whose line items are not synced yet, at their net amount (`itemsPerInvoice` always null). */
    pending: StaffFigures;
  };
}

interface FigureRow {
  creditGroup: "doctor" | "other" | "generic" | "no_staff" | "pending";
  staffId: string | null;
  branchId: string | null;
  level: "group" | "staff" | "branch";
  revenue: string;
  invoices: number;
  customers: number;
  aov: string | null;
  itemsPerInvoice: string | null;
  share: string | null;
}

const NO_FIGURES: StaffFigures = { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null, itemsPerInvoice: null, sharePercent: 0 };

/**
 * The doctor ranking for the global filter: per doctor (staff of kind doctor) revenue, AOV per
 * customer, invoices, average items per invoice and share of all revenue; with
 * `{ splitByBranch: true }` each doctor also gets per-branch figures (AOV counted per branch).
 * Non-doctor staff, generic accounts, "No staff on line" and "line items not synced yet" come back
 * as separate groups. Kinds and names are resolved now, so a remap or kind change shows at once.
 */
export async function getDoctorRanking(sql: Sql, filter: GlobalFilter, options: { splitByBranch?: boolean } = {}): Promise<DoctorRanking> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const inPeriod = sql`f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date`;

  // The share denominator: every credited line (and pending invoice) in the dates and branches.
  const [total] = await sql<{ revenue: string }[]>`
    with everything as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
    select coalesce(sum(f.revenue), 0)::numeric(14, 2)::text as revenue from everything f where ${inPeriod}
  `;
  const rows = await sql<FigureRow[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))})
    select
      f.credit_group,
      f.staff_id::text as staff_id,
      case when grouping(f.branch_id) = 0 then f.branch_id::text end as branch_id,
      case when grouping(f.staff_id) = 1 then 'group' when grouping(f.branch_id) = 1 then 'staff' else 'branch' end as level,
      sum(f.revenue)::text as revenue,
      count(distinct f.invoice_id)::int as invoices,
      count(distinct f.customer_id)::int as customers,
      round(sum(f.revenue) / nullif(count(distinct f.customer_id), 0), 2)::text as aov,
      ${itemsPerInvoiceSql(sql)}::text as items_per_invoice,
      round(100 * sum(f.revenue) / nullif(${total!.revenue}::numeric, 0), 1)::text as share
    from facts f
    where ${inPeriod}
    group by grouping sets ((f.credit_group), (f.credit_group, f.staff_id), (f.credit_group, f.staff_id, f.branch_id))
  `;
  const [staff, branches] = await Promise.all([
    sql<{ id: string; name: string; source: StaffRow["source"]; active: boolean }[]>`
      select id::text as id, full_name as name, source, active from staff
      where id = any(${[...new Set(rows.flatMap((row) => (row.staffId ? [row.staffId] : [])))]}::bigint[])
    `,
    sql<{ id: string; name: string }[]>`select id::text as id, name from branches`,
  ]);
  const staffById = new Map(staff.map((member) => [member.id, member]));
  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));

  const figures = (row: FigureRow | undefined): StaffFigures =>
    row
      ? {
          revenue: row.revenue,
          invoices: row.invoices,
          customers: row.customers,
          aovPerCustomer: row.aov,
          itemsPerInvoice: row.itemsPerInvoice === null ? null : Number(row.itemsPerInvoice),
          sharePercent: row.share === null ? null : Number(row.share),
        }
      : { ...NO_FIGURES, sharePercent: moneyToSen(total!.revenue) === 0 ? null : 0 };
  const staffRows = (group: FigureRow["creditGroup"]): StaffRow[] =>
    rows
      .filter((row) => row.creditGroup === group && row.level === "staff")
      .map((row) => {
        const member = staffById.get(row.staffId!)!;
        return { staffId: row.staffId!, name: member.name, source: member.source, active: member.active, ...figures(row) };
      })
      .sort((a, b) => moneyToSen(b.revenue) - moneyToSen(a.revenue) || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.staffId, b.staffId));
  const branchRows = (staffId: string): BranchFigures[] =>
    rows
      .filter((row) => row.creditGroup === "doctor" && row.level === "branch" && row.staffId === staffId)
      .map((row) => ({ branchId: row.branchId!, branchName: branchName.get(row.branchId!) ?? "", ...figures(row) }))
      .sort((a, b) => compareText(a.branchName.toLowerCase(), b.branchName.toLowerCase()) || compareText(a.branchId, b.branchId));
  const groupTotals = (group: FigureRow["creditGroup"]) => figures(rows.find((row) => row.creditGroup === group && row.level === "group"));
  const members = (group: "other" | "generic"): StaffGroup => ({ ...groupTotals(group), members: staffRows(group) });

  return {
    period,
    totalRevenue: total!.revenue,
    doctors: staffRows("doctor").map((doctor) => (options.splitByBranch ? { ...doctor, branches: branchRows(doctor.staffId) } : doctor)),
    groups: {
      other: members("other"),
      generic: members("generic"),
      noStaff: groupTotals("no_staff"),
      pending: { ...groupTotals("pending"), itemsPerInvoice: null },
    },
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The doctors to offer in the global filter: staff of kind doctor that appear on invoice lines, by name. */
export async function listDoctors(sql: Sql): Promise<{ id: string; name: string }[]> {
  return sql<{ id: string; name: string }[]>`
    select s.id::text as id, s.full_name as name from staff s
    where s.kind = 'doctor' and exists (select 1 from staff_aliases a where a.staff_id = s.id)
    order by lower(s.full_name), s.id
  `;
}

/**
 * Revenue credited through each staff name on lines (alias id → RM) in the filter's period and
 * branches (the doctor filter does not apply), for Settings → Doctors. Names with no revenue in
 * the period are absent.
 */
export async function getStaffAliasRevenue(sql: Sql, filter: Pick<GlobalFilter, "dateFrom" | "dateTo" | "branchIds">): Promise<Record<string, Money>> {
  const rows = await sql<{ aliasId: string; revenue: string }[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
    select f.staff_alias_id::text as alias_id, sum(f.revenue)::text as revenue
    from facts f
    where f.staff_alias_id is not null and f.sale_date between ${filter.dateFrom}::date and ${filter.dateTo}::date
    group by f.staff_alias_id
  `;
  return Object.fromEntries(rows.map((row) => [row.aliasId, row.revenue]));
}
