import type { Sql } from "@/db/sql";
import type { GlobalFilter, IsoDate } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";

import { branchCondition, branchScope, revenueFacts, staffCondition, staffScope, type BranchScope } from "./facts";
import { staffNames } from "./mix";
import { getPendingLineItems, type PendingLineItems } from "./pending";
import type { DateRange } from "./periods";
import { serviceVisits, syncedThrough } from "./service-visits";

/**
 * The surgery department (spec story 44; "Metric definitions" Surgery / Surgery case): surgery
 * cases, operations vs sedation only, surgery fee vs whole-visit value, top procedures and the
 * 14-day post-op follow-up — per doctor, per branch and in total. Definitions:
 * `METRIC_DEFINITIONS.surgeryCase`, `surgeryOperation`, `sedationOnlyCase`, `surgeryFee`,
 * `wholeVisitValue`, `topProcedures`, `postOpFollowUp` (./surgery-definitions.ts).
 *
 * Everything is built on `revenueFacts` (credited lines; staff and item flags resolved at query time,
 * so a remap or an item-group change shows at once): a CASE is an active sale whose line items are
 * synced with ≥ 1 SOLD surgery line (`is_surgery`, quantity > 0 — a returned surgery line never makes
 * a case; pending sales have no known lines, so they are never cases and `pendingLineItems` says how
 * many there are). It is an OPERATION when ≥ 1 of its sold lines is a procedure (`is_procedure`),
 * whoever it is credited to; otherwise SEDATION ONLY. It counts for its branch and for every doctor
 * with a sold surgery line on it. The follow-up reuses THE service-visit definition
 * (./service-visits.ts, #13) and, like retention, is judged clinic-wide (a follow-up at the other
 * branch counts under a branch filter). Sums, averages and percentages happen in SQL.
 */

/** Days after a case within which another service visit is a post-op follow-up (and until it is mature). */
export const POST_OP_FOLLOW_UP_DAYS = 14;
export const DEFAULT_TOP_PROCEDURES = 5;
export const MAX_TOP_PROCEDURES = 50;

const ALL_BRANCHES: BranchScope = { all: true };

/** The 14-day post-op follow-up of a set of cases (`METRIC_DEFINITIONS.postOpFollowUp`). */
export interface PostOpFollowUp {
  /** Cases without a customer (walk-ins): they cannot be followed up, so they are out of the rate. */
  withoutCustomer: number;
  /** Cases (with a customer) whose 14 days have not passed in the synced data yet (case day + 14 > `syncedThrough`): out of the rate. */
  notYetMature: number;
  /** cases − withoutCustomer − notYetMature: the rate's denominator. */
  mature: number;
  /** Mature cases whose customer had another service visit (any doctor, any branch) 1–14 days after the case. */
  followedUp: number;
  /** followedUp ÷ mature × 100, one decimal; null without mature cases. */
  followUpPercent: number | null;
}

/** Surgery figures for the whole filter, a branch or a doctor. */
export interface SurgeryFigures {
  /** Surgery cases (`METRIC_DEFINITIONS.surgeryCase`). */
  cases: number;
  /** Of those, cases with an actual operation (`surgeryOperation`). */
  operations: number;
  /** cases − operations (`sedationOnlyCase`). */
  sedationOnly: number;
  /** Revenue of the cases' surgery lines (for a doctor: theirs; `surgeryFee`). */
  surgeryFees: Money;
  /** Revenue of the whole sales the cases are on, every line (`wholeVisitValue`). */
  wholeVisitValue: Money;
  /** surgeryFees ÷ cases, to the sen; null without cases. */
  averageSurgeryFee: Money | null;
  /** wholeVisitValue ÷ cases, to the sen; null without cases. */
  averageWholeVisitValue: Money | null;
  /** surgeryFees ÷ wholeVisitValue × 100, one decimal; null when the whole-visit value is zero or less. */
  surgeryFeeSharePercent: number | null;
  followUp: PostOpFollowUp;
}

export interface BranchSurgery extends SurgeryFigures {
  branchId: string;
  branchName: string;
}

export interface DoctorSurgery extends SurgeryFigures {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  source: "kreloses" | "alias_only";
}

