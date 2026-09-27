import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ searchParams }: PageProps<"/overview">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Overview"
      description="Headline KPIs for the selected period, compared with the previous period and the same period last year."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Revenue, invoices, customers and AOV" icon={LayoutDashboard} />
    </PageShell>
  );
}
