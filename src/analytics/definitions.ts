/**
 * Plain-language definitions of every metric the Analytics Service returns. The dashboard shows
 * them as explanations and the MCP server (#17) returns them with its answers, so Claude and the
 * charts describe numbers the same way. Keep these in step with the SQL and with CONTEXT.md.
 */
export const METRIC_DEFINITIONS = {
  revenue:
    "Revenue: the net amount (after discounts) of active sales on clinic days (Asia/Kuala_Lumpur) in the period, credited line by line to the staff named on each line. An invoice's discount lines, and any difference between its lines and its net amount, are spread across its lines in proportion to what each line charged (its amount after any item-level discount), so an invoice's credited lines add up exactly to its net amount. Cancelled sales are excluded; refunds are not deducted; a negative (return) sale reduces revenue. A sale whose line items are not synced yet counts its whole net amount (its revenue base) as \"line items not synced yet\". With a doctor filter, only revenue credited to those doctors counts.",
  invoices:
    "Invoices: the number of active sales (invoices) in the period. Cancelled sales are excluded. For a doctor (or with a doctor filter): the invoices with at least one line credited to them.",
  customers:
    "Customers: the number of different customers with at least one active sale in the period (counted per branch in a branch breakdown, once overall). For a doctor (or with a doctor filter): the customers with at least one line credited to them. Sales without a customer (walk-ins) count towards revenue but not here.",
  aovPerCustomer:
    "AOV per customer: revenue divided by customers (average spend per customer in the period), rounded to the sen; none when there are no customers. For a doctor: the doctor's revenue divided by the distinct customers with at least one line credited to that doctor in the period (counted per branch when split by branch).",
  creditedLine:
    "Credited line: one sold line of an invoice (not a discount line) with the amount it is credited with: its own charged amount (after any item-level discount) plus its share of the invoice's discount lines and of any gap to the invoice's net amount, shared in proportion to what each line charged (lines that charged nothing or less take no share; if no line charged anything, by quantity × unit price) in whole sen (leftover sen to the largest remainders, ties to the earlier line). A bill discount applies to amounts after item discounts, so a line that already gave most of its price away is never pushed below zero.",
  doctor:
    "Doctor: a staff member of kind \"doctor\". Short names on invoice lines (e.g. \"Dr Ong\") are matched to full staff names; the owner can correct a match and change anyone's kind in Settings → Doctors, and every figure follows at once. A name that matches no staff member (e.g. a deleted doctor) keeps its own entry, so past revenue stays attributed; once a name has revenue, a sync never moves it to someone else (it only suggests a match). A kind is guessed from the names (a \"Dr\" title → doctor; a shared-account word such as \"general\" in the FULL name → generic) until the owner sets it.",
  doctorRanking:
    "Doctor ranking: every doctor with credited lines in the period, by revenue (highest first). Non-doctor staff, generic accounts, lines with no staff and sales whose line items are not synced yet are shown as separate groups, never ranked with doctors.",
  itemsPerInvoice:
    "Average items per invoice: the number of credited lines (sold lines; discount lines excluded, return lines included) divided by the number of invoices those lines are on, to two decimals.",
  sharePercent:
    "Share of revenue: revenue divided by ALL revenue in the period and branches (doctors, other staff, generic accounts, no staff and not-yet-synced line items together), as a percentage to one decimal. The doctor filter does not change what it is a share of.",
  discount:
    "Discount: gross minus charged. Per credited line, gross is quantity × unit price (rounded to the sen) and charged is what the line was credited with — its amount after any item-level discount plus its share of the invoice's discount lines and of any gap to the invoice's net amount (shared in proportion to what each line charged, as for revenue). So an invoice discount on a sale with several doctors is shared between them the same way, and a doctor's discount is the sum over the lines credited to them. Only sold lines count: return lines (a negative quantity × unit price) are left out of every discount figure — they already reduce revenue — so an invoice with only returns is left out entirely, as is a sale with no sold line (e.g. only a discount line). Charged is before any refund: refunds are not discounts. Sales whose line items are not synced yet are not included (their lines are unknown); cancelled sales never count.",
  discountRate: "Discount rate: discount divided by gross (sold lines only; returns are left out), as a percentage to one decimal; none when gross is zero or less.",
  discountedInvoices:
    "Share of invoices discounted: of the invoices with at least one line credited to the doctor (or group), the percentage (one decimal) on which the doctor's share of the invoice's discount is over RM 0.05 (exactly 5 sen does not count).",
  discountTypes:
    "Discount types: every discount name used on sold lines — item discounts (a discount on one line) and discount lines (a discount on the whole invoice, e.g. \"5% DISCOUNT\") — grouped ignoring case and all spaces (\"5%DISCOUNT\" and \"5% discount\" are one type), with how many lines and invoices used it and the amount it took off (an item discount: the line's gross minus what it charged; a discount line: its amount). Any other difference between an invoice's lines and its net amount that its discount lines do not explain is shown as its own row (it can be negative), so the amounts add up to the total discount. Returns and their discounts are left out. With a doctor filter each type shows the part that fell on the selected doctors' lines (an invoice's discount lines are shared in proportion to what each line charged), rounded to the sen per type.",
  otherStaff: "Other staff: staff of kind \"other\" (e.g. nurses, groomers) — credited with their lines' revenue, grouped apart from doctors.",
  genericAccounts:
    "Generic accounts: shared logins of kind \"generic\" (e.g. a branch \"general\" account) — credited with their lines' revenue, grouped apart from doctors.",
  noStaffOnLine:
    "No staff on line: revenue of lines that name no staff member (and of an invoice amount with no sold line to credit it to).",
  pendingLineItems:
    "Line items not synced yet: the net amount of active sales whose line items have not been read since the sale was last changed (or whose invoice page could not be opened); the next sync reads them and credits them to staff. With a doctor filter these sales cannot be included (they are credited to nobody yet); pages say how many there are.",
  previousPeriod:
    "Previous period: the same number of days immediately before the selected period (e.g. 1–30 Sep is compared with 2–31 Aug).",
  lastYear: "Same period last year: the same calendar dates one year earlier (29 Feb becomes 28 Feb).",
  change:
    "Change: the value minus the comparison value; the percentage is the change divided by the comparison value, rounded to one decimal place, and absent when the comparison value is zero.",
  dataAsOf:
    "Data as of: for each branch, when the latest sync finished that read that branch's whole sale list (succeeded, or only some invoice pages could not be opened) up to the last day of the period (or, for a period that ends later, up to the day the sync ran). Syncing an older month does not make a later period fresher. Sales changed in Kreloses after that time are not included yet.",
} as const;

export type MetricName = keyof typeof METRIC_DEFINITIONS;
