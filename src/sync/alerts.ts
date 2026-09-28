import type { Sql } from "@/db/sql";

/**
 * Sync problems every signed-in user must see (spec story 7: "tell me when a connection starts
 * failing, so syncing doesn't silently stop"). The dashboard shows them as a banner on every page.
 *
 * - `login_failed` — the connection's login no longer works (its latest login — a login test or a
 *   sync's — was refused: password changed, extra login step, key problem…). Its `last_error`.
 * - `nightly_failed` — the connection's latest finished NIGHTLY run failed, and no run started after
 *   it (of any kind: nightly or Sync now) has succeeded or read its whole listing since. That run's
 *   error. A later Sync now that fails too (or stops at its time limit) does not hide it; one that
 *   works does. A failed Sync now alone is no banner (the owner saw it fail on the Connections page).
 *   History backfill runs (#8) never hide it: they read old months, not the nightly window.
 *
 * A connection that recovers (a later login or run works) drops out on its own.
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
    { id: string; label: string; status: string; lastError: string | null; lastTestedAt: Date | null; runError: string | null; runFinishedAt: Date | null }[]
  >`
    select c.id::text as id, c.label, c.status, c.last_error, c.last_tested_at,
      n.error as run_error, n.finished_at as run_finished_at
    from connections c
    -- The latest finished nightly run, if it failed …
    left join lateral (
      select r.id, r.status, r.error, r.started_at, r.finished_at from sync_runs r
      where r.connection_id = c.id and r.mode = 'nightly' and r.status <> 'running'
      order by r.started_at desc, r.id desc
      limit 1
    ) n on n.status = 'failed'
    where c.status = 'failed'
      or (
        n.id is not null
        -- … and nothing since has worked: a later run that succeeded or read its whole listing. Not a
        -- history backfill run (#8): reading an old month says nothing about the nightly window.
        and not exists (
          select 1 from sync_runs later
          where later.connection_id = c.id
            and later.mode <> 'backfill'
            and (later.started_at, later.id) > (n.started_at, n.id)
            and (later.status = 'succeeded' or cardinality(later.covered_location_ids) > 0)
        )
      )
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
