import type { Sql } from "@/db/sql";

/**
 * THE "average items per invoice" definition (`METRIC_DEFINITIONS.itemsPerInvoice`, #5), as an SQL
 * aggregate over a group of `revenueFacts` rows aliased `f`: credited item lines (sold lines;
 * discount lines are not credited lines, return lines count) ÷ the distinct invoices those rows are
 * on, rounded to 2 decimals (`numeric`; null without invoices). Over one doctor's rows it is "their
 * item lines ÷ their invoices". The Doctors page (`getDoctorRanking`) and the Upsell page's monthly
 * series (`getItemsPerInvoiceTrend`) both use it, so the two can never disagree.
 */
export function itemsPerInvoiceSql(sql: Sql) {
  return sql`round(count(f.invoice_line_id)::numeric / nullif(count(distinct f.invoice_id), 0), 2)`;
}
