import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import type { Money } from "@/lib/money";

import { branchScope, revenueFacts } from "./facts";

/** Sales whose line items are not synced yet (`METRIC_DEFINITIONS.pendingLineItems`). */
export interface PendingLineItems {
  invoices: number;
  /** Their revenue base, RM. */
  revenue: Money;
}

/**
 * Sales in the filter's dates and branches whose line items are not synced yet. The doctor filter
 * is ignored ON PURPOSE: those sales are credited to nobody yet, so a doctor-filtered view cannot
 * include them — pages show this count so the gap is never silent.
 */
export async function getPendingLineItems(sql: Sql, filter: Pick<GlobalFilter, "dateFrom" | "dateTo" | "branchIds">): Promise<PendingLineItems> {
  const [row] = await sql<PendingLineItems[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
    select count(distinct f.invoice_id)::int as invoices, coalesce(sum(f.revenue), 0)::numeric(14, 2)::text as revenue
    from facts f
    where f.credit_group = 'pending' and f.sale_date between ${filter.dateFrom}::date and ${filter.dateTo}::date
  `;
  return row!;
}
