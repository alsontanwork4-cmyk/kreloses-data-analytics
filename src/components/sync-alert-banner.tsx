import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import { hasRole, type AppUser } from "@/auth/roles";
import { formatClinicDateTime } from "@/filters";
import type { SyncAlert } from "@/sync/alerts";

/**
 * The dashboard-wide banner for a connection whose sync is failing (spec story 7): shown on every
 * signed-in page, above the page, while `getSyncAlerts` reports anything. Owners get a link to
 * Connections (where they can fix the login and "Sync now"); managers see the message only.
 */
export function SyncAlertBanner({ alerts, user }: { alerts: SyncAlert[]; user: AppUser }) {
  if (alerts.length === 0) return null;
  const owner = hasRole(user, "owner");
  return (
    <div role="alert" data-testid="sync-alert-banner" className="mx-auto mb-5 flex w-full max-w-7xl flex-col gap-2">
      {alerts.map((alert) => (
        <div
          key={alert.connectionId}
          data-testid="sync-alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 break-words">
            <p className="font-medium">
              {alert.kind === "login_failed"
                ? `Kreloses sync is failing for “${alert.connectionLabel}”: its login no longer works.`
                : `The nightly sync of “${alert.connectionLabel}” failed.`}{" "}
              Numbers from this connection may be out of date.
            </p>
            <p data-testid="sync-alert-message">{alert.message}</p>
            <p className="text-xs opacity-80">
              {alert.since ? `Since ${formatClinicDateTime(alert.since)}. ` : null}
              {owner ? (
                <Link href="/connections" className="font-medium underline underline-offset-2">
                  Check the connection
                </Link>
              ) : (
                "The clinic owner can fix it on the Connections page."
              )}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
