# Refunds come off the revenue base pro rata, kept apart from what a line was charged

Spec story 13 wants refunded invoices to update revenue on the next sync. Until #6, a refund was
recorded (`invoices.total_refunds`, the invoice page's `RefundInfo` / `CreditNoteInfo` in
`raw_detail`) but not deducted, because nobody has seen how Kreloses reports refunds on live data.
We still have not. We deduct them now, under an explicit assumption, isolated so that live data can
change it in one place:

- Kreloses's `TotalRefunds` is money given back, tax-inclusive like `Total`. The part of it that was
  net revenue is `totalRefunds × net ÷ total`, rounded half up to the sen, never more than the net,
  nothing when the net, total or refunds are not positive. A return sale (negative net) already
  reduces revenue through its own net, so its refund is not deducted again. Cancelled: 0.
- An invoice's **revenue base** = net − that refund part. It is defined twice and kept equal by a
  test and a runtime check: `invoiceRevenueBaseSen()` / `invoiceRefundSen()` in
  `src/attribution/credit.ts`, and the generated `invoices.revenue_base` (computed exactly in integer
  sen with `div()`).
- A credited line keeps what it was **charged** (`credited_amount`: its share of the invoice net,
  as before) and carries its **refund share** separately (`refund_amount`, spread over the lines in
  proportion to what each charged — exactly like the invoice discounts, ADR 0006). Its **revenue**
  is `revenue_amount = credited_amount − refund_amount` (generated); revenue metrics sum it
  (`revenueFacts.revenue`), and an invoice's lines add up to its revenue base exactly. The discount
  metric (#12) uses `gross_amount − credited_amount`, so a refund never shows up as a discount.

Rejected alternatives: subtracting the whole `TotalRefunds` from the net (over-deducts the tax on
tax-registered sales); spreading the refund by re-running the discount spread on a smaller base
(largest-remainder rounding is not monotone, so a line's "refund" could come out as −1 sen, and the
pre-refund amount would be lost for the discount metric); waiting for live data (the owner asked for
refunds to count, and the existing fixtures already carry refunds).

Risk: if Kreloses also books a refund as a separate negative "return" sale or credit note that the
Sale List lists, revenue would be reduced twice. The live smoke test prints the shapes of
`RefundInfo` / `CreditNoteInfo`; if they show that, `invoiceRefundSen` (and its SQL twin) becomes 0
for such invoices — a one-function change plus a migration. The #6 migration re-bases existing
invoices and turns their stale credited lines "not synced yet" (so the nightly sweep re-reads them).
