import { Settings } from "lucide-react";
import type { Metadata } from "next";

import { requireRole } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireRole("owner");
  return (
    <PageShell title="Settings" description="Doctor-name mapping, item groups and who can sign in.">
      <EmptyState icon={Settings} title="Nothing to configure yet">
        <p>Doctor and item mappings appear here after the first sync.</p>
      </EmptyState>
    </PageShell>
  );
}
