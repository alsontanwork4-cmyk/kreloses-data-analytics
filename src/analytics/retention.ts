import type { Sql } from "@/db/sql";
import type { GlobalFilter, IsoDate } from "@/filters";

import { branchCondition, branchScope, staffCondition, staffScope, type BranchScope } from "./facts";
import type { DateRange } from "./periods";
import { serviceVisitLines, syncedThrough } from "./service-visits";

/**
 * Retention (spec stories 48–50): new vs returning customers, yearly cohorts and the 90-day return
 * rate, per doctor and for the whole clinic. Everything is built on SERVICE VISITS
 * (`METRIC_DEFINITIONS.serviceVisit`, ./service-visits.ts), derived from the credited lines, so
 * staff remaps and kind changes apply at once, like every revenue figure. Counting, first visits,
 * "next visit" (a window function) and percentages all happen in SQL.
 *
 * Filters (`METRIC_DEFINITIONS.retentionFilters`):
 * - BRANCH: decides which visits put a customer IN a period or a cohort (visits at the selected
 *   branches: who is counted, the denominators). Whether that customer is new, came back the next
 *   year, or returned within 90 days is judged across ALL branches — a customer who moves branch
 *   is neither new nor lost (orchestrator decision on #13).
 * - DOCTOR: only decides which doctors are listed. "Any doctor" returns and first visits never
 *   depend on it, and the whole-clinic figures ignore it.
 * - DATE RANGE: the period for new vs returning and the 90-day return rate; cohorts are by calendar
 *   year and ignore it.
 */

/** Days after a visit within which another visit counts as a return (and until it is mature). */
const RETURN_WINDOW_DAYS = 90;
/** A period starting less than this many days after the synced history begins gets `limitedHistory`. */
const LIMITED_HISTORY_DAYS = 90;
/**
 * A cohort year is only `partialYear` when the synced history starts after this day of January: a
 * backfill from 1 Jan whose first sale falls a few days later (New Year holidays) is a full year.
 */
const FULL_YEAR_HISTORY_BY_DAY = 7;
const ALL_BRANCHES: BranchScope = { all: true };

/** New vs returning customers in the period (`METRIC_DEFINITIONS.newVsReturning`). */
export interface NewVsReturning {
  /** Distinct customers with a service visit at the selected branches in the period (for a doctor: attributed to them). */
  customers: number;
  /** Of those, customers whose first service visit in the synced history (any doctor, any branch) is in the period. */
  newCustomers: number;
  /** Of those, customers who had a service visit (any branch) before the period. */
  returningCustomers: number;
  /** newCustomers ÷ customers × 100, one decimal; null without customers. */
  newPercent: number | null;
  /** returningCustomers ÷ customers × 100, one decimal; null without customers. */
  returningPercent: number | null;
}

/** The 90-day return rate over the period's service visits (`METRIC_DEFINITIONS.returnRate90`). */
export interface NinetyDayReturns {
  /** Service visits at the selected branches in the period (for a doctor: attributed to them; one per customer and day). */
  visits: number;
  /** Visits whose 90 days have not passed in the synced data yet (visit day + 90 > `syncedThrough`): left out of the rate. */
  notYetMature: number;
  /** visits − notYetMature: the rate's denominator. */
  mature: number;
  /** Mature visits followed by another service visit of the same customer (any doctor, any branch) 1–90 days later. */
  returned: number;
  /** returned ÷ mature × 100, one decimal; null without mature visits. */
  returnPercent: number | null;
}

