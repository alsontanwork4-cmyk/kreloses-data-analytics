import type { Queryable, Sql } from "@/db/sql";
import type { IsoDate } from "@/filters";

/**
 * The sync run log (`sync_runs`): one row per run, including failed and interrupted ones. The
 * Sync status page lists them; "data as of" (Analytics Service) reads the ones that read their
 * whole listing.
 */
export type SyncMode = "nightly" | "backfill" | "manual";

/**
 * - `running`   — in progress (or its server died: the next run of that connection marks it
 *                 `failed` / `interrupted`, and may carry on from its checkpoint).
 * - `succeeded` — read its whole date range.
 * - `partial`   — stopped cleanly at its time budget (`checkpoint` says where to carry on), or read
 *                 its whole listing but some invoice pages were missing (`covered_location_ids` set).
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
  /**
   * Invoices whose line items (Sale Overview page) were read: new ones, ones whose header changed in
   * a way that can change their lines or revenue, and (nightly) older ones left behind (`lineItemsSwept`).
   */
  lineItemsRead: number;
  /** Invoice pages that were not there (404 / sent elsewhere): skipped, still "not synced yet", tried again next run. */
  lineItemsFailed: number;
  /** Invoices read in this run whose lines do not add up to their net amount (`invoices.line_gap_amount` ≠ 0). */
  lineItemGaps: number;
  /** Of `lineItemsRead`: invoices outside the run's listing picked up by the nightly sweep. */
  lineItemsSwept: number;
  /**
   * Older invoices (the nightly sweep) whose page came back in a layout the app does not know: skipped
   * with a warning, still "not synced yet", retried every night — WITHOUT using up missing-page
   * attempts (only `lineItemsFailed` does). In the listing that fails the run instead.
   */
  lineItemsUnreadable: number;
  /**
   * HTTP requests the run sent to Kreloses (#8): its login's, the location/staff lists, Sale List
   * pages and invoice pages, retries and redirects included (a login that fails is not counted). The
   * history backfill's per-night budget is counted in these.
   */
  requests: number;
  /**
   * Kreloses's TotalCount for the run's dates (all statuses) at the last Sale List page it read;
   * absent until it reads one. The backfill's progress estimates invoices to go from it (#8).
   */
  saleListTotal?: number;
}

export const NO_COUNTS: SyncCounts = {
  pages: 0,
  invoicesSeen: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  lineItemsRead: 0,
  lineItemsFailed: 0,
  lineItemGaps: 0,
  lineItemsSwept: 0,
  lineItemsUnreadable: 0,
  requests: 0,
};

/**
 * Something the owner should know about a run that did not fail (shown on Sync status):
 * - `invoice_pages_missing` — some invoice pages could not be opened (the run ends `partial`);
 * - `staff_list_unreadable` — the Sale List filter had no readable Staff list, so new staff names
 *   could not be matched to full names this time (they are still credited);
 * - `line_items_left` — (nightly) the time budget ran out before every older sale left "not synced
 *   yet" was read; the next nightly sync carries on;
 * - `invoice_pages_unreadable` — (nightly sweep) some older invoice pages came back in a layout the
 *   app does not know: skipped (the run ends `partial`, its listing still counts), retried later;
 * - `backfill_request_budget` — (backfill, #8) tonight's request budget for this login was used up:
 *   the run stopped with its checkpoint and the backfill carries on the next night;
 * - `backfill_yielded` — (backfill) the run stopped with its checkpoint so the nightly sync or Sync
 *   now could use the login (docs/adr/0011); the next chunk carries on.
 */
export interface SyncWarning {
  code:
    | "invoice_pages_missing"
    | "staff_list_unreadable"
    | "line_items_left"
    | "invoice_pages_unreadable"
    | "backfill_request_budget"
    | "backfill_yielded";
  message: string;
}

/**
 * Where a stopped run carries on. A page stays the checkpoint until the line items of its invoices
 * have been read too, so carrying on re-reads that page (a no-op for its headers) and then reads the
 * line items still missing.
 *
 * - Fixed date ranges (Sync now of a month, backfill): `nextPage` over the run's range.
 * - Nightly (a recent window, where rows shift as sales are added): DATE-based, because page
 *   numbers of a newest-first list move. `processedAfter` = every sale in the range newer than this
 *   instant has been stored with its line items, so carrying on lists only the days up to that
 *   instant's clinic day. `listingDone` = the whole window was read; only the sweep of older
 *   invoices was left. (`nextPage` is used only while the listing has not been newest first.)
 */
