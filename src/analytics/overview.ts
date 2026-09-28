import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import { moneyToSen, senToMoney, type Money } from "@/lib/money";

import { branchCondition, branchScope, revenueFacts } from "./facts";
import { comparisonPeriods, type DateRange } from "./periods";

/** A KPI's comparison with another period. */
export interface KpiChange<T> {
  /** The KPI in the comparison period. */
  base: T;
  /** value − base (null if either is null). */
  change: T;
  /** change ÷ |base| × 100, one decimal (half away from zero); null when base is zero or null. */
  changePercent: number | null;
}

export interface Kpi<T> {
  value: T;
  /** Against the same number of days immediately before (`OverviewKpis.previousPeriod`). */
  previousPeriod: KpiChange<T>;
  /** Against the same dates a year earlier (`OverviewKpis.lastYear`). */
  lastYear: KpiChange<T>;
}

/** The Overview's headline KPIs; definitions in `METRIC_DEFINITIONS` (./definitions.ts). */
export interface KpiSet {
  /** Net amount of active sales, RM. */
  revenue: Kpi<Money>;
  /** Active sales. */
  invoices: Kpi<number>;
  /** Distinct customers with an active sale. */
  customers: Kpi<number>;
  /** revenue ÷ customers, RM (null without customers). */
  aovPerCustomer: Kpi<Money | null>;
}

export interface BranchKpis extends KpiSet {
  branchId: string;
  branchName: string;
}

export interface OverviewKpis {
  period: DateRange;
  previousPeriod: DateRange;
  lastYear: DateRange;
  /** All the filter's branches together (customers counted once). */
  total: KpiSet;
  /** Every branch in the filter (all synced branches when none is selected), by name; zeros if it had no sales. */
  branches: BranchKpis[];
}

interface Values {
  revenue: Money;
  invoices: number;
  customers: number;
  aovPerCustomer: Money | null;
}

const ZERO: Values = { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null };
type PeriodKey = "current" | "previous" | "last_year";

/**
 * Overview KPIs for the global filter: revenue, invoices, customers and AOV per customer, in total
 * and per branch, each compared with the previous period and the same period last year. All sums
 * and averages are computed in SQL on exact `numeric`; only the changes are worked out here, in
 * integer sen. `doctorIds` is not applied yet (no doctors before #5).
 */
export async function getOverviewKpis(sql: Sql, filter: GlobalFilter): Promise<OverviewKpis> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const { previousPeriod, lastYear } = comparisonPeriods(period);
  const scope = branchScope(filter);

  const [rows, branches] = await Promise.all([
    sql<{ period: PeriodKey; branchId: string | null; revenue: string; invoices: number; customers: number; aov: string | null }[]>`
      with periods (period, date_from, date_to) as (
        values
          ('current', ${period.dateFrom}::date, ${period.dateTo}::date),
          ('previous', ${previousPeriod.dateFrom}::date, ${previousPeriod.dateTo}::date),
          ('last_year', ${lastYear.dateFrom}::date, ${lastYear.dateTo}::date)
      ),
      facts as (${revenueFacts(sql, scope)})
      select
        p.period,
        case when grouping(f.branch_id) = 0 then f.branch_id::text end as branch_id,
        sum(f.revenue)::text as revenue,
        count(distinct f.invoice_id)::int as invoices,
        count(distinct f.customer_id)::int as customers,
        round(sum(f.revenue) / nullif(count(distinct f.customer_id), 0), 2)::text as aov
      from periods p
      join facts f on f.sale_date between p.date_from and p.date_to
      group by grouping sets ((p.period), (p.period, f.branch_id))
    `,
    sql<{ branchId: string; branchName: string }[]>`
      select b.id::text as branch_id, b.name as branch_name
      from branches b
      where ${branchCondition(sql, scope, sql`b.id`)}
      order by lower(b.name), b.id
    `,
  ]);

  const values = (key: PeriodKey, branchId: string | null): Values => {
    const row = rows.find((candidate) => candidate.period === key && candidate.branchId === branchId);
    return row ? { revenue: row.revenue, invoices: row.invoices, customers: row.customers, aovPerCustomer: row.aov } : ZERO;
  };
  const kpis = (branchId: string | null): KpiSet => {
    const current = values("current", branchId);
    const previous = values("previous", branchId);
    const yearAgo = values("last_year", branchId);
    return {
      revenue: { value: current.revenue, previousPeriod: moneyChange(current.revenue, previous.revenue), lastYear: moneyChange(current.revenue, yearAgo.revenue) },
      invoices: { value: current.invoices, previousPeriod: countChange(current.invoices, previous.invoices), lastYear: countChange(current.invoices, yearAgo.invoices) },
      customers: { value: current.customers, previousPeriod: countChange(current.customers, previous.customers), lastYear: countChange(current.customers, yearAgo.customers) },
      aovPerCustomer: {
        value: current.aovPerCustomer,
        previousPeriod: moneyChange(current.aovPerCustomer, previous.aovPerCustomer),
        lastYear: moneyChange(current.aovPerCustomer, yearAgo.aovPerCustomer),
      },
    };
  };

  return {
    period,
    previousPeriod,
    lastYear,
    total: kpis(null),
    branches: branches.map((branch) => ({ ...branch, ...kpis(branch.branchId) })),
  };
}

function moneyChange<T extends Money | null>(value: T, base: T): KpiChange<T> {
  if (value === null || base === null) return { base, change: null as T, changePercent: null };
  const valueSen = moneyToSen(value);
  const baseSen = moneyToSen(base);
  return { base, change: senToMoney(valueSen - baseSen) as T, changePercent: percentChange(valueSen, baseSen) };
}

function countChange(value: number, base: number): KpiChange<number> {
  return { base, change: value - base, changePercent: percentChange(value, base) };
}

/** (value − base) ÷ |base| × 100 to one decimal, rounded half away from zero, in integer maths. */
export function percentChange(value: number, base: number): number | null {
  if (base === 0) return null;
  const numerator = (value - base) * 1000; // tenths of a percent × |base|
  const denominator = Math.abs(base);
  const tenths = Math.floor((Math.abs(numerator) * 2 + denominator) / (2 * denominator));
  return (numerator < 0 ? -tenths : tenths) / 10;
}
