import { Stethoscope } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, parseFilter, withSearchParams } from "@/filters";
import { getStaffMember } from "@/staff/store";

export const metadata: Metadata = { title: "Doctor" };

/**
 * One doctor's detail view (spec story 36). A placeholder for now: #10 builds it (trends, mix, top
 * items) on the Analytics Service. The Doctors page links every doctor here with the global filter.
 */
export default async function DoctorPage({ params, searchParams }: PageProps<"/doctors/[id]">) {
  await requireUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const doctor = await getStaffMember(getDb(), id);
  if (!doctor) notFound();
  const filterState = parseFilter(query);

  return (
    <PageShell title={doctor.name} description="Doctor detail: monthly trends, service mix and top items." filter={filterState}>
      <EmptyState
        icon={Stethoscope}
        title="Doctor detail is coming soon"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={withSearchParams("/doctors", filterSearchParamsOnly(query))}>Back to the doctor ranking</Link>
          </Button>
        }
      >
        <p>This page will show {doctor.name}&apos;s trends, service mix and top items for the selected period.</p>
      </EmptyState>
    </PageShell>
  );
}
