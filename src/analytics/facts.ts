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
 *   revenue          numeric(12,2)  what the line earned: its credited amount less its share of any
 *                              refund (`credited_lines.revenue_amount`, #6). Sum THIS for revenue.
 *   credited_line_id bigint   null on a pending row (below)
 *   invoice_line_id  bigint   the credited line; null for an invoice's unitemised remainder and on
 *                              pending rows. `count(invoice_line_id)` = item lines.
 *   staff_alias_id   bigint   the staff name on the line (`staff_aliases`); null = no staff / pending
 *   staff_id         bigint   who that name is credited to NOW (alias → staff, resolved at query
 *                              time: a remap changes every figure at once); null = no staff / pending
 *   credit_group     text     'doctor' | 'other' | 'generic' (the staff kind NOW) | 'no_staff'
 *                              ("No staff on line") | 'pending' (line items not synced yet)
 *   gross_amount     numeric(12,2)  quantity × unit price of the line; null on pending rows
 *   credited_amount  numeric(12,2)  what the line was charged after every discount, BEFORE refunds
 *                              (`credited_lines.credited_amount`: its share of the invoice net); null
 *                              on pending rows. Discount = gross_amount − credited_amount (#12), so a
 *                              refund never counts as a discount.
 *
 * and the item sold (#9, resolved at query time from the owner's item rules and assignments via
 * `item_classifications`, so a rule change changes every figure at once, like a staff remap):
 *
 *   item_name        text     the line's item name as sent; null on the unitemised remainder / pending rows
 *   item_type        integer  Kreloses ItemType (1 product, 4 service); null likewise
 *   item_key         text     the item's identity (`itemKey`: spelling variants share it); null likewise
 *   mix_group        text     one of the eight groups (`MIX_GROUPS`) | 'unmapped' (no rule/assignment
 *                              matches the item) | 'no_item' (an invoice's unitemised remainder) |
 *                              'pending' (line items not synced yet)
 *   is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure   boolean flags of the item
 *                              (false on unmapped / no_item / pending rows); is_procedure ⇒ is_surgery
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
 * Every credited sen lands in exactly one `mix_group` (the eight groups, unmapped, no_item or
 * pending), so group totals always add up to revenue.
 */
export function revenueFacts(sql: Sql, scope: FactsScope) {
  return sql`
    select
      i.sale_date, i.branch_id, i.customer_id, i.id as invoice_id, c.revenue_amount as revenue,
      c.id as credited_line_id, c.invoice_line_id, c.staff_alias_id, a.staff_id,
      case when a.staff_id is null then 'no_staff' else s.kind end as credit_group,
      c.gross_amount, c.credited_amount,
      l.item_name, l.item_type, coalesce(k.item_key, l.item_name) as item_key,
      case when c.invoice_line_id is null then 'no_item' else coalesce(k.mix_group, 'unmapped') end as mix_group,
      coalesce(k.is_surgery, false) as is_surgery, coalesce(k.is_consult, false) as is_consult,
      coalesce(k.is_vaccine, false) as is_vaccine, coalesce(k.is_dental_scaling, false) as is_dental_scaling,
      coalesce(k.is_procedure, false) as is_procedure
    from invoices i
    join credited_lines c on c.invoice_id = i.id
    left join staff_aliases a on a.id = c.staff_alias_id
    left join staff s on s.id = a.staff_id
    left join invoice_lines l on l.id = c.invoice_line_id
    left join item_classifications k on k.item_name = l.item_name
    where i.status = 'active' and i.lines_current
      and ${branchCondition(sql, scope.branches, sql`i.branch_id`)}
      and ${staffCondition(sql, scope.staff, sql`a.staff_id`)}
    union all
    select
      i.sale_date, i.branch_id, i.customer_id, i.id, i.revenue_base,
      null::bigint, null::bigint, null::bigint, null::bigint, 'pending', null::numeric, null::numeric,
      null::text, null::integer, null::text, 'pending', false, false, false, false, false
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

/** A boolean SQL condition restricting `column` (a staff id) to the scope. */
export function staffCondition(sql: Sql, scope: StaffScope, column: ReturnType<Sql>) {
  if (scope.all) return sql`true`;
  if (scope.ids.length === 0) return sql`false`;
  return sql`${column} = any(${scope.ids}::bigint[])`;
}
