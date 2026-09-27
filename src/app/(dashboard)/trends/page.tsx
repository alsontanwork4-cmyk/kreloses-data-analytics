import { TrendingUp } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Trends" };

export default async function TrendsPage({ searchParams }: PageProps<"/trends">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Trends"
      description="Monthly revenue, AOV, surgery and consult revenue per doctor, plus year-on-year."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Monthly trends" icon={TrendingUp} />
    </PageShell>
  );
}
