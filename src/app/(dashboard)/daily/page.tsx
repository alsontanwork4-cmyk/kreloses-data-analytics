import { CalendarDays } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Daily" };

export default async function DailyPage({ searchParams }: PageProps<"/daily">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Daily"
      description="Each day's revenue, invoices and AOV by branch and doctor."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Daily sales" icon={CalendarDays} />
    </PageShell>
  );
}
