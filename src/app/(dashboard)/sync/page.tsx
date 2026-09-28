import { RefreshCw } from "lucide-react";
import type { Metadata } from "next";

import { requireUser } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";

export const metadata: Metadata = { title: "Sync status" };

export default async function SyncStatusPage() {
  await requireUser();
  return (
    <PageShell title="Sync status" description="Sync runs, backfill progress and how fresh each branch's data is.">
      <EmptyState icon={RefreshCw} title="No sync runs yet">
        <p>Runs appear here once a Kreloses connection has been added and synced.</p>
      </EmptyState>
    </PageShell>
  );
}
