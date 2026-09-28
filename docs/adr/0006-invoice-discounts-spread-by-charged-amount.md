# Invoice discounts are spread in proportion to what each line charged, not its gross

The spec's Attribution & Rules module says an invoice's discount lines (Kreloses ItemType 55) and
any gap to the invoice net are spread across its lines "in proportion to their gross amounts"
(quantity × unit price); its Solution section only says "in proportion". We spread in proportion
to each line's CHARGED amount (`Amount`, after any item-level discount) instead. Without item
discounts the two are identical. With them, spreading by gross gives a line extra invoice discount
it never received and can push it negative: Dr A's 100.00 service with a 90 % item discount
(charged 10.00) next to Dr B's 100.00, with a 60.00 bill discount, would credit Dr A −20.00 by
gross, but 4.55 by charged amount (Dr B 45.45). A "5 % off the bill" discount is taken off the
amounts after item discounts, so that is what it is shared by.

Lines that charged nothing or less (free lines, return lines) take no share while any line charged
more than zero; if none did, the spread falls back to |gross|, then to equal shares. Shares are
whole sen by largest remainder, ties to the lower line number, so an invoice's credited lines
still add up exactly to its revenue base. The rule lives in one pure function
(`creditInvoice` / `spreadWeights`, `src/attribution/credit.ts`). #12's discount metric (gross −
charged, per line): the TOTAL discount of an invoice (Σ gross − net) is unaffected by this rule, but
how it is split between the invoice's doctors follows it — each doctor's discount is their lines'
gross minus what the spread credited them.
