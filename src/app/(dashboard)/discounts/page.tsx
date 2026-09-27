import { BadgePercent } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Discounts" };

export default async function DiscountsPage({ searchParams }: PageProps<"/discounts">) {
  const user = await requireUser();
  const filterState = parseFilter(await searchParams);
  return (
    <PageShell
      title="Discounts"
      description="Discount totals, discount rates and the discount types used."
      filter={filterState}
    >
      <NoSalesYet user={user} filter={filterState.filter} what="Discounts" icon={BadgePercent} />
    </PageShell>
  );
}
