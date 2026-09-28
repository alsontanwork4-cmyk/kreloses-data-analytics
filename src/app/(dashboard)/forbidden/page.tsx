import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { HOME_PATH } from "@/auth/paths";
import { requireUser } from "@/auth/session";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not allowed" };

/** Where `requireRole()` sends a signed-in user who lacks the role. */
export default async function ForbiddenPage() {
  await requireUser();
  return (
    <PageShell title="Not allowed">
      <EmptyState
        icon={ShieldAlert}
        title="Only the clinic owner can open that page"
        action={
          <Button asChild size="sm" variant="outline">
            <Link href={HOME_PATH}>Back to the overview</Link>
          </Button>
        }
      />
    </PageShell>
  );
}
