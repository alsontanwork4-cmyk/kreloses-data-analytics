import type { ReactNode } from "react";

import { requireUser } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";
import { SyncAlertBanner } from "@/components/sync-alert-banner";
import { getDb } from "@/db/client";
import { getSyncAlerts } from "@/sync/alerts";

/**
 * Shell for every signed-in page. The layout's `requireUser()` is for rendering the user menu;
 * each page must still call `requireUser()` / `requireRole()` itself (layouts are not re-run on
 * every navigation). Above every page: the banner for a failing Kreloses connection (#6).
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const alerts = await getSyncAlerts(getDb());
  return (
    <AppShell user={user}>
      <SyncAlertBanner alerts={alerts} user={user} />
      {children}
    </AppShell>
  );
}
