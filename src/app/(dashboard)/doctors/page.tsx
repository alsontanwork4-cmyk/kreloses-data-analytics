import { Stethoscope } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { NoSalesYet } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { parseFilter } from "@/filters";

export const metadata: Metadata = { title: "Doctors" };

export default async function DoctorsPage({ searchParams }: PageProps<"/doctors">) {
  const user = await requireUser();
  const { filter } = parseFilter(await searchParams);
  return (
    <PageShell
      title="Doctors"
      description="Revenue, AOV per customer, invoices and share of revenue for each doctor, by branch."
      filters
    >
      <NoSalesYet user={user} filter={filter} what="Doctor rankings" icon={Stethoscope} />
    </PageShell>
  );
}