/** One yearly cohort (`METRIC_DEFINITIONS.yearlyCohort`). */
export interface YearCohort {
  /** Calendar year Y (clinic days). */
  year: number;
  /** True until the synced data reaches 31 Dec of Y+1: more customers may still come back. */
  accruing: boolean;
  /** The synced history (`historyFrom`) starts after 7 Jan of Y: customers seen earlier in Y are missing from the cohort. */
  partialYear: boolean;
  /** Cohort size: customers with a service visit at the selected branches in Y (for a doctor: attributed to them). */
  customers: number;
  /** Of those, customers with any service visit in Y+1 (whoever it was credited to, at any branch). */
  retainedAnyDoctor: number;
  /** retainedAnyDoctor ÷ customers × 100, one decimal. */
  retainedAnyDoctorPercent: number | null;
  /** Of those, customers with a service visit attributed to the same doctor in Y+1 (any branch); null for the whole clinic. */
  retainedSameDoctor: number | null;
  /** retainedSameDoctor ÷ customers × 100, one decimal; null for the whole clinic. */
  retainedSameDoctorPercent: number | null;
}

/** The three retention measures for the whole clinic or one doctor. */
export interface RetentionFigures {
  newVsReturning: NewVsReturning;
  returns90: NinetyDayReturns;
  /** Newest year first; a cohort is listed once Y+1 has started in the synced data. */
  cohorts: YearCohort[];
}

/** A doctor's retention figures. */
export interface DoctorRetention extends RetentionFigures {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  /** `alias_only`: known only from invoice lines (e.g. a deleted doctor). */
  source: "kreloses" | "alias_only";
}

/** Everything the Retention page (and the MCP `retention` tool) shows for the global filter. */
export interface Retention {
  /** The filter's dates: the period for new vs returning and the 90-day return rate. */
  period: DateRange;
  /** Earliest clinic day with a synced sale at the selected branches; null when nothing is synced. */
  historyFrom: IsoDate | null;
  /**
   * Latest clinic day with a synced sale at ANY branch (`syncedThrough(sql, { all: true })`): returns
   * (which count at any branch) and cohorts are seen up to this day, whatever the branch filter.
   */
  syncedThrough: IsoDate | null;
  /** Latest visit day whose 90 days have passed (`syncedThrough` − 90): later visits are not yet mature. */
  matureThrough: IsoDate | null;
  /**
   * The period starts less than 90 days after `historyFrom`: some "new" customers may have visited
   * before the synced history begins (it goes back to 1 Jan 2024 once the backfill is complete).
   */
  limitedHistory: boolean;
  /**
   * Active sales at the selected branches (any date) whose line items are not synced yet: they
   * cannot count as service visits until the next sync reads them.
   */
  pendingInvoices: number;
  /** Every service visit at the selected branches, whoever it is credited to (the doctor filter does not apply). */
  clinic: RetentionFigures;
  /** Doctors (staff of kind doctor now) with a visit in the period or a listed cohort, within the doctor filter; by name. */
  doctors: DoctorRetention[];
}

interface PeriodRow {
  /** null = the whole clinic. */
  staffId: string | null;
  customers: number;
  newCustomers: number;
  newPercent: string | null;
  returningPercent: string | null;
  visits: number;
  notYetMature: number;
  returned: number;
  returnPercent: string | null;
}

interface CohortRow {
  /** null = the whole clinic. */
  staffId: string | null;
  year: number;
  accruing: boolean;
  partialYear: boolean;
  customers: number;
  retainedAny: number;
  retainedAnyPercent: string | null;
  retainedSame: number | null;
  retainedSamePercent: string | null;
}

const NO_NEW_VS_RETURNING: NewVsReturning = { customers: 0, newCustomers: 0, returningCustomers: 0, newPercent: null, returningPercent: null };
const NO_RETURNS: NinetyDayReturns = { visits: 0, notYetMature: 0, mature: 0, returned: 0, returnPercent: null };

/**
 * Retention for the global filter: new vs returning customers and the 90-day return rate in the
 * period, and yearly cohorts, for the whole clinic and each doctor. Definitions:
 * `METRIC_DEFINITIONS.serviceVisit`, `newVsReturning`, `yearlyCohort`, `returnRate90`,
 * `retentionFilters`, `syncedThrough`. Pages and the MCP `retention` tool only render this.
 */
