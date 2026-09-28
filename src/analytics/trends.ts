import type { Sql } from "@/db/sql";
import { addYears, clinicToday, endOfMonth, type GlobalFilter, type IsoDate } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";

import { branchScope, factsScope, revenueFacts } from "./facts";
import { percentChange } from "./overview";
import type { DateRange } from "./periods";
import { serviceLineCondition } from "./service-lines";

/**
 * Trends (spec stories 37–39): each doctor's figures per clinic month, and year on year per doctor
 * and branch. Built on `revenueFacts` (credited lines, staff resolved at query time); definitions in
 * `METRIC_DEFINITIONS.monthlyTrend` / `.yearOnYear`. Every sum and average is computed in SQL on
 * exact `numeric`; only the % changes are worked out here, in integer sen (`percentChange`).
 *
 * Only doctors (staff of kind doctor) get a series or a row. Sales whose line items are not synced
 * yet are credited to nobody, so they are in no series (pages say how many there are).
 */

/**
 * Surgery and consult revenue come from the item → service-mix groups of #9: the `is_surgery` /
 * `is_consult` flags on `revenueFacts` (`serviceLineCondition`, ./service-lines.ts — the same
 * definition as the Mix page and the Overview tiles). With item groups in place this is `true`, so
 * the two measures are offered (`availableTrendMeasures`) and their figures are never `null`.
 */
export const ITEM_GROUP_MEASURES_AVAILABLE: boolean = true;

/** Surgery / consult revenue, summed from `revenueFacts` rows aliased `f`. */
function itemGroupRevenue(sql: Sql) {
  return ITEM_GROUP_MEASURES_AVAILABLE
    ? sql`
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "surgery")}), 0)::numeric(14, 2)::text as surgery_revenue,
        coalesce(sum(f.revenue) filter (where ${serviceLineCondition(sql, "consult")}), 0)::numeric(14, 2)::text as consult_revenue
      `
    : sql`null::text as surgery_revenue, null::text as consult_revenue`;
}

/** What a trend chart can plot per doctor and month. */
export type TrendMeasure = "revenue" | "aovPerCustomer" | "surgeryRevenue" | "consultRevenue";

export interface TrendMeasureInfo {
  measure: TrendMeasure;
  label: string;
  /** The measure's name inside a sentence ("monthly revenue and AOV per customer per doctor"). */
  noun: string;
  /** Needs item groups (#9); hidden until `ITEM_GROUP_MEASURES_AVAILABLE`. */
  needsItemGroups: boolean;
}

/** Every trend measure, in switch order. All are RM amounts. */
export const TREND_MEASURES: readonly TrendMeasureInfo[] = [
  { measure: "revenue", label: "Revenue", noun: "revenue", needsItemGroups: false },
  { measure: "aovPerCustomer", label: "AOV per customer", noun: "AOV per customer", needsItemGroups: false },
  { measure: "surgeryRevenue", label: "Surgery revenue", noun: "surgery revenue", needsItemGroups: true },
  { measure: "consultRevenue", label: "Consult revenue", noun: "consult revenue", needsItemGroups: true },
];

/** The measures that can be shown now (surgery / consult only once item groups exist). */
export function availableTrendMeasures(): TrendMeasureInfo[] {
  return TREND_MEASURES.filter((info) => !info.needsItemGroups || ITEM_GROUP_MEASURES_AVAILABLE);
}

/** One calendar month of a trend, as far as the date range (and today) covers it. */
export interface TrendMonth {
  /** `'YYYY-MM'` (clinic calendar month). */
  month: string;
  /** The month's days inside the date range. */
  dateFrom: IsoDate;
  dateTo: IsoDate;
  /** True when the figures are not for the whole month: see `partialReason`. */
  partial: boolean;
  /**
   * `current_month`: the month is still going (it contains today and the range reaches today);
   * `cut_by_range`: the date range starts after its first or ends before its last day.
   */
  partialReason: "current_month" | "cut_by_range" | null;
}

/** A doctor's figures in a month (or a whole range). */
export interface TrendFigures {
  /** Revenue credited to the doctor, RM (`METRIC_DEFINITIONS.revenue`). "0.00" in a month without any. */
  revenue: Money;
  /** Invoices with at least one line credited to the doctor. */
  invoices: number;
  /** Distinct customers with at least one line credited to the doctor. */
  customers: number;
  /** revenue ÷ customers, rounded to the sen; null without customers. */
  aovPerCustomer: Money | null;
  /** Revenue of surgery lines (`METRIC_DEFINITIONS.surgeryRevenue`); null only if item groups were unavailable. */
  surgeryRevenue: Money | null;
  /** Revenue of consult lines (`METRIC_DEFINITIONS.consultRevenue`); null only if item groups were unavailable. */
  consultRevenue: Money | null;
}

