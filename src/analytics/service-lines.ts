import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import type { Money } from "@/lib/money";

import { branchCondition, factsScope, revenueFacts, staffScope } from "./facts";
import { byRevenueThenName, staffNames } from "./mix";
import { moneyChange, type Kpi } from "./overview";
import { comparisonPeriods, type DateRange } from "./periods";

/**
 * Surgery and consult revenue (spec stories 27, 35, 38, 43; #9) and revenue per working day. A
 * line is a surgery / consult line when its item's flag says so (`revenueFacts.is_surgery` /
 * `is_consult`, from the item rules and the owner's assignments, resolved at query time).
 * Definitions in `METRIC_DEFINITIONS` (surgeryRevenue, consultRevenue, workingDay,
 * revenuePerWorkingDay).
 */

/** The two core service lines. */
export const SERVICE_LINES = ["surgery", "consult"] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

/**
 * The SQL condition "this fact row is a `line` line", for a query over `revenueFacts` aliased `f`
 * (e.g. `sum(f.revenue) filter (where ${serviceLineCondition(sql, "surgery")})`). Trends (#10) can
 * use it to add surgery / consult revenue to its own measures.
 */
export function serviceLineCondition(sql: Sql, line: ServiceLine) {
  return line === "surgery" ? sql`f.is_surgery` : sql`f.is_consult`;
}

export interface ServiceLineFigures {
  /** All revenue in the row's scope, RM. */
  revenue: Money;
  /** Revenue of surgery lines (`METRIC_DEFINITIONS.surgeryRevenue`). */
  surgeryRevenue: Money;
  /** Revenue of consult lines (`METRIC_DEFINITIONS.consultRevenue`). */
  consultRevenue: Money;
  /** surgeryRevenue ÷ revenue × 100, one decimal; null when revenue is zero or less. */
  surgerySharePercent: number | null;
  consultSharePercent: number | null;
}

export interface DoctorServiceLines extends ServiceLineFigures {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
}

/**
 * Surgery and consult revenue per doctor (kind doctor, the filter's doctors, by revenue then
 * name), and in total for the filter (every credited line in it; with a doctor filter, theirs).
 * Sales whose line items are not synced yet are in `total.revenue` but in neither service line.
 */
export async function getServiceLinesByDoctor(sql: Sql, filter: GlobalFilter): Promise<{ period: DateRange; total: ServiceLineFigures; doctors: DoctorServiceLines[] }> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const rows = await sql<{ staffId: string | null; revenue: string; surgery: string; consult: string; surgeryShare: string | null; consultShare: string | null }[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))}),
    sums as (
      select case when grouping(f.staff_id) = 0 then f.staff_id end as staff_id,
        -- The grand total's row exists even without any fact: zero, not null.
        coalesce(sum(f.revenue), 0) as revenue,
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "surgery")}), 0) as surgery,
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "consult")}), 0) as consult
      from facts f
      where f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      group by grouping sets ((), (f.credit_group, f.staff_id))
      having grouping(f.staff_id) = 1 or f.credit_group = 'doctor'
    )
    select staff_id::text as staff_id, revenue::numeric(14, 2)::text as revenue, surgery::numeric(14, 2)::text as surgery,
      consult::numeric(14, 2)::text as consult,
      case when revenue > 0 then round(100 * surgery / revenue, 1)::text end as surgery_share,
      case when revenue > 0 then round(100 * consult / revenue, 1)::text end as consult_share
    from sums
  `;
  const figures = (row: (typeof rows)[number] | undefined): ServiceLineFigures =>
    row
      ? {
          revenue: row.revenue,
          surgeryRevenue: row.surgery,
          consultRevenue: row.consult,
          surgerySharePercent: row.surgeryShare === null ? null : Number(row.surgeryShare),
          consultSharePercent: row.consultShare === null ? null : Number(row.consultShare),
        }
      : { revenue: "0.00", surgeryRevenue: "0.00", consultRevenue: "0.00", surgerySharePercent: null, consultSharePercent: null };
  const doctorRows = rows.filter((row) => row.staffId !== null);
  const names = await staffNames(
    sql,
    doctorRows.map((row) => row.staffId!),
  );
  return {
    period,
    total: figures(rows.find((row) => row.staffId === null)),
    doctors: doctorRows
      .map((row) => {
        const member = names.get(row.staffId!)!;
        return { staffId: row.staffId!, name: member.name, source: member.source, ...figures(row) };
      })
      .sort(byRevenueThenName),
  };
}

/**
 * Surgery or consult revenue per doctor (kind doctor) per calendar month (`'YYYY-MM'`, clinic
 * days) in the filter's dates, branches and doctors, by month then doctor name. Months where a
 * doctor has no such line are absent. For the Trends page's measure switch (#10).
 */
export async function getMonthlyServiceLineRevenue(sql: Sql, filter: GlobalFilter, line: ServiceLine): Promise<{ month: string; staffId: string; revenue: Money }[]> {
  return sql<{ month: string; staffId: string; revenue: string }[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))})
    select to_char(f.sale_date, 'YYYY-MM') as month, f.staff_id::text as staff_id, sum(f.revenue)::text as revenue
    from facts f
    join staff s on s.id = f.staff_id
    where f.credit_group = 'doctor' and ${serviceLineCondition(sql, line)}
      and f.sale_date between ${filter.dateFrom}::date and ${filter.dateTo}::date
    group by 1, f.staff_id, s.full_name
    order by 1, lower(s.full_name), f.staff_id
  `;
}

