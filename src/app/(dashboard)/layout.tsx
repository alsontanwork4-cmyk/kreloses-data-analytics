import type { ReactNode } from "react";

import { requireUser } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Shell for every signed-in page. The layout's `requireUser()` is for rendering the user menu;
 * each page must still call `requireUser()` / `requireRole()` itself (layouts are not re-run on
 * every navigation).
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return <AppShell user={user}>{children}</AppShell>;
}