export interface SyncCheckpoint {
  /** The next Sale List page to read. */
  nextPage: number;
  pageSize: number;
  /** ISO instant (nightly). */
  processedAfter?: string;
  /** Nightly: the window's listing is complete. */
  listingDone?: boolean;
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
  /**
   * Kreloses location ids whose whole listing this run read (set when it succeeds, or ends
   * `partial` only because some invoice pages were missing); drives "data as of".
   */
  coveredLocationIds: string[];
  errorCode: SyncErrorCode | null;
  error: string | null;
  warnings: SyncWarning[];
  /** The run this one carried on from (its checkpoint), if any. */
  resumedFromRunId: string | null;
  /** For a run that carried on: when the first run of the chain started ("data as of" for the chain). */
  chainStartedAt: Date | null;
}

const RUN_COLUMNS = `
  id::text as id, connection_id::text as connection_id, connection_label, mode, status, date_from, date_to,
  started_at, finished_at, counts, checkpoint, covered_location_ids, error_code, error, warnings,
  resumed_from_run_id::text as resumed_from_run_id, chain_started_at
`;

/**
 * The most recent runs first; `modes` keeps only those kinds (Sync status lists the history
 * backfill's many small runs apart from the nightly and Sync now runs).
 */
export async function listSyncRuns(sql: Sql, options: { limit?: number; modes?: readonly SyncMode[] } = {}): Promise<SyncRun[]> {
  const rows = await sql<SyncRun[]>`
    select ${sql.unsafe(RUN_COLUMNS)} from sync_runs
    ${options.modes ? sql`where mode = any(${[...options.modes]}::text[])` : sql``}
    order by started_at desc, id desc limit ${options.limit ?? 50}
  `;
  return rows.map((row) => ({ ...row, counts: { ...NO_COUNTS, ...row.counts } }));
}

