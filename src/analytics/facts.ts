import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";

/**
 * The rows every revenue metric is computed from — THE place that decides what counts as revenue.
 * One row per revenue-bearing unit, with columns:
 *
 *   sale_date date, branch_id bigint, customer_id bigint (null = walk-in), invoice_id bigint,
 *   revenue numeric(12,2)
 *
 * Today (#4) a unit is an active invoice and its revenue the invoice's net amount. #5 swaps this
 * body for credited lines (one row per line, `revenue` = the credited net amount, plus a doctor
 * column and the doctor filter); because credited lines sum exactly to the invoice net, every
 * metric built on these columns (`sum(revenue)`, `count(distinct invoice_id)`,
 * `count(distinct customer_id)`) keeps its meaning.
 */
export function revenueFacts(sql: Sql, scope: BranchScope) {
  return sql`
    select i.sale_date, i.branch_id, i.customer_id, i.id as invoice_id, i.net_amount as revenue
    from invoices i
    where i.status = 'active' and ${branchCondition(sql, scope, sql`i.branch_id`)}
  `;
}

/** Which branches a query covers: all of them, or these ids (possibly none). */
export type BranchScope = { all: true } | { all: false; ids: string[] };

const BIGINT_ID = /^[1-9][0-9]{0,17}$/;

/** The filter's branches. Ids that cannot be a branch id match nothing (never "all branches"). */
export function branchScope(filter: Pick<GlobalFilter, "branchIds">): BranchScope {
  if (!filter.branchIds) return { all: true };
  return { all: false, ids: filter.branchIds.filter((id) => BIGINT_ID.test(id)) };
}

/** A boolean SQL condition restricting `column` (a branch id) to the scope. */
export function branchCondition(sql: Sql, scope: BranchScope, column: ReturnType<Sql>) {
  if (scope.all) return sql`true`;
  if (scope.ids.length === 0) return sql`false`;
  return sql`${column} = any(${scope.ids}::bigint[])`;
}