/** Everything the surgery section shows for the global filter (besides top procedures). */
export interface SurgeryDepartment {
  period: DateRange;
  /** `POST_OP_FOLLOW_UP_DAYS`. */
  followUpDays: number;
  /** Latest clinic day with a synced sale at ANY branch (`METRIC_DEFINITIONS.syncedThrough`); null when nothing is synced. */
  syncedThrough: IsoDate | null;
  /** Latest case day whose follow-up window has passed (`syncedThrough` − 14): later cases are not yet mature. */
  matureThrough: IsoDate | null;
  /** Sales in the dates and branches whose line items are not synced yet (doctor filter ignored): they may hold cases not counted yet. */
  pendingLineItems: PendingLineItems;
  /** Every case in the filter (with a doctor filter: the cases of those doctors, and only their surgery lines as fees). */
  total: SurgeryFigures;
  /** The same per branch: every branch in the filter (all synced branches when none is selected), by name, zeros included. */
  branches: BranchSurgery[];
  /** Doctors (kind doctor now, within the doctor filter) with a case, by surgery fees (highest first), then name. */
  doctors: DoctorSurgery[];
}

interface FigureRow {
  level: "total" | "branch" | "doctor";
  /** Branch or staff id; null for the total. */
  key: string | null;
  cases: number;
  operations: number;
  fees: string;
  wholeVisit: string;
  averageFee: string | null;
  averageWholeVisit: string | null;
  feeShare: string | null;
  withoutCustomer: number;
  notYetMature: number;
  followedUp: number;
  followUpPercent: string | null;
}

const NO_CASES: SurgeryFigures = {
  cases: 0,
  operations: 0,
  sedationOnly: 0,
  surgeryFees: "0.00",
  wholeVisitValue: "0.00",
  averageSurgeryFee: null,
  averageWholeVisitValue: null,
  surgeryFeeSharePercent: null,
  followUp: { withoutCustomer: 0, notYetMature: 0, mature: 0, followedUp: 0, followUpPercent: null },
};

/**
 * Surgery cases, operations vs sedation only, surgery fees vs whole-visit value and the 14-day
 * post-op follow-up, in total, per branch and per doctor, for the global filter. Pages and MCP
 * tools only render this.
 */