export interface TrendPoint extends TrendFigures {
  month: string;
}

export interface DoctorTrend {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
  active: boolean;
  /** The whole range (customers counted once over it). */
  total: TrendFigures;
  /** One point per month of `MonthlyTrends.months`, in the same order (zeros where nothing was credited). */
  points: TrendPoint[];
}

export interface MonthlyTrends {
  period: DateRange;
  months: TrendMonth[];
  /** Doctors with at least one line credited to them in the range, by total revenue (highest first), then name. */
  doctors: DoctorTrend[];
}

/**
 * The calendar months a date range overlaps, oldest first, up to the current month (`today`'s):
 * later months have no sales yet and are left out. Each month says which of its days are in the
 * range and whether its figures are partial (the current month, or a month the range cuts).
 */
export function trendMonths(period: DateRange, today: IsoDate): TrendMonth[] {
  const months: TrendMonth[] = [];
  const lastMonth = [period.dateTo.slice(0, 7), today.slice(0, 7)].sort()[0]!;
  for (let month = period.dateFrom.slice(0, 7); month <= lastMonth; month = nextMonth(month)) {
    const monthStart = `${month}-01`;
    const monthEnd = endOfMonth(monthStart);
    const dateFrom = period.dateFrom > monthStart ? period.dateFrom : monthStart;
    const dateTo = period.dateTo < monthEnd ? period.dateTo : monthEnd;
    const current = monthStart <= today && today <= monthEnd && dateTo >= today;
    const cut = dateFrom !== monthStart || dateTo !== monthEnd;
    const partialReason = current ? "current_month" : cut ? "cut_by_range" : null;
    months.push({ month, dateFrom, dateTo, partial: partialReason !== null, partialReason });
  }
  return months;
}

function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

/** Figures for a month in which nothing was credited. */
export function emptyTrendFigures(): TrendFigures {
  return {
    revenue: "0.00",
    invoices: 0,
    customers: 0,
    aovPerCustomer: null,
    surgeryRevenue: ITEM_GROUP_MEASURES_AVAILABLE ? "0.00" : null,
    consultRevenue: ITEM_GROUP_MEASURES_AVAILABLE ? "0.00" : null,
  };
}

interface FigureRow {
  staffId: string;
  /** null on a doctor's whole-range row. */
  month: string | null;
  revenue: string;
  invoices: number;
  customers: number;
  aov: string | null;
  surgeryRevenue: string | null;
  consultRevenue: string | null;
}

function toFigures(row: FigureRow): TrendFigures {
  return {
    revenue: row.revenue,
    invoices: row.invoices,
    customers: row.customers,
    aovPerCustomer: row.aov,
    surgeryRevenue: row.surgeryRevenue,
    consultRevenue: row.consultRevenue,
  };
}

/**
 * Each doctor's revenue, invoices, customers, AOV per customer, surgery revenue and consult revenue
 * (#9 item groups) per clinic month of the global filter's dates (`trendMonths`: months
 * after the current one are left out), within its branches and doctors. AOV per customer in a month
 * = the doctor's revenue that month ÷ distinct customers with at least one line credited to them
 * that month (in the filter's branches together). `options.now` sets "today" (default: now).
 */
