import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";

/**
 * The rows every revenue metric is computed from — THE place that decides what counts as revenue
 * and who it is credited to (#5: credited lines). One row per credited line of an active invoice,
 * with columns:
 *
 *   sale_date        date     the invoice's clinic day (Asia/Kuala_Lumpur)
 *   branch_id        bigint
 *   customer_id      bigint   null = walk-in (no customer)
 *   invoice_id       bigint
 *   revenue          numeric(12,2)  the credited amount (`credited_lines.credited_amount`)
 *   credited_line_id bigint   null on a pending row (below)
 *   invoice_line_id  bigint   the credited line; null for an invoice's unitemised remainder and on
 *                              pending rows. `count(invoice_line_id)` = item lines.
 *   staff_alias_id   bigint   the staff name on the line (`staff_aliases`); null = no staff / pending
 *   staff_id         bigint   who that name is credited to NOW (alias → staff, resolved at query
 *                              time: a remap changes every figure at once); null = no staff / pending
 *   credit_group     text     'doctor' | 'other' | 'generic' (the staff kind NOW) | 'no_staff'
 *                              ("No staff on line") | 'pending' (line items not synced yet)
 *   gross_amount     numeric(12,2)  quantity × unit price of the line; null on pending rows
 *
 * An active invoice whose line items are not current (`invoices.lines_current` false: never read,
 * or the header changed since) contributes ONE `pending` row carrying its revenue base
 * (`invoices.revenue_base`, the SQL twin of `invoiceRevenueBaseSen`), so revenue never drops
 * between a header sync and its line-item sync. Because an invoice's credited lines add up exactly
 * to its revenue base, `sum(revenue)`, `count(distinct invoice_id)` and
 * `count(distinct customer_id)` mean the same with or without line items.
 *
 * Scope: the filter's branches, and its doctors (`doctorIds` are `staff.id`s): with doctors
 * selected, only lines credited to them (no `no_staff` / `pending` rows).
 *
 * #9 (item groups) joins `invoice_lines` on `invoice_line_id` for the item name/type and adds the
 * mix group and surgery / consult / vaccine / dental flags as more columns here, resolved at query
 * time from its item rules (so changing a rule changes every figure, like a staff remap).
 */
export function revenueFacts(sql: Sql, scope: FactsScope) {
  return sql`
    select
      i.sale_date, i.branch_id, i.customer_id, i.id as invoice_id, c.credited_amount as revenue,
      c.id as credited_line_id, c.invoice_line_id, c.staff_alias_id, a.staff_id,
      case when a.staff_id is null then 'no_staff' else s.kind end as credit_group,
      c.gross_amount
    from invoices i
    join credited_lines c on c.invoice_id = i.id
    left join staff_aliases a on a.id = c.staff_alias_id
    left join staff s on s.id = a.staff_id
    where i.status = 'active' and i.lines_current
      and ${branchCondition(sql, scope.branches, sql`i.branch_id`)}
      and ${staffCondition(sql, scope.staff, sql`a.staff_id`)}
    union all
    select
      i.sale_date, i.branch_id, i.customer_id, i.id, i.revenue_base,
      null::bigint, null::bigint, null::bigint, null::bigint, 'pending', null::numeric
    from invoices i
    where i.status = 'active' and not i.lines_current
      and ${branchCondition(sql, scope.branches, sql`i.branch_id`)}
      and ${scope.staff.all ? sql`true` : sql`false`}
  `;
}

/** Which branches and staff a query covers. */
export interface FactsScope {
  branches: BranchScope;
  staff: StaffScope;
}

/** Which branches a query covers: all of them, or these ids (possibly none). */
export type BranchScope = { all: true } | { all: false; ids: string[] };
/** Which staff (doctors) a query covers: all revenue, or only lines credited to these staff ids. */
export type StaffScope = { all: true } | { all: false; ids: string[] };

const BIGINT_ID = /^[1-9][0-9]{0,17}$/;

/** The filter's branches and doctors. */
export function factsScope(filter: Pick<GlobalFilter, "branchIds" | "doctorIds">): FactsScope {
  return { branches: branchScope(filter), staff: staffScope(filter) };
}

/** The filter's branches. Ids that cannot be a branch id match nothing (never "all branches"). */
export function branchScope(filter: Pick<GlobalFilter, "branchIds">): BranchScope {
  if (!filter.branchIds) return { all: true };
  return { all: false, ids: filter.branchIds.filter((id) => BIGINT_ID.test(id)) };
}

/** The filter's doctors (staff ids). Ids that cannot be a staff id match nothing. */
export function staffScope(filter: Pick<GlobalFilter, "doctorIds">): StaffScope {
  if (!filter.doctorIds) return { all: true };
  return { all: false, ids: filter.doctorIds.filter((id) => BIGINT_ID.test(id)) };
}

/** A boolean SQL condition restricting `column` (a branch id) to the scope. */
export function branchCondition(sql: Sql, scope: BranchScope, column: ReturnType<Sql>) {
  if (scope.all) return sql`true`;
  if (scope.ids.length === 0) return sql`false`;
  return sql`${column} = any(${scope.ids}::bigint[])`;
}

function staffCondition(sql: Sql, scope: StaffScope, column: ReturnType<Sql>) {
  if (scope.all) return sql`true`;
  if (scope.ids.length === 0) return sql`false`;
  return sql`${column} = any(${scope.ids}::bigint[])`;
}
