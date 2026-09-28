import type { Sql } from "@/db/sql";

import { branchCondition, revenueFacts, type BranchScope } from "./facts";

/**
 * THE definition of a service visit (`METRIC_DEFINITIONS.serviceVisit`), shared by every
 * visit-based metric: retention (#13) and the surgery post-op follow-up (#15). Build on these SQL
 * fragments instead of re-deriving visits.
 *
 * A service visit = a customer on a clinic day with at least one sold service line (Kreloses item
 * type 4, quantity above zero) on an active sale whose line items are synced. Built on
 * `revenueFacts`, so who a line is credited to is resolved at query time (remaps apply at once);
 * cancelled sales, sales whose line items are not synced yet (pending rows), unitemised remainders,
 * products, discount lines, returned lines and walk-ins (no customer) never make a visit.
 */

/** Kreloses ItemType of a service line (1 = product, 55 = discount line). */
export const SERVICE_ITEM_TYPE = 4;

/**
 * SQL: one row per credited SERVICE line that makes a service visit, at the scope's branches.
 * Columns: `customer_id` (bigint, never null), `sale_date` (date, clinic day), `branch_id`,
 * `invoice_id`, `invoice_line_id`, `staff_id` (who it is credited to now; null = no staff) and
 * `credit_group` ('doctor' | 'other' | 'generic' | 'no_staff').
 * A visit counts for a doctor when one of its lines has `credit_group = 'doctor'` and their `staff_id`.
 *
 *   sql`with lines as (${serviceVisitLines(sql, branchScope(filter))}) select …`
 */
export function serviceVisitLines(sql: Sql, branches: BranchScope) {
  return sql`
    select f.customer_id, f.sale_date, f.branch_id, f.invoice_id, f.invoice_line_id, f.staff_id, f.credit_group
    from (${revenueFacts(sql, { branches, staff: { all: true } })}) f
    join invoice_lines l on l.id = f.invoice_line_id
    where f.customer_id is not null and l.item_type = ${SERVICE_ITEM_TYPE}::int and l.quantity > 0
  `;
}

/** SQL: one row per service visit at the scope's branches — distinct `customer_id`, `sale_date`. */
export function serviceVisits(sql: Sql, branches: BranchScope) {
  return sql`select distinct v.customer_id, v.sale_date from (${serviceVisitLines(sql, branches)}) v`;
}

/**
 * SQL (a scalar `date`, null when nothing is synced): the latest clinic day with a synced sale (any
 * status) at the scope's branches — how far visits and returns can be seen
 * (`METRIC_DEFINITIONS.syncedThrough`). A visit's N-day follow-up window has passed once
 * `sale_date + N <= ${syncedThrough(…)}`.
 */
export function syncedThrough(sql: Sql, branches: BranchScope) {
  return sql`(select max(st.sale_date) from invoices st where ${branchCondition(sql, branches, sql`st.branch_id`)})`;
}
