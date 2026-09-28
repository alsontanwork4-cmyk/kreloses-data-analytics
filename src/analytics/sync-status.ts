import type { Sql } from "@/db/sql";
import type { IsoDate } from "@/filters";
import type { SyncMode, SyncRunStatus, SyncWarning } from "@/sync/runs";

/**
 * How each Kreloses connection's syncing stands (MCP `data_freshness`, #17): its login status and
 * what happened to its latest sync run (`METRIC_DEFINITIONS.lastSyncRun`). "Data as of" per branch
 * is `getDataFreshness` (./freshness.ts); this says why a branch may be stale.
 */

/**
 * - `running` — still in progress (or its server died; the next run of that connection says so);
 * - `succeeded` — read its whole date range;
 * - `stopped_at_time_limit` — stopped early; the next sync of those dates carries on;
 * - `invoice_pages_missing` — read everything except some invoice pages (their sales count as
 *   "line items not synced yet" until a later sync reads them);
 * - `failed` — see `error`.
 */
export type SyncRunOutcome = "running" | "succeeded" | "stopped_at_time_limit" | "invoice_pages_missing" | "failed";

export interface LastSyncRun {
  mode: SyncMode;
  outcome: SyncRunOutcome;
  /** The clinic days the run read (inclusive). */
  dateFrom: IsoDate;
  dateTo: IsoDate;
  startedAt: Date;
  finishedAt: Date | null;
  /** Why it failed, as shown on Sync status; null unless `failed`. */
  error: string | null;
  /** What the owner should know about a run that did not fail (e.g. invoice pages missing). */
  warnings: string[];
}

export interface ConnectionSyncStatus {
  connectionId: string;
  /** What the owner calls this Kreloses login. */
  label: string;
  /** The latest login (test or sync): `ok`, `failed` or `untested`. */
  loginStatus: "untested" | "ok" | "failed";
  /** Why the latest login failed; null unless `failed`. */
  loginError: string | null;
  lastTestedAt: Date | null;
  /** The connection's most recent sync run; null if it has never synced. */
  lastRun: LastSyncRun | null;
}

interface Row {
  connectionId: string;
  label: string;
  loginStatus: ConnectionSyncStatus["loginStatus"];
  loginError: string | null;
  lastTestedAt: Date | null;
  mode: SyncMode | null;
  status: SyncRunStatus | null;
  readWholeListing: boolean | null;
  dateFrom: IsoDate | null;
  dateTo: IsoDate | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  warnings: SyncWarning[] | null;
}

/** Every connection, by name, with its latest sync run. Never the Kreloses email or password. */
export async function getConnectionSyncStatus(sql: Sql): Promise<ConnectionSyncStatus[]> {
  const rows = await sql<Row[]>`
    select
      c.id::text as connection_id, c.label, c.status as login_status, c.last_error as login_error, c.last_tested_at,
      r.mode, r.status, cardinality(r.covered_location_ids) > 0 as read_whole_listing, r.date_from, r.date_to,
      r.started_at, r.finished_at, r.error, r.warnings
    from connections c
    left join lateral (
      select * from sync_runs r where r.connection_id = c.id order by r.started_at desc, r.id desc limit 1
    ) r on true
    order by lower(c.label), c.id
  `;
  return rows.map((row) => ({
    connectionId: row.connectionId,
    label: row.label,
    loginStatus: row.loginStatus,
    loginError: row.loginError,
    lastTestedAt: row.lastTestedAt,
    lastRun:
      row.status === null
        ? null
        : {
            mode: row.mode!,
            outcome: outcome(row.status, row.readWholeListing === true),
            dateFrom: row.dateFrom!,
            dateTo: row.dateTo!,
            startedAt: row.startedAt!,
            finishedAt: row.finishedAt,
            error: row.error,
            warnings: (row.warnings ?? []).map((warning) => warning.message),
          },
  }));
}

function outcome(status: SyncRunStatus, readWholeListing: boolean): SyncRunOutcome {
  if (status === "partial") return readWholeListing ? "invoice_pages_missing" : "stopped_at_time_limit";
  return status;
}
