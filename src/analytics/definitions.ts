/**
 * Plain-language definitions of every metric the Analytics Service returns. The dashboard shows
 * them as explanations and the MCP server (#17) returns them with its answers, so Claude and the
 * charts describe numbers the same way. Keep these in step with the SQL and with CONTEXT.md.
 */
export const METRIC_DEFINITIONS = {
  revenue:
    "Revenue: the net amount (after discounts) of active sales on clinic days (Asia/Kuala_Lumpur) in the period. Cancelled sales are excluded; refunds are not deducted; a negative (return) sale reduces revenue. Until line items are synced it is the invoice's net amount; then it becomes the sum of credited lines, which add up to the same total.",
  invoices: "Invoices: the number of active sales (invoices) in the period. Cancelled sales are excluded.",
  customers:
    "Customers: the number of different customers with at least one active sale in the period (counted per branch in a branch breakdown, once overall). Sales without a customer (walk-ins) count towards revenue but not here.",
  aovPerCustomer:
    "AOV per customer: revenue divided by customers (average spend per customer in the period), rounded to the sen; none when there are no customers.",
  previousPeriod:
    "Previous period: the same number of days immediately before the selected period (e.g. 1–30 Sep is compared with 2–31 Aug).",
  lastYear: "Same period last year: the same calendar dates one year earlier (29 Feb becomes 28 Feb).",
  change:
    "Change: the value minus the comparison value; the percentage is the change divided by the comparison value, rounded to one decimal place, and absent when the comparison value is zero.",
  dataAsOf:
    "Data as of: for each branch, when the latest successful sync finished that read that branch up to the last day of the period (or, for a period that ends later, up to the day the sync ran). Syncing an older month does not make a later period fresher. Sales changed in Kreloses after that time are not included yet.",
} as const;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
