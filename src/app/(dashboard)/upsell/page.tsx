import { ShoppingBasket } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Upsell" };

export default async function UpsellPage({ searchParams }: PageProps<"/upsell">) {
  const user = await requireUser();
  const filterState = parseFilter(await searchParams);
  return (
    <PageShell
      title="Upsell"
      description="How often consults include diagnostics, products or a second service."
      filter={filterState}
    >
      <NoSalesYet user={user} filter={filterState.filter} what="Upsell rates" icon={ShoppingBasket} />
    </PageShell>
  );
}
