import type { Sql } from "@/db/sql";

/**
 * Sync problems every signed-in user must see (spec story 7: "tell me when a connection starts
 * failing, so syncing doesn't silently stop"). The dashboard shows them as a banner on every page.
 *
 * - `login_failed` — the connection's login no longer works (its latest login — a login test or a
 *   sync's — was refused: password changed, extra login step, key problem…). Its `last_error`.
 * - `nightly_failed` — the connection's latest finished sync run was a nightly one and it failed
 *   (e.g. Kreloses changed its pages, or stayed unreachable). That run's error.
 *
 * A connection that recovers (a later login or run succeeds) drops out on its own.
 */
export interface SyncAlert {
  connectionId: string;
  connectionLabel: string;
  kind: "login_failed" | "nightly_failed";
  /** What went wrong, in plain words (already shown to the owner elsewhere; safe to show managers). */
  message: string;
  /** When it was noticed (the login test or the run's finish). */
  since: Date | null;
}

export async function getSyncAlerts(sql: Sql): Promise<SyncAlert[]> {
  const rows = await sql<
    { id: string; label: string; status: string; lastError: string | null; lastTestedAt: Date | null; runMode: string | null; runStatus: string | null; runError: string | null; runFinishedAt: Date | null }[]
  >`
    select c.id::text as id, c.label, c.status, c.last_error, c.last_tested_at,
      r.mode as run_mode, r.status as run_status, r.error as run_error, r.finished_at as run_finished_at
    from connections c
    left join lateral (
      select mode, status, error, finished_at from sync_runs
      where connection_id = c.id and status <> 'running'
      order by started_at desc, id desc
      limit 1
    ) r on true
    where c.status = 'failed' or (r.mode = 'nightly' and r.status = 'failed')
    order by lower(c.label), c.id
  `;
  return rows.map((row): SyncAlert =>
    row.status === "failed"
      ? {
          connectionId: row.id,
          connectionLabel: row.label,
          kind: "login_failed",
          message: row.lastError ?? "The Kreloses login failed.",
          since: row.lastTestedAt,
        }
      : {
          connectionId: row.id,
          connectionLabel: row.label,
          kind: "nightly_failed",
          message: row.runError ?? "The nightly sync failed.",
          since: row.runFinishedAt,
        },
  );
}
