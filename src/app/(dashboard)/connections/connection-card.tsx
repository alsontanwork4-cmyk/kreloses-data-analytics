import { History, TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { ConnectionStatus, ConnectionSummary } from "@/connections/service";
import { backfillSummaryText } from "@/components/backfill/labels";
import { Badge } from "@/components/ui/badge";
import type { BackfillProgress } from "@/sync/backfill-progress";
import { CLINIC_TIME_ZONE } from "@/filters";
import { cn } from "@/lib/utils";

import { ConnectionActions, type MonthOption } from "./connection-actions";

const STATUS: Record<ConnectionStatus, { label: string; className: string }> = {
  ok: { label: "Connected", className: "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" },
  failed: { label: "Login failed", className: "bg-destructive/10 text-destructive" },
  untested: { label: "Not tested", className: "bg-muted text-muted-foreground" },
};

const TESTED_AT = new Intl.DateTimeFormat("en-GB", {
  timeZone: CLINIC_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** One Kreloses connection: what it is, whether its login works, which branches it can see, and its history backfill. */
export function ConnectionCard({ connection, months, backfill }: { connection: ConnectionSummary; months: MonthOption[]; backfill?: BackfillProgress }) {
  const status = STATUS[connection.status];
  const titleId = `connection-${connection.id}-title`;
  return (
    <article
      aria-labelledby={titleId}
      data-testid="connection"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="min-w-0 truncate text-base font-medium">
          {connection.label}
        </h2>
        <Badge data-testid="connection-status" className={cn("h-6 px-2.5", status.className)}>
          {status.label}
        </Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Kreloses login</dt>
          <dd className="truncate" data-testid="connection-email">
            {connection.email}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last tested</dt>
          <dd data-testid="connection-tested-at">
            {connection.lastTestedAt ? TESTED_AT.format(connection.lastTestedAt) : "Not yet"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Branches it can see</dt>
          <dd data-testid="connection-branches">
            {connection.status !== "ok" ? (
              <span className="text-muted-foreground">Unknown until the login works</span>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {connection.visibleLocations.map((location) => (
                  <li key={location.id}>
                    <Badge variant="secondary">{location.name}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {backfill ? (
        <p data-testid="connection-backfill" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <History className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0">{backfillSummaryText(backfill)}</span>
          <Link href="/sync" className="text-foreground underline underline-offset-4">
            Backfill details
          </Link>
        </p>
      ) : null}

      {connection.lastError ? (
        <p data-testid="connection-error" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{connection.lastError}</span>
        </p>
      ) : null}

      <ConnectionActions connection={{ id: connection.id, label: connection.label, email: connection.email }} months={months} />
    </article>
  );
}
