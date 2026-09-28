import { Plug, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";

import { requireRole } from "@/auth/session";
import { encryptionKeyProblem } from "@/connections/context";
import { listConnections } from "@/connections/service";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/shell/page-shell";
import { getDb } from "@/db/client";

import { AddConnection } from "./add-connection";
import { ConnectionCard } from "./connection-card";

export const metadata: Metadata = { title: "Connections" };

/** Owner only: the Kreloses logins (one per branch login) the sync reads with. */
export default async function ConnectionsPage() {
  await requireRole("owner");
  const connections = await listConnections(getDb());
  const keyProblem = encryptionKeyProblem();

  return (
    <PageShell title="Connections" description="Kreloses logins, one per branch, that the nightly sync reads from.">
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
              <ConnectionCard connection={connection} />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
