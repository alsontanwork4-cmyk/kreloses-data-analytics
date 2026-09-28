import type { Sql } from "@/db/sql";
import { addDays, addYears, clinicToday, isIsoDate, type GlobalFilter, type IsoDate } from "@/filters";
import { moneyToSen, senToMoney, type Money } from "@/lib/money";

import { branchCondition, factsScope, revenueFacts } from "./facts";
import { percentChange, type KpiChange } from "./overview";

/**
 * Daily sales (spec stories 53–54; `METRIC_DEFINITIONS.dailySales`): one clinic day's revenue,
 * invoices, customers and AOV per customer — in total, per branch and per doctor — each compared
 * with the same weekday last week and the same date last year. Built on `revenueFacts`, so every
 * figure means exactly what it means on the Overview and Doctors pages; sums and averages are
 * computed in SQL on exact `numeric`, only the changes here (in integer sen).
 *
 * The Daily page and the MCP tool `daily_sales` (#17/#18) are thin wrappers over `getDailySales`.
 */

/** A figure for the day and its changes against the two comparison days. */
export interface DailyMetric<T> {
  /** On the day. */
  value: T;
  /** Against the same weekday last week (`DailySales.comparisonDays.lastWeek`): base = its value there. */
  lastWeek: KpiChange<T>;
  /** Against the same date last year (`DailySales.comparisonDays.lastYear`). */
  lastYear: KpiChange<T>;
}

/**
 * The figures of one row (the total, a branch, a doctor or a group). `KpiChange`: `change` = value −
 * base; `changePercent` = change ÷ |base| × 100 to one decimal (half away from zero), null when the
 * base is 0. For AOV, `change` and `changePercent` are null when either side has no customers.
 */
export interface DailyFigures {
  /** Revenue credited on the day, RM (`METRIC_DEFINITIONS.revenue`). */
  revenue: DailyMetric<Money>;
  /** Active invoices (for a doctor: with at least one line credited to them). */
  invoices: DailyMetric<number>;
  /** Distinct customers (walk-ins are nobody; for a doctor: with a line credited to them). */
  customers: DailyMetric<number>;
  /** revenue ÷ customers, RM, rounded to the sen; null without customers. */
  aovPerCustomer: DailyMetric<Money | null>;
}

export interface DailyBranchRow extends DailyFigures {
  branchId: string;
  branchName: string;
}

export interface DailyDoctorRow extends DailyFigures {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  /** `alias_only`: known only from invoice lines (e.g. a deleted doctor; no Kreloses staff match). */
  source: "kreloses" | "alias_only";
}

/**
 * Revenue never ranked with doctors (as on the Doctors page): other staff (kind `other`), generic
 * accounts (kind `generic`), "No staff on line", and "Line items not synced yet" (a sale whose
 * lines have not been read counts its whole net amount here; never under a doctor filter).
 */
export type DailyGroup = "other" | "generic" | "noStaff" | "pending";

/** What each group is called on the Daily page and in the MCP `daily_sales` tool's answers. */
export const DAILY_GROUP_LABELS: Record<DailyGroup, string> = {
  other: "Other staff",
  generic: "Generic accounts",
  noStaff: "No staff on line",
  pending: "Line items not synced yet",
};

export interface DailyGroupRow extends DailyFigures {
  group: DailyGroup;
}

export interface DailySales {
  /** The clinic day (Asia/Kuala_Lumpur) the figures are for. */
  day: IsoDate;
  /** What it is compared with (`dailyComparisonDays`). */
  comparisonDays: { lastWeek: IsoDate; lastYear: IsoDate };
  /** All the filter's branches together (a customer who visited both branches counts once). */
  total: DailyFigures;
  /** Every branch in the filter (all synced branches when none is selected), by name; zeros if it had no sales. */
  branches: DailyBranchRow[];
  /**
   * Doctors (kind doctor) with credited lines on the day OR on a comparison day (so a doctor who
   * sold nothing on the day still shows the drop), by revenue on the day (highest first), then name.
   */
  doctors: DailyDoctorRow[];
  /** The groups (in `DailyGroup` order) with sales on the day or a comparison day. Empty under a doctor filter. */
  groups: DailyGroupRow[];
}