export interface ServiceLineKpiSet {
  surgeryRevenue: Kpi<Money>;
  consultRevenue: Kpi<Money>;
}

export interface ServiceLineKpis {
  period: DateRange;
  previousPeriod: DateRange;
  lastYear: DateRange;
  total: ServiceLineKpiSet;
  /** Every branch in the filter (all synced branches when none is selected), by name. */
  branches: (ServiceLineKpiSet & { branchId: string; branchName: string })[];
}

type PeriodKey = "current" | "previous" | "last_year";

/**
 * The Overview's surgery and consult revenue KPIs (spec story 27), in total and per branch, each
 * compared with the previous period and the same period last year exactly like the other KPIs
 * (`getOverviewKpis`). With a doctor filter, only lines credited to those doctors.
 */
export async function getServiceLineKpis(sql: Sql, filter: GlobalFilter): Promise<ServiceLineKpis> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const { previousPeriod, lastYear } = comparisonPeriods(period);
  const scope = factsScope(filter);
  const [rows, branches] = await Promise.all([
    sql<{ period: PeriodKey; branchId: string | null; surgery: string; consult: string }[]>`
      with periods (period, date_from, date_to) as (
        values
          ('current', ${period.dateFrom}::date, ${period.dateTo}::date),
          ('previous', ${previousPeriod.dateFrom}::date, ${previousPeriod.dateTo}::date),
          ('last_year', ${lastYear.dateFrom}::date, ${lastYear.dateTo}::date)
      ),
      facts as (${revenueFacts(sql, scope)})
      select p.period, case when grouping(f.branch_id) = 0 then f.branch_id::text end as branch_id,
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "surgery")}), 0)::numeric(14, 2)::text as surgery,
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "consult")}), 0)::numeric(14, 2)::text as consult
      from periods p
      join facts f on f.sale_date between p.date_from and p.date_to
      group by grouping sets ((p.period), (p.period, f.branch_id))
    `,
    sql<{ branchId: string; branchName: string }[]>`
      select b.id::text as branch_id, b.name as branch_name from branches b
      where ${branchCondition(sql, scope.branches, sql`b.id`)}
      order by lower(b.name), b.id
    `,
  ]);
  const value = (key: PeriodKey, branchId: string | null, line: "surgery" | "consult"): Money =>
    rows.find((row) => row.period === key && row.branchId === branchId)?.[line] ?? "0.00";
  const kpi = (branchId: string | null, line: "surgery" | "consult"): Kpi<Money> => {
    const current = value("current", branchId, line);
    return {
      value: current,
      previousPeriod: moneyChange(current, value("previous", branchId, line)),
      lastYear: moneyChange(current, value("last_year", branchId, line)),
    };
  };
  const set = (branchId: string | null): ServiceLineKpiSet => ({ surgeryRevenue: kpi(branchId, "surgery"), consultRevenue: kpi(branchId, "consult") });
  return {
    period,
    previousPeriod,
    lastYear,
    total: set(null),
    branches: branches.map((branch) => ({ ...branch, ...set(branch.branchId) })),
  };
}

