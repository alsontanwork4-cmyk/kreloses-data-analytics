import { PieChart } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Mix" };

export default async function MixPage({ searchParams }: PageProps<"/mix">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Mix"
      description="Service-mix groups, top items, surgery, vaccines and dental per doctor."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Service mix" icon={PieChart} />
    </PageShell>
  );
}
