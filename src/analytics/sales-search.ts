import type { Sql } from "@/db/sql";
import type { GlobalFilter, IsoDate } from "@/filters";
import type { Money } from "@/lib/money";

import { branchScope, factsScope, revenueFacts } from "./facts";
import type { DateRange } from "./periods";

/**
 * Sales search (MCP `search_sales`, #17): find individual invoices, each with its revenue and who
 * it is credited to. Built on `revenueFacts`, so an invoice's revenue and its split are exactly
 * what every other metric counts (`METRIC_DEFINITIONS.salesSearch`).
 */

/**
 * The most rows one page can hold, whatever the caller asks for. Kept small enough that a full page
 * (sent twice by the MCP server: structured and as text) stays well under Claude Code's MCP output
 * limit.
 */
export const SALES_SEARCH_MAX_PAGE_SIZE = 50;
export const SALES_SEARCH_DEFAULT_PAGE_SIZE = 20;

export type SalesSearchSort = "newest" | "oldest" | "largest" | "smallest";

/** What to look for, on top of the global filter's dates, branches and doctors. */
export interface SalesSearchCriteria {
  /** Part of the customer's name, any case. Walk-in sales (no customer) never match. */
  customer?: string;
  /** Part of the name of an item sold on the invoice (a credited line; discount lines are not items), any case. */
  item?: string;
  /** The invoice's revenue is at least this (RM, inclusive). */
  minRevenue?: Money;
  /** The invoice's revenue is at most this (RM, inclusive). */
  maxRevenue?: Money;
  /** Default `newest` (sale time, latest first); `largest` / `smallest` by the invoice's revenue. */
  sort?: SalesSearchSort;
  /** 1-based; default 1. */
  page?: number;
  /** Default 20, at most `SALES_SEARCH_MAX_PAGE_SIZE`. */
  pageSize?: number;
}

/** Revenue on one invoice credited to one staff member (or group). */
export interface SaleCredit {
  /** Null for "No staff on line" and "Line items not synced yet". */
  staffId: string | null;
  /** The staff member's full name, or the group's name. */
  name: string;
  creditGroup: "doctor" | "other" | "generic" | "no_staff" | "pending";
  revenue: Money;
  /** Credited item lines (0 for a sale whose line items are not synced yet). */
  lines: number;
}

export interface SaleSearchRow {
  invoiceId: string;
  /** The invoice number people see (e.g. INV-000123). */
  saleNumber: string | null;
  saleDate: IsoDate;
  branchId: string;
  branchName: string;
  /** Null for a walk-in sale. */
  customerName: string | null;
  /** The invoice's revenue: its net amount (the sum of its credited lines). */
  revenue: Money;
  /** False while its line items are not synced yet: the whole revenue is "Line items not synced yet". */
  lineItemsSynced: boolean;
  /** The whole invoice's revenue by who it is credited to, largest first. Adds up to `revenue`. */
  credits: SaleCredit[];
}

export interface SalesSearchResult {
  period: DateRange;
  page: number;
  pageSize: number;
  /** Every matching invoice, on all pages. */
  totalMatches: number;
  totalPages: number;
  /** The revenue of every matching invoice (whole invoices, all pages). */
  totalRevenue: Money;
  sales: SaleSearchRow[];
}

const GROUP_NAMES: Record<"no_staff" | "pending", string> = { no_staff: "No staff on line", pending: "Line items not synced yet" };

/**
 * Active sales in the filter's dates and branches that match every criterion given, one row per
 * invoice with its credited split. With `doctorIds`, only invoices with at least one line credited
 * to those doctors match (a sale whose line items are not synced yet is credited to nobody, so it
 * cannot match; nor can it match `item`) — but each row still shows the WHOLE invoice and its full
 * split. Revenue criteria and `totalRevenue` use each whole invoice's revenue.
 */