export interface WorkingDayFigures {
  staffId: string;
  /** The staff member's revenue in the filter (dates, branches, doctors) — the doctor ranking's revenue. */
  revenue: Money;
  /** Clinic days in the period with ≥ 1 consult or surgery line credited to them, at ANY branch. */
  workingDays: number;
  /** revenue ÷ workingDays, rounded to the sen; null without working days. */
  revenuePerWorkingDay: Money | null;
  /** With `splitByBranch`: each branch's revenue ÷ the same working days, by branch id. */
  branches?: { branchId: string; revenue: Money; revenuePerWorkingDay: Money | null }[];
}

/**
 * Revenue per working day per staff member (spec story 35; the Doctors page shows doctors):
 * revenue in the filter ÷ working days. A working day is a clinic day in the period with at least
 * one consult or surgery credited line for them at EITHER branch — so the branch filter narrows
 * the revenue but never the working days (with Branch North selected: North revenue ÷ days worked
 * anywhere; per-branch figures therefore add up to the total, give or take a sen of rounding).
 * Keyed by staff id; staff with revenue but no working day get `revenuePerWorkingDay: null`.
 */
export async function getRevenuePerWorkingDay(
  sql: Sql,
  filter: GlobalFilter,
  options: { splitByBranch?: boolean } = {},
): Promise<Record<string, WorkingDayFigures>> {
  const inPeriod = sql`f.sale_date between ${filter.dateFrom}::date and ${filter.dateTo}::date`;
  const rows = await sql<{ staffId: string; branchId: string | null; revenue: string; workingDays: number; perDay: string | null }[]>`
    with scoped as (${revenueFacts(sql, factsScope(filter))}),
    anywhere as (${revenueFacts(sql, { branches: { all: true }, staff: staffScope(filter) })}),
    days as (
      select f.staff_id, count(distinct f.sale_date)::int as working_days
      from anywhere f
      where f.staff_id is not null and (f.is_consult or f.is_surgery) and ${inPeriod}
      group by f.staff_id
    ),
    revenue as (
      select f.staff_id, case when grouping(f.branch_id) = 0 then f.branch_id end as branch_id, sum(f.revenue) as revenue
      from scoped f
      where f.staff_id is not null and ${inPeriod}
      group by grouping sets ((f.staff_id), (f.staff_id, f.branch_id))
    )
    select r.staff_id::text as staff_id, r.branch_id::text as branch_id, r.revenue::text as revenue,
      coalesce(d.working_days, 0) as working_days, round(r.revenue / nullif(d.working_days, 0), 2)::text as per_day
    from revenue r
    left join days d on d.staff_id = r.staff_id
    order by r.staff_id, r.branch_id nulls first
  `;
  const result: Record<string, WorkingDayFigures> = {};
  for (const row of rows) {
    if (row.branchId === null) {
      result[row.staffId] = { staffId: row.staffId, revenue: row.revenue, workingDays: row.workingDays, revenuePerWorkingDay: row.perDay };
      if (options.splitByBranch) result[row.staffId]!.branches = [];
    } else if (options.splitByBranch) {
      result[row.staffId]?.branches?.push({ branchId: row.branchId, revenue: row.revenue, revenuePerWorkingDay: row.perDay });
    }
  }
  return result;
}