export async function getMonthlyTrends(sql: Sql, filter: GlobalFilter, options: { now?: Date } = {}): Promise<MonthlyTrends> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const months = trendMonths(period, clinicToday(options.now));
  if (months.length === 0) return { period, months, doctors: [] };
  const from = months[0]!.dateFrom;
  const to = months.at(-1)!.dateTo;

  // `sale_date` is the invoice's clinic (KL) day, so its calendar month is the clinic month.
  const rows = await sql<FigureRow[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))}),
    f as (
      select facts.*, to_char(facts.sale_date, 'YYYY-MM') as month
      from facts
      where facts.credit_group = 'doctor' and facts.sale_date between ${from}::date and ${to}::date
    )
    select
      f.staff_id::text as staff_id,
      case when grouping(f.month) = 0 then f.month end as month,
      sum(f.revenue)::text as revenue,
      count(distinct f.invoice_id)::int as invoices,
      count(distinct f.customer_id)::int as customers,
      round(sum(f.revenue) / nullif(count(distinct f.customer_id), 0), 2)::text as aov,
      ${itemGroupRevenue(sql)}
    from f
    group by grouping sets ((f.staff_id), (f.staff_id, f.month))
  `;
  const staff = await doctorsById(sql, rows.map((row) => row.staffId));

  const doctors = [...staff.values()]
    .map((member): DoctorTrend => {
      const own = rows.filter((row) => row.staffId === member.id);
      const byMonth = new Map(own.filter((row) => row.month !== null).map((row) => [row.month!, toFigures(row)]));
      return {
        staffId: member.id,
        name: member.name,
        source: member.source,
        active: member.active,
        total: toFigures(own.find((row) => row.month === null)!),
        points: months.map(({ month }) => ({ month, ...(byMonth.get(month) ?? emptyTrendFigures()) })),
      };
    })
    .sort((a, b) => moneyToSen(b.total.revenue) - moneyToSen(a.total.revenue) || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.staffId, b.staffId));
  return { period, months, doctors };
}

/**
 * Every doctor who can have a trend line (kind doctor, with a name on invoice lines — the doctors
 * `listDoctors` offers), in colour-slot order: active doctors in the Kreloses staff list first, then
 * the rest (inactive, or known only from invoice lines, e.g. a doctor who left), each group by name.
 * Pass the ids to `stableSeriesSlots` with this order, so current doctors get the 8 colours and a
 * doctor keeps their colour whatever the filter shows.
 */
export async function listTrendDoctors(sql: Sql): Promise<TrendDoctor[]> {
  return sql<TrendDoctor[]>`
    select s.id::text as id, s.full_name as name, s.source, s.active from staff s
    where s.kind = 'doctor' and exists (select 1 from staff_aliases a where a.staff_id = s.id)
    order by (s.source = 'kreloses' and s.active) desc, lower(s.full_name), s.id
  `;
}

/** A calendar year of the year-on-year table. */
export interface YearColumn {
  year: number;
  /** 1 Jan – 31 Dec, or 1 Jan – today for the current year. */
  dateFrom: IsoDate;
  dateTo: IsoDate;
  /** The current year (year to date). */
  partial: boolean;
  /**
   * What the year's change is measured against: the whole previous year; for the current (partial)
   * year the same dates a year earlier (1 Jan – today last year), so a part year is never compared
   * with a whole one. null for the first year shown.
   */
  comparedWith: DateRange | null;
}

/** A doctor's figures in a year (or its comparison period). */
export interface YearFigures {
  revenue: Money;
  invoices: number;
  customers: number;
  aovPerCustomer: Money | null;
}

export interface YearOnYearCell extends YearFigures {
  year: number;
  /** The figures in `YearColumn.comparedWith`; null for the first year shown. */
  base: YearFigures | null;
  /** (revenue − base revenue) ÷ |base revenue| × 100, one decimal; null without a base or when it is zero. */
  revenueChangePercent: number | null;
  /** The same for AOV per customer; null when either AOV is missing or the base is zero. */
  aovChangePercent: number | null;
}

export interface YearOnYearRow {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
  /** null: the doctor at all the filter's branches together (only for a doctor with figures at more than one branch). */
  branchId: string | null;
  branchName: string | null;
  /** One cell per `YearOnYear.years`, same order (zeros for a year without revenue). */
  years: YearOnYearCell[];
}

export interface YearOnYear {
  /** From the first year with a sale in the filter's branches to the current year; empty without sales. */
  years: YearColumn[];
  /** Doctors by name; for each, the all-branches row (if any) and then one row per branch they have revenue at, by branch name. */
  rows: YearOnYearRow[];
}

const ZERO_YEAR: YearFigures = { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null };

/**
 * Year on year per doctor and branch: each doctor's revenue, invoices, customers and AOV per
 * customer per calendar year, from the first year with any sale in the filter's branches up to the
 * current year (year to date, flagged partial). The date range does NOT apply (the table compares
 * whole years); the branch and doctor filters do. Each full year's change is against the previous
 * year; the current year's against the same dates last year. `options.now` sets "today".
 * The filter's dates, if given, are ignored.
 */
export async function getYearOnYear(sql: Sql, filter: Partial<GlobalFilter>, options: { now?: Date } = {}): Promise<YearOnYear> {
  const today = clinicToday(options.now);
  const currentYear = Number(today.slice(0, 4));
  const [first] = await sql<{ firstDate: string | null }[]>`
    with everything as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
    select min(f.sale_date)::text as first_date from everything f where f.sale_date <= ${today}::date
  `;
  if (!first?.firstDate) return { years: [], rows: [] };

  const years: YearColumn[] = [];
  for (let year = Number(first.firstDate.slice(0, 4)); year <= currentYear; year += 1) {
    const partial = year === currentYear;
    const comparedWith =
      years.length === 0 ? null : { dateFrom: `${year - 1}-01-01`, dateTo: partial ? addYears(today, -1) : `${year - 1}-12-31` };
    years.push({ year, dateFrom: `${year}-01-01`, dateTo: partial ? today : `${year}-12-31`, partial, comparedWith });
  }

  // Every period asked for: each year, plus the current year's "same dates last year".
  const periods = new Map<string, DateRange>();
  for (const column of years) {
    periods.set(periodKey(column.dateFrom, column.dateTo), { dateFrom: column.dateFrom, dateTo: column.dateTo });
    if (column.comparedWith) periods.set(periodKey(column.comparedWith.dateFrom, column.comparedWith.dateTo), column.comparedWith);
  }
  const keys = [...periods.keys()];
  const rows = await sql<{ period: string; staffId: string; branchId: string | null; revenue: string; invoices: number; customers: number; aov: string | null }[]>`
    with periods as (
      select * from unnest(${keys}::text[], ${keys.map((key) => periods.get(key)!.dateFrom)}::date[], ${keys.map((key) => periods.get(key)!.dateTo)}::date[])
        as p(period, date_from, date_to)
    ),
    facts as (${revenueFacts(sql, factsScope(filter))})
    select
      p.period,
      f.staff_id::text as staff_id,
      case when grouping(f.branch_id) = 0 then f.branch_id::text end as branch_id,
      sum(f.revenue)::text as revenue,
      count(distinct f.invoice_id)::int as invoices,
      count(distinct f.customer_id)::int as customers,
      round(sum(f.revenue) / nullif(count(distinct f.customer_id), 0), 2)::text as aov
    from periods p
    join facts f on f.sale_date between p.date_from and p.date_to
    where f.credit_group = 'doctor'
    group by grouping sets ((p.period, f.staff_id), (p.period, f.staff_id, f.branch_id))
  `;
  const [staff, branches] = await Promise.all([
    doctorsById(sql, rows.map((row) => row.staffId)),
    sql<{ id: string; name: string }[]>`select id::text as id, name from branches`,
  ]);
  const branchName = new Map(branches.map((row) => [row.id, row.name]));
  const figures = new Map(rows.map((row) => [`${row.period}|${row.staffId}|${row.branchId ?? ""}`, row]));
  const figuresFor = (range: DateRange, staffId: string, branchId: string | null): YearFigures => {
    const row = figures.get(`${periodKey(range.dateFrom, range.dateTo)}|${staffId}|${branchId ?? ""}`);
    return row ? { revenue: row.revenue, invoices: row.invoices, customers: row.customers, aovPerCustomer: row.aov } : ZERO_YEAR;
  };

  const result: YearOnYearRow[] = [];
  const doctors = [...staff.values()].sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.id, b.id));
  for (const doctor of doctors) {
    const doctorBranches = [...new Set(rows.filter((row) => row.staffId === doctor.id && row.branchId !== null).map((row) => row.branchId!))].sort(
      (a, b) => compareText((branchName.get(a) ?? "").toLowerCase(), (branchName.get(b) ?? "").toLowerCase()) || compareText(a, b),
    );
    const branchRows: (string | null)[] = doctorBranches.length > 1 ? [null, ...doctorBranches] : doctorBranches;
    for (const branchId of branchRows) {
      result.push({
        staffId: doctor.id,
        name: doctor.name,
        source: doctor.source,
        branchId,
        branchName: branchId === null ? null : (branchName.get(branchId) ?? ""),
        years: years.map((column): YearOnYearCell => {
          const current = figuresFor(column, doctor.id, branchId);
          const base = column.comparedWith ? figuresFor(column.comparedWith, doctor.id, branchId) : null;
          return {
            year: column.year,
            ...current,
            base,
            revenueChangePercent: base ? percentChange(moneyToSen(current.revenue), moneyToSen(base.revenue)) : null,
            aovChangePercent:
              base && current.aovPerCustomer !== null && base.aovPerCustomer !== null
                ? percentChange(moneyToSen(current.aovPerCustomer), moneyToSen(base.aovPerCustomer))
                : null,
          };
        }),
      });
    }
  }
  return { years, rows: result };
}

function periodKey(dateFrom: IsoDate, dateTo: IsoDate): string {
  return `${dateFrom}..${dateTo}`;
}

export interface TrendDoctor {
  id: string;
  name: string;
  source: "kreloses" | "alias_only";
  active: boolean;
}

/** The staff rows for these ids (all of kind doctor: the queries above keep only doctor lines). */
async function doctorsById(sql: Sql, ids: string[]): Promise<Map<string, TrendDoctor>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const members = await sql<TrendDoctor[]>`
    select id::text as id, full_name as name, source, active from staff where id = any(${unique}::bigint[])
  `;
  return new Map(members.map((member) => [member.id, member]));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