export async function getSurgeryDepartment(sql: Sql, filter: GlobalFilter): Promise<SurgeryDepartment> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const branches = branchScope(filter);
  const doctors = staffScope(filter);

  const [[bounds], rows, branchRows, pendingLineItems] = await Promise.all([
    sql<{ syncedThrough: IsoDate | null; matureThrough: IsoDate | null }[]>`
      with through as (select ${syncedThrough(sql, ALL_BRANCHES)} as day)
      select day as synced_through, day - ${POST_OP_FOLLOW_UP_DAYS}::int as mature_through from through
    `,
    sql<FigureRow[]>`
      with facts as (${revenueFacts(sql, { branches, staff: { all: true } })}),
      -- The period's credited lines at the selected branches (every staff: a case's whole visit is every line on it).
      lines as (
        select f.invoice_id, f.sale_date, f.branch_id, f.customer_id, f.staff_id, f.credit_group, f.revenue,
          f.is_surgery, f.is_procedure, coalesce(l.quantity > 0, false) as sold
        from facts f
        left join invoice_lines l on l.id = f.invoice_line_id
        where f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      ),
      -- Every case: a sale with a sold surgery line (anyone's); an operation if a sold line is a procedure.
      cases as (
        select invoice_id, sale_date, branch_id, customer_id,
          coalesce(bool_or(is_procedure and sold), false) as operation,
          sum(revenue) as whole_visit
        from lines
        group by invoice_id, sale_date, branch_id, customer_id
        having bool_or(is_surgery and sold)
      ),
      -- Who each case counts for, with their fee: the filter's total (the surgery lines in its staff scope — all, or the
      -- selected doctors'), each branch (from the total), and each doctor with a sold surgery line on it (their own lines).
      attributed as (
        select 'total' as level, null::bigint as key, invoice_id, sum(revenue) as fees
        from lines
        where is_surgery and ${staffCondition(sql, doctors, sql`staff_id`)}
        group by invoice_id
        having bool_or(sold)
        union all
        select 'doctor', staff_id, invoice_id, sum(revenue)
        from lines
        where is_surgery and credit_group = 'doctor' and ${staffCondition(sql, doctors, sql`staff_id`)}
        group by staff_id, invoice_id
        having bool_or(sold)
      ),
      counted as (
        select level, key, invoice_id, fees from attributed
        union all
        select 'branch', c.branch_id, a.invoice_id, a.fees from attributed a join cases c on c.invoice_id = a.invoice_id where a.level = 'total'
      ),
      through as (select ${syncedThrough(sql, ALL_BRANCHES)} as day),
      -- Service visits (any branch) in the window a follow-up of a case in the period can fall in. Materialized and
      -- JOINED (a hash join on the customer), not probed per case: a correlated EXISTS ran once per row (~1 s at 35k sales).
      visits as materialized (
        select v.customer_id, v.sale_date from (${serviceVisits(sql, ALL_BRANCHES)}) v
        where v.sale_date between ${period.dateFrom}::date + 1 and ${period.dateTo}::date + ${POST_OP_FOLLOW_UP_DAYS}::int
      ),
      followed_up as (
        select distinct c.invoice_id
        from cases c
        join visits v on v.customer_id = c.customer_id and v.sale_date between c.sale_date + 1 and c.sale_date + ${POST_OP_FOLLOW_UP_DAYS}::int
      ),
      follow_up as (
        select c.invoice_id,
          c.customer_id is null as walk_in,
          not coalesce(c.sale_date + ${POST_OP_FOLLOW_UP_DAYS}::int <= t.day, false) as not_mature,
          f.invoice_id is not null as followed_up
        from cases c
        cross join through t
        left join followed_up f on f.invoice_id = c.invoice_id
      ),
      figures as (
        select k.level, k.key,
          count(*)::int as cases,
          count(*) filter (where c.operation)::int as operations,
          sum(k.fees) as fees,
          sum(c.whole_visit) as whole_visit,
          count(*) filter (where u.walk_in)::int as without_customer,
          count(*) filter (where not u.walk_in and u.not_mature)::int as not_yet_mature,
          count(*) filter (where not u.walk_in and not u.not_mature and u.followed_up)::int as followed_up
        from counted k
        join cases c on c.invoice_id = k.invoice_id
        join follow_up u on u.invoice_id = k.invoice_id
        group by k.level, k.key
      )
      select level, key::text as key, cases, operations,
        fees::numeric(14, 2)::text as fees,
        whole_visit::numeric(14, 2)::text as whole_visit,
        round(fees / cases, 2)::numeric(14, 2)::text as average_fee,
        round(whole_visit / cases, 2)::numeric(14, 2)::text as average_whole_visit,
        case when whole_visit > 0 then round(100 * fees / whole_visit, 1)::text end as fee_share,
        without_customer, not_yet_mature, followed_up,
        round(100.0 * followed_up / nullif(cases - without_customer - not_yet_mature, 0), 1)::text as follow_up_percent
      from figures
    `,
    sql<{ branchId: string; branchName: string }[]>`
      select b.id::text as branch_id, b.name as branch_name from branches b
      where ${branchCondition(sql, branches, sql`b.id`)}
      order by lower(b.name), b.id
    `,
    getPendingLineItems(sql, filter),
  ]);

  const figuresOf = (level: FigureRow["level"], key: string | null): SurgeryFigures => {
    const row = rows.find((candidate) => candidate.level === level && candidate.key === key);
    if (!row) return NO_CASES;
    const mature = row.cases - row.withoutCustomer - row.notYetMature;
    return {
      cases: row.cases,
      operations: row.operations,
      sedationOnly: row.cases - row.operations,
      surgeryFees: row.fees,
      wholeVisitValue: row.wholeVisit,
      averageSurgeryFee: row.averageFee,
      averageWholeVisitValue: row.averageWholeVisit,
      surgeryFeeSharePercent: percent(row.feeShare),
      followUp: { withoutCustomer: row.withoutCustomer, notYetMature: row.notYetMature, mature, followedUp: row.followedUp, followUpPercent: percent(row.followUpPercent) },
    };
  };

  const doctorIds = rows.flatMap((row) => (row.level === "doctor" && row.key ? [row.key] : []));
  const names = await staffNames(sql, doctorIds);
  return {
    period,
    followUpDays: POST_OP_FOLLOW_UP_DAYS,
    syncedThrough: bounds?.syncedThrough ?? null,
    matureThrough: bounds?.matureThrough ?? null,
    pendingLineItems,
    total: figuresOf("total", null),
    branches: branchRows.map((branch) => ({ ...branch, ...figuresOf("branch", branch.branchId) })),
    doctors: doctorIds
      .map((staffId): DoctorSurgery => {
        const member = names.get(staffId)!;
        return { staffId, name: member.name, source: member.source, ...figuresOf("doctor", staffId) };
      })
      .sort((a, b) => byAmountThenName(a.surgeryFees, b.surgeryFees, a, b)),
  };
}

/** One procedure (operation item) in a top-procedures list (`METRIC_DEFINITIONS.topProcedures`). */
export interface TopProcedure {
  /** The item's identity (`itemKey`: spelling variants share it). */
  itemKey: string;
  /** Its name as most often written on the operation lines in the filter. */
  name: string;
  /** Surgery cases it was sold on. */
  cases: number;
  /** Revenue of its lines on those cases. */
  fees: Money;
  /** fees ÷ cases, to the sen. */
  averageFee: Money;
}