export async function searchSales(sql: Sql, filter: GlobalFilter, criteria: SalesSearchCriteria = {}): Promise<SalesSearchResult> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const pageSize = clamp(Math.floor(criteria.pageSize ?? SALES_SEARCH_DEFAULT_PAGE_SIZE), 1, SALES_SEARCH_MAX_PAGE_SIZE);
  const page = Math.max(1, Math.floor(criteria.page ?? 1));
  const inPeriod = sql`f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date`;

  const doctorMatch = filter.doctorIds
    ? sql`t.invoice_id in (select d.invoice_id from doctor_facts d where d.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date)`
    : sql`true`;
  const customerMatch = criteria.customer ? sql`c.name ilike ${containsPattern(criteria.customer)}` : sql`true`;
  const itemMatch = criteria.item
    ? sql`exists (
        select 1 from period_facts f join invoice_lines l on l.id = f.invoice_line_id
        where f.invoice_id = t.invoice_id and l.item_name ilike ${containsPattern(criteria.item)}
      )`
    : sql`true`;
  const minMatch = criteria.minRevenue !== undefined ? sql`t.revenue >= ${criteria.minRevenue}::numeric` : sql`true`;
  const maxMatch = criteria.maxRevenue !== undefined ? sql`t.revenue <= ${criteria.maxRevenue}::numeric` : sql`true`;

  const matches = sql`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })}),
    doctor_facts as (${revenueFacts(sql, factsScope(filter))}),
    period_facts as (select * from facts f where ${inPeriod}),
    invoice_totals as (
      select f.invoice_id, sum(f.revenue) as revenue, bool_and(f.credit_group <> 'pending') as line_items_synced
      from period_facts f group by f.invoice_id
    ),
    matches as (
      select t.invoice_id, t.revenue, t.line_items_synced, i.sale_number, i.sale_date, i.sale_at, i.branch_id, c.name as customer_name
      from invoice_totals t
      join invoices i on i.id = t.invoice_id
      left join customers c on c.id = i.customer_id
      where ${doctorMatch} and ${customerMatch} and ${itemMatch} and ${minMatch} and ${maxMatch}
    )
  `;
  const order = {
    newest: sql`m.sale_at desc, m.invoice_id desc`,
    oldest: sql`m.sale_at asc, m.invoice_id asc`,
    largest: sql`m.revenue desc, m.sale_at desc, m.invoice_id desc`,
    smallest: sql`m.revenue asc, m.sale_at desc, m.invoice_id desc`,
  }[criteria.sort ?? "newest"];

  const [[summary], rows] = await Promise.all([
    sql<{ totalMatches: number; totalRevenue: string }[]>`
      ${matches}
      select count(*)::int as total_matches, coalesce(sum(m.revenue), 0)::numeric(14, 2)::text as total_revenue from matches m
    `,
    sql<Omit<SaleSearchRow, "credits" | "branchName">[]>`
      ${matches}
      select
        m.invoice_id::text as invoice_id, m.sale_number, m.sale_date, m.branch_id::text as branch_id, m.customer_name,
        m.revenue::numeric(14, 2)::text as revenue, m.line_items_synced
      from matches m
      order by ${order}
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `,
  ]);

  const invoiceIds = rows.map((row) => row.invoiceId);
  const [credits, branches] = await Promise.all([
    invoiceIds.length === 0
      ? []
      : sql<(Omit<SaleCredit, "name"> & { invoiceId: string; staffName: string | null })[]>`
          with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
          select
            f.invoice_id::text as invoice_id, f.staff_id::text as staff_id, s.full_name as staff_name, f.credit_group,
            sum(f.revenue)::numeric(14, 2)::text as revenue, count(f.invoice_line_id)::int as lines
          from facts f
          left join staff s on s.id = f.staff_id
          where f.invoice_id = any(${invoiceIds}::bigint[])
          group by f.invoice_id, f.staff_id, s.full_name, f.credit_group
          order by sum(f.revenue) desc, lower(coalesce(s.full_name, '')), f.staff_id
        `,
    sql<{ id: string; name: string }[]>`select id::text as id, name from branches`,
  ]);
  const branchName = new Map(branches.map((row) => [row.id, row.name]));

  return {
    period,
    page,
    pageSize,
    totalMatches: summary!.totalMatches,
    totalPages: Math.ceil(summary!.totalMatches / pageSize),
    totalRevenue: summary!.totalRevenue,
    sales: rows.map((row) => ({
      ...row,
      branchName: branchName.get(row.branchId) ?? "",
      credits: credits
        .filter((line) => line.invoiceId === row.invoiceId)
        .map(({ staffId, staffName, creditGroup, revenue, lines }) => ({
          staffId,
          name: creditGroup === "no_staff" || creditGroup === "pending" ? GROUP_NAMES[creditGroup] : (staffName ?? ""),
          creditGroup,
          revenue,
          lines,
        })),
    })),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** An ILIKE pattern matching `text` anywhere, with `%`, `_` and `\` taken literally. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
