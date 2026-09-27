import { Repeat } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Retention" };

export default async function RetentionPage({ searchParams }: PageProps<"/retention">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Retention"
      description="New vs returning customers, yearly cohorts and 90-day return rates per doctor."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Retention figures" icon={Repeat} />
    </PageShell>
  );
}
