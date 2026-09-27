import { Plug } from "lucide-react";
import type { Metadata } from "next";

import { requireRole } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";

export const metadata: Metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  await requireRole("owner");
  return (
    <PageShell title="Connections" description="Kreloses logins, one per branch, that the nightly sync reads from.">
      <EmptyState icon={Plug} title="No Kreloses connections yet">
        <p>Add a Kreloses login for each branch here so the app can sync its sales.</p>
      </EmptyState>
    </PageShell>
  );
}