export async function getRetention(sql: Sql, filter: GlobalFilter): Promise<Retention> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const branches = branchScope(filter);
  const doctors = staffScope(filter);

  const [bounds] = await sql<Pick<Retention, "historyFrom" | "syncedThrough" | "matureThrough" | "limitedHistory" | "pendingInvoices">[]>`
    with through as (select ${syncedThrough(sql, ALL_BRANCHES)} as day)
    select
      min(i.sale_date) as history_from,
      (select day from through) as synced_through,
      (select day from through) - ${RETURN_WINDOW_DAYS}::int as mature_through,
      coalesce(${period.dateFrom}::date < min(i.sale_date) + ${LIMITED_HISTORY_DAYS}::int, false) as limited_history,
      count(*) filter (where i.status = 'active' and not i.lines_current)::int as pending_invoices
    from invoices i
    where ${branchCondition(sql, branches, sql`i.branch_id`)}
  `;
  const { historyFrom, syncedThrough: through, matureThrough, limitedHistory, pendingInvoices } = bounds!;

  const [periodRows, cohortRows] = await Promise.all([
    sql<PeriodRow[]>`
      with lines as (${scopedServiceLines(sql, branches)}),
      -- Every service visit (any branch), and whether it was at a selected branch.
      visits as (select customer_id, sale_date, bool_or(in_scope) as in_scope from lines group by customer_id, sale_date),
      -- Each visit with the customer's first visit ever and their next visit (a later day), at any branch.
      visit_history as (
        select customer_id, sale_date,
          min(sale_date) over (partition by customer_id) as first_day,
          lead(sale_date) over (partition by customer_id order by sale_date) as next_day
        from visits
      ),
      -- Who each visit at the selected branches counts for: the whole clinic (staff_id null), and each doctor
      -- credited there with one of its service lines.
      attributed as (
        select null::bigint as staff_id, customer_id, sale_date from visits where in_scope
        union all
        select distinct staff_id, customer_id, sale_date from lines
        where in_scope and credit_group = 'doctor' and ${staffCondition(sql, doctors, sql`staff_id`)}
      ),
      figures as (
        select
          a.staff_id,
          count(distinct a.customer_id)::int as customers,
          count(distinct a.customer_id) filter (where h.first_day >= ${period.dateFrom}::date)::int as new_customers,
          count(*)::int as visits,
          count(*) filter (where a.sale_date + ${RETURN_WINDOW_DAYS}::int > ${through}::date)::int as not_yet_mature,
          count(*) filter (
            where a.sale_date + ${RETURN_WINDOW_DAYS}::int <= ${through}::date
              and h.next_day - a.sale_date <= ${RETURN_WINDOW_DAYS}::int
          )::int as returned
        from attributed a
        join visit_history h on h.customer_id = a.customer_id and h.sale_date = a.sale_date
        where a.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
        group by a.staff_id
      )
      select
        staff_id::text as staff_id, customers, new_customers, visits, not_yet_mature, returned,
        round(100.0 * new_customers / nullif(customers, 0), 1)::text as new_percent,
        round(100.0 * (customers - new_customers) / nullif(customers, 0), 1)::text as returning_percent,
        round(100.0 * returned / nullif(visits - not_yet_mature, 0), 1)::text as return_percent
      from figures
    `,
    sql<CohortRow[]>`
      with lines as (${scopedServiceLines(sql, branches)}),
      -- Customers with a service visit in a year (anyone), and with one attributed to a doctor — at any
      -- branch, and whether any of them was at a selected branch.
      any_years as (
        select customer_id, extract(year from sale_date)::int as year, bool_or(in_scope) as in_scope
        from lines group by customer_id, year
      ),
      doctor_years as (
        select staff_id, customer_id, extract(year from sale_date)::int as year, bool_or(in_scope) as in_scope
        from lines where credit_group = 'doctor' group by staff_id, customer_id, year
      ),
      -- Cohort members (from visits at the selected branches) and whether they came back the next year (any branch).
      members as (
        select null::bigint as staff_id, c.year,
          exists (select 1 from any_years n where n.customer_id = c.customer_id and n.year = c.year + 1) as retained_any,
          null::boolean as retained_same
        from any_years c where c.in_scope
        union all
        select c.staff_id, c.year,
          exists (select 1 from any_years n where n.customer_id = c.customer_id and n.year = c.year + 1),
          exists (select 1 from doctor_years n where n.staff_id = c.staff_id and n.customer_id = c.customer_id and n.year = c.year + 1)
        from doctor_years c where c.in_scope and ${staffCondition(sql, doctors, sql`c.staff_id`)}
      ),
      figures as (
        select staff_id, year,
          count(*)::int as customers,
          count(*) filter (where retained_any)::int as retained_any,
          case when staff_id is not null then count(*) filter (where retained_same)::int end as retained_same
        from members
        -- Listed once Y+1 has started in the synced data.
        where make_date(year + 1, 1, 1) <= ${through}::date
        group by staff_id, year
      )
      select
        staff_id::text as staff_id, year, customers, retained_any, retained_same,
        ${through}::date < make_date(year + 1, 12, 31) as accruing,
        ${historyFrom}::date > make_date(year, 1, ${FULL_YEAR_HISTORY_BY_DAY}::int) as partial_year,
        round(100.0 * retained_any / nullif(customers, 0), 1)::text as retained_any_percent,
        round(100.0 * retained_same / nullif(customers, 0), 1)::text as retained_same_percent
      from figures
      order by year desc
    `,
  ]);

  const staffIds = [...new Set([...periodRows, ...cohortRows].flatMap((row) => (row.staffId ? [row.staffId] : [])))];
  const staff = await sql<{ id: string; name: string; source: DoctorRetention["source"] }[]>`
    select id::text as id, full_name as name, source from staff
    where id = any(${staffIds}::bigint[])
    order by lower(full_name), id
  `;

  const figures = (staffId: string | null): RetentionFigures => {
    const row = periodRows.find((candidate) => candidate.staffId === staffId);
    return {
      newVsReturning: row
        ? {
            customers: row.customers,
            newCustomers: row.newCustomers,
            returningCustomers: row.customers - row.newCustomers,
            newPercent: percent(row.newPercent),
            returningPercent: percent(row.returningPercent),
          }
        : NO_NEW_VS_RETURNING,
      returns90: row
        ? {
            visits: row.visits,
            notYetMature: row.notYetMature,
            mature: row.visits - row.notYetMature,
            returned: row.returned,
            returnPercent: percent(row.returnPercent),
          }
        : NO_RETURNS,
      cohorts: cohortRows
        .filter((cohort) => cohort.staffId === staffId)
        .map((cohort) => ({
          year: cohort.year,
          accruing: cohort.accruing,
          partialYear: cohort.partialYear,
          customers: cohort.customers,
          retainedAnyDoctor: cohort.retainedAny,
          retainedAnyDoctorPercent: percent(cohort.retainedAnyPercent),
          retainedSameDoctor: cohort.retainedSame,
          retainedSameDoctorPercent: percent(cohort.retainedSamePercent),
        })),
    };
  };

  return {
    period,
    historyFrom,
    syncedThrough: through,
    matureThrough,
    limitedHistory,
    pendingInvoices,
    clinic: figures(null),
    doctors: staff.map((member) => ({ staffId: member.id, name: member.name, source: member.source, ...figures(member.id) })),
  };
}

/**
 * Every service-visit line at ANY branch (`serviceVisitLines`), with `in_scope`: whether its sale
 * was at one of the selected branches. One scan serves both who is counted (in scope) and whether
 * they are new / came back (any branch).
 */
function scopedServiceLines(sql: Sql, branches: BranchScope) {
  return sql`
    select v.*, ${branchCondition(sql, branches, sql`v.branch_id`)} as in_scope
    from (${serviceVisitLines(sql, ALL_BRANCHES)}) v
  `;
}

function percent(value: string | null): number | null {
  return value === null ? null : Number(value);
}