export async function startRun(
  sql: Sql,
  values: {
    connectionId: string;
    connectionLabel: string;
    mode: SyncMode;
    dateFrom: IsoDate;
    dateTo: IsoDate;
    startedAt: Date;
    /** The run whose checkpoint this one carries on from, and when that chain started. */
    resumes?: { runId: string; chainStartedAt: Date } | null;
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sync_runs (connection_id, connection_label, mode, date_from, date_to, started_at, counts, resumed_from_run_id, chain_started_at)
    values (${values.connectionId}, ${values.connectionLabel}, ${values.mode}, ${values.dateFrom}, ${values.dateTo},
      ${values.startedAt}, ${sql.json({ ...NO_COUNTS })}, ${values.resumes?.runId ?? null}, ${values.resumes?.chainStartedAt ?? null})
    returning id::text as id
  `;
  return row!.id;
}

/**
 * No run lasts anywhere near this long (its time budget is at most 280 s), so a `running` row of a
 * deleted connection this old belongs to a server that died.
 */
const ORPHANED_AFTER_MS = 60 * 60_000;

/**
 * Marks runs that are still `running` but cannot be as failed/`interrupted` (their checkpoint is
 * kept, so the next run can carry on): this connection's (only call it while holding the
 * connection's lease: then none of its runs can really be running — a run that lost the lease can
 * no longer write, see the engine's fencing), and runs whose connection was deleted once they are
 * over an hour old (a younger one may still be finishing on another server instance).
 */
export async function markInterruptedRuns(sql: Sql, connectionId: string, now: Date): Promise<void> {
  await sql`
    update sync_runs set
      status = 'failed',
      finished_at = greatest(started_at, ${now}),
      error_code = 'interrupted',
      error = ${INTERRUPTED_MESSAGE}
    where status = 'running'
      and (
        connection_id = ${connectionId}
        or (connection_id is null and started_at < ${new Date(now.getTime() - ORPHANED_AFTER_MS)})
      )
  `;
}

const INTERRUPTED_MESSAGE =
  "This run stopped before it finished (the server restarted or ran out of time). The next sync carries on from where it stopped, or reads its range again.";

/**
 * A run that lost its connection lease (another run took over after it expired) records that it
 * stopped — unless the run that took over already marked it interrupted. Nothing else is written.
 */
export async function abandonRun(sql: Sql, runId: string, now: Date): Promise<void> {
  await sql`
    update sync_runs set
      status = 'failed',
      finished_at = greatest(started_at, ${now}),
      error_code = 'interrupted',
      error = ${LEASE_LOST_MESSAGE}
    where id = ${runId} and status = 'running'
  `;
}

export const LEASE_LOST_MESSAGE =
  "This run lost its hold on the Kreloses connection (it ran too long and another sync took over) and stopped without writing anything more. The other sync carries on.";

/** A run to carry on from: its dates, checkpoint, and when its chain started. */
export interface ResumePoint {
  runId: string;
  range: { from: IsoDate; to: IsoDate };
  checkpoint: SyncCheckpoint;
  chainStartedAt: Date;
}

/** Resumed chains older than this start afresh, so "data as of" never lags by more than this. */
export const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * The run a new run of this connection should carry on from, or null to start afresh: the
 * connection's latest run of the same mode (nightly: any window; otherwise exactly these dates)
 * when it stopped part-way with a checkpoint — at its time budget (`partial` that did not read its
 * whole listing), or `failed` / interrupted mid-way — with the same page size, and its chain
 * (the first run it continues) started less than `maxAgeMs` ago. A run that read its whole listing
 * (even if some invoice pages were missing) is complete: nothing to carry on.
 */
export async function findResumableRun(
  sql: Sql,
  connectionId: string,
  options: { mode: SyncMode; range: { from: IsoDate; to: IsoDate }; pageSize: number; now: Date; maxAgeMs?: number },
): Promise<ResumePoint | null> {
  const sameRun =
    options.mode === "nightly"
      ? sql`mode = 'nightly'`
      : sql`mode = ${options.mode} and date_from = ${options.range.from} and date_to = ${options.range.to}`;
  const [latest] = await sql<
    { id: string; status: SyncRunStatus; checkpoint: SyncCheckpoint | null; dateFrom: IsoDate; dateTo: IsoDate; chainStartedAt: Date; covered: number }[]
  >`
    select id::text as id, status, checkpoint, date_from, date_to, coalesce(chain_started_at, started_at) as chain_started_at,
      cardinality(covered_location_ids) as covered
    from sync_runs
    where connection_id = ${connectionId} and ${sameRun}
    order by started_at desc, id desc
    limit 1
  `;
  if (!latest || (latest.status !== "partial" && latest.status !== "failed")) return null;
  if (!latest.checkpoint || latest.covered > 0 || latest.checkpoint.pageSize !== options.pageSize) return null;
  if (options.now.getTime() - latest.chainStartedAt.getTime() > (options.maxAgeMs ?? RESUME_MAX_AGE_MS)) return null;
  return { runId: latest.id, range: { from: latest.dateFrom, to: latest.dateTo }, checkpoint: latest.checkpoint, chainStartedAt: latest.chainStartedAt };
}

export async function recordProgress(sql: Queryable, runId: string, counts: SyncCounts, checkpoint: SyncCheckpoint | null): Promise<void> {
  await sql`update sync_runs set counts = ${sql.json({ ...counts })}, checkpoint = ${checkpoint ? sql.json({ ...checkpoint }) : null} where id = ${runId}`;
}

export async function finishRun(
  sql: Queryable,
  runId: string,
  outcome: (
    | { status: "succeeded"; finishedAt: Date; counts: SyncCounts; coveredLocationIds: string[] }
    /**
     * Stopped at the time budget (`coveredLocationIds` absent), or read the whole listing but could
     * not open some invoice pages (`coveredLocationIds` set: it counts for "data as of").
     */
    | { status: "partial"; finishedAt: Date; counts: SyncCounts; checkpoint: SyncCheckpoint; coveredLocationIds?: string[] }
    | { status: "failed"; finishedAt: Date; counts: SyncCounts; checkpoint: SyncCheckpoint | null; errorCode: SyncErrorCode; error: string }
  ) & { warnings?: SyncWarning[] },
): Promise<void> {
  const covered = outcome.status === "failed" ? [] : (outcome.coveredLocationIds ?? []);
  await sql`
    update sync_runs set
      status = ${outcome.status},
      finished_at = ${outcome.finishedAt},
      counts = ${sql.json({ ...outcome.counts })},
      checkpoint = ${outcome.status === "succeeded" || !outcome.checkpoint ? null : sql.json({ ...outcome.checkpoint })},
      covered_location_ids = ${covered}::text[],
      error_code = ${outcome.status === "failed" ? outcome.errorCode : null},
      error = ${outcome.status === "failed" ? outcome.error : null},
      warnings = ${sql.json((outcome.warnings ?? []).map((warning) => ({ ...warning })))}
    where id = ${runId}
  `;
}
