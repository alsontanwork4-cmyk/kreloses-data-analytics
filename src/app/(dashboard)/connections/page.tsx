import { Plug, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";

import { requireRole } from "@/auth/session";
import { encryptionKeyProblem } from "@/connections/context";
import { listConnections } from "@/connections/service";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { getDb } from "@/db/client";
import { clinicNow } from "@/lib/clinic-clock";
import { backfillConfigFromEnv } from "@/sync/backfill-config";
import { getBackfillProgress } from "@/sync/backfill-progress";
import { syncMonthOptions } from "@/sync/months";

import { AddConnection } from "./add-connection";
import { ConnectionCard } from "./connection-card";

export const metadata: Metadata = { title: "Connections" };

/**
 * "Sync now" runs in this page's Server Action: allow up to 300 s (Vercel's default limit). The
 * Sync Engine stops itself well before, at its time budget (SYNC_TIME_BUDGET_SECONDS, default 200).
 */
export const maxDuration = 300;

/** Owner only: the Kreloses logins (one per branch login) the sync reads with. */
export default async function ConnectionsPage() {
  await requireRole("owner");
  const sql = getDb();
  const [connections, backfill] = await Promise.all([
    listConnections(sql),
    getBackfillProgress(sql, { now: clinicNow(), config: backfillConfigFromEnv() }),
  ]);
  const backfillById = new Map(backfill.map((progress) => [progress.connectionId, progress]));
  const keyProblem = encryptionKeyProblem();
  const months = syncMonthOptions();

  return (
    <PageShell
      title="Connections"
      description="Kreloses logins, one per branch, that the sync reads from. Use “Sync now” to read a month of sales straight away."
    >
      {keyProblem ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Connections cannot be saved or tested yet. {keyProblem}</span>
        </p>
      ) : null}

      <AddConnection disabled={keyProblem !== null} />

      {connections.length === 0 ? (
        <EmptyState icon={Plug} title="No Kreloses connections yet">
          <p>
            Add a Kreloses login for each branch here so the app can sync its sales. Saving a login tests it straight
            away and shows which branches it can see.
          </p>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Kreloses connections">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionCard connection={connection} months={months} backfill={backfillById.get(connection.id)} />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
