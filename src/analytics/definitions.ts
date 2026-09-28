/**
 * Plain-language definitions of every metric the Analytics Service returns. The dashboard shows
 * them as explanations and the MCP server (#17) returns them with its answers, so Claude and the
 * charts describe numbers the same way. Keep these in step with the SQL and with CONTEXT.md.
 */
export const METRIC_DEFINITIONS = {
  revenue:
    "Revenue: the net amount (after discounts) of active sales on clinic days (Asia/Kuala_Lumpur) in the period, credited line by line to the staff named on each line. An invoice's discount lines, and any difference between its lines and its net amount, are spread across its lines in proportion to their gross amount (quantity × unit price), so an invoice's credited lines add up exactly to its net amount. Cancelled sales are excluded; refunds are not deducted; a negative (return) sale reduces revenue. A sale whose line items are not synced yet counts its whole net amount as \"line items not synced yet\". With a doctor filter, only revenue credited to those doctors counts.",
  invoices:
    "Invoices: the number of active sales (invoices) in the period. Cancelled sales are excluded. For a doctor (or with a doctor filter): the invoices with at least one line credited to them.",
  customers:
    "Customers: the number of different customers with at least one active sale in the period (counted per branch in a branch breakdown, once overall). For a doctor (or with a doctor filter): the customers with at least one line credited to them. Sales without a customer (walk-ins) count towards revenue but not here.",
  aovPerCustomer:
    "AOV per customer: revenue divided by customers (average spend per customer in the period), rounded to the sen; none when there are no customers. For a doctor: the doctor's revenue divided by the distinct customers with at least one line credited to that doctor in the period (counted per branch when split by branch).",
  creditedLine:
    "Credited line: one sold line of an invoice (not a discount line) with the amount it is credited with: its own charged amount (after any item-level discount) plus its share of the invoice's discount lines and of any gap to the invoice's net amount, shared in proportion to gross in whole sen (leftover sen to the largest remainders, ties to the earlier line).",
  doctor:
    "Doctor: a staff member of kind \"doctor\". Short names on invoice lines (e.g. \"Dr Ong\") are matched to full staff names; the owner can correct a match and change anyone's kind in Settings → Doctors, and every figure follows at once. A name that matches no staff member (e.g. a deleted doctor) keeps its own entry, so past revenue stays attributed.",
  doctorRanking:
    "Doctor ranking: every doctor with credited lines in the period, by revenue (highest first). Non-doctor staff, generic accounts, lines with no staff and sales whose line items are not synced yet are shown as separate groups, never ranked with doctors.",
  itemsPerInvoice:
    "Average items per invoice: the number of credited lines (sold lines; discount lines excluded, return lines included) divided by the number of invoices those lines are on, to two decimals.",
  sharePercent:
    "Share of revenue: revenue divided by ALL revenue in the period and branches (doctors, other staff, generic accounts, no staff and not-yet-synced line items together), as a percentage to one decimal. The doctor filter does not change what it is a share of.",
  otherStaff: "Other staff: staff of kind \"other\" (e.g. nurses, groomers) — credited with their lines' revenue, grouped apart from doctors.",
  genericAccounts:
    "Generic accounts: shared logins of kind \"generic\" (e.g. a branch \"general\" account) — credited with their lines' revenue, grouped apart from doctors.",
  noStaffOnLine:
    "No staff on line: revenue of lines that name no staff member (and of an invoice amount with no sold line to credit it to).",
  pendingLineItems:
    "Line items not synced yet: the net amount of active sales whose line items have not been read since the sale was last changed; the next sync reads them and credits them to staff.",
  previousPeriod:
    "Previous period: the same number of days immediately before the selected period (e.g. 1–30 Sep is compared with 2–31 Aug).",
  lastYear: "Same period last year: the same calendar dates one year earlier (29 Feb becomes 28 Feb).",
  change:
    "Change: the value minus the comparison value; the percentage is the change divided by the comparison value, rounded to one decimal place, and absent when the comparison value is zero.",
  dataAsOf:
    "Data as of: for each branch, when the latest successful sync finished that read that branch up to the last day of the period (or, for a period that ends later, up to the day the sync ran). Syncing an older month does not make a later period fresher. Sales changed in Kreloses after that time are not included yet.",
} as const;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