/**
 * The two days every daily figure is compared with (spec story 54):
 *
 * - **Same weekday last week**: `day` − 7 days (Sunday 27 Sep 2026 → Sunday 20 Sep 2026).
 * - **Same date last year**: the same calendar date one year earlier (27 Sep 2026 → 27 Sep 2025);
 *   29 February → 28 February of the previous year (there is no 29 Feb then). Its weekday usually
 *   differs.
 */
export function dailyComparisonDays(day: IsoDate): DailySales["comparisonDays"] {
  return { lastWeek: addDays(day, -7), lastYear: addYears(day, -1) };
}

/** The day the Daily page (and `daily_sales`) shows by default: yesterday at the clinic (Asia/Kuala_Lumpur), whatever the server's time zone. */
export function defaultDailyDay(now: Date = new Date()): IsoDate {
  return addDays(clinicToday(now), -1);
}

/** The earliest day `resolveDailyDay` accepts (anything before is a typo, not a sales day). */
export const EARLIEST_DAILY_DAY: IsoDate = "2000-01-01";

/**
 * Why `value` cannot be the Daily day, or null when it can: a day is a real date from
 * `EARLIEST_DAILY_DAY` up to today at the clinic (today allowed: a day in progress) — a future day
 * has no sales, and would still show "data as of". The page falls back to yesterday
 * (`resolveDailyDay`); the MCP `daily_sales` tool refuses the day and says why.
 */
export function dailyDayProblem(value: unknown, now: Date = new Date()): "not_a_date" | "too_early" | "in_the_future" | null {
  if (!isIsoDate(value)) return "not_a_date";
  if (value < EARLIEST_DAILY_DAY) return "too_early";
  if (value > clinicToday(now)) return "in_the_future";
  return null;
}

/**
 * The day asked for (e.g. the page's `?day=YYYY-MM-DD`; the first one if repeated) if it can be
 * shown (`dailyDayProblem`), else `defaultDailyDay(now)`.
 */
export function resolveDailyDay(value: string | readonly string[] | undefined, now: Date = new Date()): IsoDate {
  const first = typeof value === "string" ? value : value?.[0];
  return first !== undefined && dailyDayProblem(first, now) === null ? first : defaultDailyDay(now);
}

type Period = "day" | "lastWeek" | "lastYear";

interface FigureRow {
  saleDate: IsoDate;
  level: "total" | "branch" | "group" | "staff";
  branchId: string | null;
  creditGroup: "doctor" | "other" | "generic" | "no_staff" | "pending" | null;
  staffId: string | null;
  revenue: string;
  invoices: number;
  customers: number;
  aov: string | null;
}

interface Values {
  revenue: Money;
  invoices: number;
  customers: number;
  aovPerCustomer: Money | null;
}

const ZERO: Values = { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null };
const GROUPS: { group: DailyGroup; creditGroup: FigureRow["creditGroup"] }[] = [
  { group: "other", creditGroup: "other" },
  { group: "generic", creditGroup: "generic" },
  { group: "noStaff", creditGroup: "no_staff" },
  { group: "pending", creditGroup: "pending" },
];

/**
 * Daily sales for one clinic day: totals, every branch in the filter, each doctor and the
 * non-doctor groups, with revenue, invoices, customers and AOV per customer, each compared with
 * the same weekday last week and the same date last year (`dailyComparisonDays`).
 *
 * `filter`: the global filter's branches and doctors (its date range does NOT apply — the day
 * does). With `doctorIds`, every figure counts only lines credited to those doctors (as on the
 * Overview), so the groups are empty; sales whose line items are not synced yet cannot be
 * included then — `getPendingLineItems` says how many there are.
 */
