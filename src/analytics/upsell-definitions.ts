/**
 * Plain-language definitions of the upsell metrics (`getConsultAttachRates`,
 * `getItemsPerInvoiceTrend`, ./upsell.ts), part of `METRIC_DEFINITIONS` (./definitions.ts). Keep
 * them in step with the SQL and with CONTEXT.md ("Upsell").
 */
export const UPSELL_DEFINITIONS = {
  consultInvoice:
    "Consult invoice: for a doctor, an active sale on a clinic day (Asia/Kuala_Lumpur) in the period, at the selected branches, with at least one consult line credited to that doctor — a line whose item has the consult flag (CONSULTATION services and the TCVM examination) and was sold (quantity above zero: a free consult counts, a returned one does not). An invoice with consult lines of two doctors is a consult invoice of each. An unmapped item (one no item rule or assignment recognises) is never a consult line, so it never makes a consult invoice, whatever its name; once the owner maps it as a consult in Settings → Items it does, past periods included. Sales whose line items are not synced yet cannot be classified and are left out (pages say how many there are); cancelled sales never count. Only doctors have consult invoices: consults credited to other staff, generic accounts or no staff are in no doctor's figures.",
  attachRate:
    "Attach rate: the share of a doctor's consult invoices that also include an add-on, as a percentage to one decimal (none without consult invoices). An add-on is a line on the same invoice that is not a consult line and charged more than zero (its own amount, after any item-level discount): a free add-on, a returned item or a discount line never counts, while an add-on whose credited amount an invoice-level discount took to zero still counts. An unmapped item (one no item rule or assignment recognises) counts as a product or a second service by its Kreloses item type but never as diagnostics; when the owner maps items in Settings → Items, the rates change at once, past periods included. Whole invoice (the default) counts add-ons credited to anyone on the invoice — the visit's basket, e.g. an X-ray done by a colleague; doctor's own lines counts only add-ons credited to that doctor. All doctors together pools every doctor's consult invoices in the period and branches (an invoice with two consulting doctors counts for each); the doctor filter does not change it.",
  diagnosticsAttach:
    "Diagnostics attach rate: consult invoices with at least one add-on in the Diagnostics service group (e.g. a blood test, X-ray or ultrasound) ÷ consult invoices.",
  productAttach:
    "Product attach rate: consult invoices with at least one add-on that is a product (Kreloses item type \"product\": medicines, food, retail items) ÷ consult invoices.",
  secondServiceAttach:
    "Second-service attach rate: consult invoices with at least one add-on that is a service (Kreloses item type \"service\") other than a consult — e.g. a surgery, vaccination, treatment or X-ray — ÷ consult invoices. A diagnostic service (an X-ray) counts both here and as diagnostics.",
  anyAddOnAttach:
    "Any add-on: consult invoices with at least one add-on of any of the three kinds (diagnostics, a product or a second service) ÷ consult invoices.",
  itemsPerInvoiceTrend:
    "Items per invoice over time: each doctor's average items per invoice (their credited lines ÷ the invoices with at least one line credited to them, exactly as on the Doctors page) per calendar month of clinic days, within the selected dates, branches and doctors. A month is partial when it is the current month (so far) or the date range covers only part of it; months after the current one are not shown. Sales whose line items are not synced yet are credited to nobody, so they are in no doctor's figures.",
} as const;

/** The names of the upsell metrics in `METRIC_DEFINITIONS`. */
export const UPSELL_METRICS = Object.keys(UPSELL_DEFINITIONS) as (keyof typeof UPSELL_DEFINITIONS)[];