export interface DoctorTopProcedures {
  staffId: string;
  name: string;
  procedures: TopProcedure[];
}

export interface TopProcedures {
  period: DateRange;
  /** Procedures listed per list (1–`MAX_TOP_PROCEDURES`). */
  limit: number;
  /** The filter's operation lines (with a doctor filter, the selected doctors'), by fees (highest first), then cases, then name. */
  overall: TopProcedure[];
  /** Doctors (kind doctor now) with an operation line credited to them, by their total procedure fees, then name; each their top `limit`. */
  doctors: DoctorTopProcedures[];
}

/**
 * The top procedures by fees — overall and per doctor — in the filter, at most `limit` per list
 * (default `DEFAULT_TOP_PROCEDURES`, also for a limit that is not a finite number; truncated and
 * clamped to 1–`MAX_TOP_PROCEDURES`).
 */
export async function getTopProcedures(sql: Sql, filter: GlobalFilter, options: { limit?: number } = {}): Promise<TopProcedures> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  // NaN / ±Infinity (e.g. an unchecked MCP argument) would pass the clamp and reach SQL: use the default.
  const requested = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : DEFAULT_TOP_PROCEDURES;
  const limit = Math.min(MAX_TOP_PROCEDURES, Math.max(1, Math.trunc(requested)));
  const rows = await sql<{ staffId: string | null; itemKey: string; name: string; cases: number; fees: string; averageFee: string; staffFees: string }[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: staffScope(filter) })}),
    lines as (
      select f.invoice_id, f.staff_id, f.credit_group, f.item_key, f.item_name, f.revenue, coalesce(l.quantity > 0, false) as sold
      from facts f
      join invoice_lines l on l.id = f.invoice_line_id
      where f.is_procedure and f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
    ),
    names as (select item_key, mode() within group (order by item_name) as name from lines group by item_key),
    -- Each procedure on each case it was SOLD on (so the sale is a case), with the revenue of its lines there:
    -- overall (staff_id null) and per doctor.
    per_case as (
      select null::bigint as staff_id, item_key, invoice_id, sum(revenue) as fees
      from lines group by item_key, invoice_id having bool_or(sold)
      union all
      select staff_id, item_key, invoice_id, sum(revenue)
      from lines where credit_group = 'doctor' group by staff_id, item_key, invoice_id having bool_or(sold)
    ),
    items as (select staff_id, item_key, count(*)::int as cases, sum(fees) as fees from per_case group by staff_id, item_key),
    ranked as (
      select i.*, n.name,
        sum(i.fees) over (partition by i.staff_id) as staff_fees,
        row_number() over (partition by i.staff_id order by i.fees desc, i.cases desc, lower(n.name), i.item_key) as rank
      from items i join names n on n.item_key = i.item_key
    )
    select staff_id::text as staff_id, item_key, name, cases, fees::numeric(14, 2)::text as fees,
      round(fees / cases, 2)::numeric(14, 2)::text as average_fee, staff_fees::numeric(14, 2)::text as staff_fees
    from ranked
    where rank <= ${limit}
    order by staff_id nulls first, rank
  `;
  const procedure = (row: (typeof rows)[number]): TopProcedure => ({ itemKey: row.itemKey, name: row.name, cases: row.cases, fees: row.fees, averageFee: row.averageFee });
  const doctorIds = [...new Set(rows.flatMap((row) => (row.staffId ? [row.staffId] : [])))];
  const names = await staffNames(sql, doctorIds);
  const doctors = doctorIds
    .map((staffId) => {
      const own = rows.filter((row) => row.staffId === staffId);
      return { staffId, name: names.get(staffId)!.name, fees: own[0]!.staffFees, procedures: own.map(procedure) };
    })
    .sort((a, b) => byAmountThenName(a.fees, b.fees, a, b))
    .map(({ staffId, name, procedures }): DoctorTopProcedures => ({ staffId, name, procedures }));
  return { period, limit, overall: rows.filter((row) => row.staffId === null).map(procedure), doctors };
}

/** Highest amount first (exact, via integer sen), then name, then id. */
function byAmountThenName(amountA: Money, amountB: Money, a: { name: string; staffId: string }, b: { name: string; staffId: string }): number {
  const difference = moneyToSen(amountB) - moneyToSen(amountA);
  if (difference !== 0) return difference;
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0;
}

function percent(value: string | null): number | null {
  return value === null ? null : Number(value);
}