export async function getDailySales(
  sql: Sql,
  day: IsoDate,
  filter: Pick<GlobalFilter, "branchIds" | "doctorIds"> = {},
): Promise<DailySales> {
  if (!isIsoDate(day)) throw new RangeError(`Not a clinic day: ${day}`);
  const comparisonDays = dailyComparisonDays(day);
  const dates: Record<Period, IsoDate> = { day, ...comparisonDays };
  const scope = factsScope(filter);

  const [rows, branches] = await Promise.all([
    sql<FigureRow[]>`
      with facts as (${revenueFacts(sql, scope)})
      select
        f.sale_date,
        case
          when grouping(f.branch_id) = 0 then 'branch'
          when grouping(f.credit_group) = 1 then 'total'
          when grouping(f.staff_id) = 1 then 'group'
          else 'staff'
        end as level,
        case when grouping(f.branch_id) = 0 then f.branch_id::text end as branch_id,
        case when grouping(f.credit_group) = 0 then f.credit_group end as credit_group,
        case when grouping(f.staff_id) = 0 then f.staff_id::text end as staff_id,
        sum(f.revenue)::text as revenue,
        count(distinct f.invoice_id)::int as invoices,
        count(distinct f.customer_id)::int as customers,
        round(sum(f.revenue) / nullif(count(distinct f.customer_id), 0), 2)::text as aov
      from facts f
      where f.sale_date = any(${[dates.day, dates.lastWeek, dates.lastYear]}::date[])
      group by grouping sets (
        (f.sale_date),
        (f.sale_date, f.branch_id),
        (f.sale_date, f.credit_group),
        (f.sale_date, f.credit_group, f.staff_id)
      )
    `,
    sql<{ branchId: string; branchName: string }[]>`
      select b.id::text as branch_id, b.name as branch_name
      from branches b
      where ${branchCondition(sql, scope.branches, sql`b.id`)}
      order by lower(b.name), b.id
    `,
  ]);

  const doctorIds = [...new Set(rows.filter((row) => row.level === "staff" && row.creditGroup === "doctor").map((row) => row.staffId!))];
  const staff = await sql<{ id: string; name: string; source: DailyDoctorRow["source"] }[]>`
    select id::text as id, full_name as name, source from staff where id = any(${doctorIds}::bigint[])
  `;

  const figures = (matches: (row: FigureRow) => boolean): DailyFigures => {
    const values = (period: Period): Values => {
      const row = rows.find((candidate) => candidate.saleDate === dates[period] && matches(candidate));
      return row ? { revenue: row.revenue, invoices: row.invoices, customers: row.customers, aovPerCustomer: row.aov } : ZERO;
    };
    const current = values("day");
    const lastWeek = values("lastWeek");
    const lastYear = values("lastYear");
    return {
      revenue: { value: current.revenue, lastWeek: moneyChange(current.revenue, lastWeek.revenue), lastYear: moneyChange(current.revenue, lastYear.revenue) },
      invoices: { value: current.invoices, lastWeek: countChange(current.invoices, lastWeek.invoices), lastYear: countChange(current.invoices, lastYear.invoices) },
      customers: {
        value: current.customers,
        lastWeek: countChange(current.customers, lastWeek.customers),
        lastYear: countChange(current.customers, lastYear.customers),
      },
      aovPerCustomer: {
        value: current.aovPerCustomer,
        lastWeek: moneyChange(current.aovPerCustomer, lastWeek.aovPerCustomer),
        lastYear: moneyChange(current.aovPerCustomer, lastYear.aovPerCustomer),
      },
    };
  };

  const doctors = staff
    .map((member): DailyDoctorRow => ({
      staffId: member.id,
      name: member.name,
      source: member.source,
      ...figures((row) => row.level === "staff" && row.creditGroup === "doctor" && row.staffId === member.id),
    }))
    .sort(
      (a, b) =>
        moneyToSen(b.revenue.value) - moneyToSen(a.revenue.value) ||
        compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
        compareText(a.staffId, b.staffId),
    );
  const groups = GROUPS.filter(({ creditGroup }) => rows.some((row) => row.level === "group" && row.creditGroup === creditGroup)).map(
    ({ group, creditGroup }): DailyGroupRow => ({ group, ...figures((row) => row.level === "group" && row.creditGroup === creditGroup) }),
  );

  return {
    day,
    comparisonDays,
    total: figures((row) => row.level === "total"),
    branches: branches.map((branch) => ({ ...branch, ...figures((row) => row.level === "branch" && row.branchId === branch.branchId) })),
    doctors,
    groups,
  };
}

/** Same rule as the Overview's KPI changes: in integer sen; none when either side is null. */
function moneyChange<T extends Money | null>(value: T, base: T): KpiChange<T> {
  if (value === null || base === null) return { base, change: null as T, changePercent: null };
  const valueSen = moneyToSen(value);
  const baseSen = moneyToSen(base);
  return { base, change: senToMoney(valueSen - baseSen) as T, changePercent: percentChange(valueSen, baseSen) };
}

function countChange(value: number, base: number): KpiChange<number> {
  return { base, change: value - base, changePercent: percentChange(value, base) };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
