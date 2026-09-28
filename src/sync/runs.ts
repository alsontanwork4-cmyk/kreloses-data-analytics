import type { Queryable, Sql } from "@/db/sql";
import type { IsoDate } from "@/filters";

/**
 * The sync run log (`sync_runs`): one row per run, including failed and interrupted ones. The
 * Sync status page lists them; "data as of" (Analytics Service) reads the succeeded ones.
 */
export type SyncMode = "nightly" | "backfill" | "manual";

/**
 * - `running`   — in progress (or its server died: the next run of that connection marks it
 *                 `failed` / `interrupted`).
 * - `succeeded` — read its whole date range.
 * - `partial`   — stopped cleanly at its time budget; `checkpoint` says where to carry on.
 * - `failed`    — `errorCode` / `error` say why. Nothing it wrote is wrong, just incomplete.
 */
export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed";

export type SyncErrorCode =
  | "auth_failed"
  | "layout_changed"
  | "rate_limited"
  | "transient"
  | "key_problem"
  | "interrupted"
  | "internal";

export interface SyncCounts {
  /** Sale List pages read. */
  pages: number;
  /** Invoices in the run's date range that were read (cancelled included). */
  invoicesSeen: number;
  /** New invoices stored. */
  inserted: number;
  /** Stored invoices whose header changed (status, amounts, payments, refunds, …). */
  updated: number;
  /** Stored invoices read again with nothing changed. */
  unchanged: number;
}

export const NO_COUNTS: SyncCounts = { pages: 0, invoicesSeen: 0, inserted: 0, updated: 0, unchanged: 0 };

/** Where a stopped run carries on (#6 resumes from it). */
export interface SyncCheckpoint {
  /** The next Sale List page to read. */
  nextPage: number;
  pageSize: number;
}

export interface SyncRun {
  id: string;
  /** Null once the connection has been deleted. */
  connectionId: string | null;
  connectionLabel: string;
  mode: SyncMode;
  status: SyncRunStatus;
  dateFrom: IsoDate;
  dateTo: IsoDate;
  startedAt: Date;
  finishedAt: Date | null;
  counts: SyncCounts;
  checkpoint: SyncCheckpoint | null;
  /** Kreloses location ids this run read completely (set when it succeeds). */
  coveredLocationIds: string[];
  errorCode: SyncErrorCode | null;
  error: string | null;
}

const RUN_COLUMNS = `
  id::text as id, connection_id::text as connection_id, connection_label, mode, status, date_from, date_to,
  started_at, finished_at, counts, checkpoint, covered_location_ids, error_code, error
`;

/** The most recent runs first. */
export async function listSyncRuns(sql: Sql, options: { limit?: number } = {}): Promise<SyncRun[]> {
  const rows = await sql<SyncRun[]>`
    select ${sql.unsafe(RUN_COLUMNS)} from sync_runs order by started_at desc, id desc limit ${options.limit ?? 50}
  `;
  return rows.map((row) => ({ ...row, counts: { ...NO_COUNTS, ...row.counts } }));
}

export async function startRun(
  sql: Sql,
  values: { connectionId: string; connectionLabel: string; mode: SyncMode; dateFrom: IsoDate; dateTo: IsoDate; startedAt: Date },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sync_runs (connection_id, connection_label, mode, date_from, date_to, started_at, counts)
    values (${values.connectionId}, ${values.connectionLabel}, ${values.mode}, ${values.dateFrom}, ${values.dateTo},
      ${values.startedAt}, ${sql.json({ ...NO_COUNTS })})
    returning id::text as id
  `;
  return row!.id;
}

/**
 * Marks the connection's runs that are still `running` as failed/`interrupted`. Only call it while
 * holding the connection's lease: then no run of that connection can really be running.
 */
export async function markInterruptedRuns(sql: Sql, connectionId: string, now: Date): Promise<void> {
  await sql`
    update sync_runs set
      status = 'failed',
      finished_at = greatest(started_at, ${now}),
      error_code = 'interrupted',
      error = 'This run stopped before it finished (the server restarted or ran out of time). The next sync reads its range again.'
    where connection_id = ${connectionId} and status = 'running'
  `;
}

export async function recordProgress(sql: Queryable, runId: string, counts: SyncCounts, checkpoint: SyncCheckpoint | null): Promise<void> {
  await sql`update sync_runs set counts = ${sql.json({ ...counts })}, checkpoint = ${checkpoint ? sql.json({ ...checkpoint }) : null} where id = ${runId}`;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  outcome:
    | { status: "succeeded"; finishedAt: Date; counts: SyncCounts; coveredLocationIds: string[] }
    | { status: "partial"; finishedAt: Date; counts: SyncCounts; checkpoint: SyncCheckpoint }
    | { status: "failed"; finishedAt: Date; counts: SyncCounts; checkpoint: SyncCheckpoint | null; errorCode: SyncErrorCode; error: string },
): Promise<void> {
  await sql`
    update sync_runs set
      status = ${outcome.status},
      finished_at = ${outcome.finishedAt},
      counts = ${sql.json({ ...outcome.counts })},
      checkpoint = ${outcome.status === "succeeded" || !outcome.checkpoint ? null : sql.json({ ...outcome.checkpoint })},
      covered_location_ids = ${outcome.status === "succeeded" ? outcome.coveredLocationIds : []}::text[],
      error_code = ${outcome.status === "failed" ? outcome.errorCode : null},
      error = ${outcome.status === "failed" ? outcome.error : null}
    where id = ${runId}
  `;
}
