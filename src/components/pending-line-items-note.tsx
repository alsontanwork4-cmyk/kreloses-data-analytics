import type { PendingLineItems } from "@/analytics";
import type { GlobalFilter } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit } from "@/lib/money";

/**
 * Under a doctor filter, sales whose line items are not synced yet are credited to nobody, so they
 * cannot show up; say how many there are instead of hiding them silently. Renders nothing without a
 * doctor filter or pending sales. `doctorsOnly`: the view only ever shows revenue credited to
 * doctors (e.g. Trends), so the note applies even without a doctor filter.
 */
export function PendingLineItemsNote({ filter, pending, doctorsOnly = false }: { filter: GlobalFilter; pending: PendingLineItems; doctorsOnly?: boolean }) {
  if ((!filter.doctorIds && !doctorsOnly) || pending.invoices === 0) return null;
  const one = pending.invoices === 1;
  return (
    <p data-testid="pending-line-items-note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
      {formatCount(pending.invoices)} {one ? "invoice" : "invoices"} in this period ({formatRinggit(pending.revenue)}) {one ? "has" : "have"} line
      items not synced yet, so {one ? "it is" : "they are"} not credited to any doctor yet and not included here. The next sync reads{" "}
      {one ? "it" : "them"}.
    </p>
  );
}
