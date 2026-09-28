import type { ReactNode } from "react";

import { requireUser } from "@/auth/session";
import { SettingsNav } from "@/components/settings/settings-nav";
import { PageShell } from "@/components/shell/page-shell";

/**
 * The Settings hub: one "Settings" heading and a tab per settings page (`SETTINGS_NAV_ITEMS` in
 * `src/components/shell/nav-config.ts`). The layout only needs the role to pick the tabs; every
 * settings page still calls `requireRole(...)` itself.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <PageShell title="Settings" description="Doctor-name mapping, item groups and who can sign in.">
      <SettingsNav role={user.role} />
      {children}
    </PageShell>
  );
}
