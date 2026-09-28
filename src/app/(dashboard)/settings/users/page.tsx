import type { Metadata } from "next";

import { listAllowList, normaliseEmail } from "@/auth/allow-list";
import { requestOrigin } from "@/auth/magic-link";
import { LOGIN_PATH } from "@/auth/paths";
import { requireRole } from "@/auth/session";
import { SettingsSection } from "@/components/settings/settings-section";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/db/client";
import { formatClinicDateTime } from "@/filters";

import { AllowListTable, type AllowListRow } from "./allow-list-table";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Users · Settings" };

/** Owner only: who may sign in (the allow-list); invite and remove managers. */
export default async function UsersSettingsPage() {
  const owner = await requireRole("owner");
  const entries = await listAllowList(getDb());
  const you = normaliseEmail(owner.email);

  const rows: AllowListRow[] = entries.map((entry) => ({
    email: entry.email,
    role: entry.role,
    addedAt: formatClinicDateTime(entry.addedAt),
    invitedBy: entry.invitedBy,
    lastSignIn: entry.lastSignInAt ? formatClinicDateTime(entry.lastSignInAt) : null,
    isYou: entry.email === you,
    removable: entry.role === "manager",
  }));

  return (
    <SettingsSection
      title="Users"
      description="Who can sign in. Managers can view the dashboard but can't change connections, settings or users."
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Invite a manager</h3>
          </CardTitle>
          <CardDescription>
            They are emailed a sign-in link straight away and can sign in with this email from then on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteForm loginUrl={`${await requestOrigin()}${LOGIN_PATH}`} />
        </CardContent>
      </Card>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          People with access <span className="text-muted-foreground">({rows.length})</span>
        </h3>
        <AllowListTable rows={rows} />
      </div>
    </SettingsSection>
  );
}
