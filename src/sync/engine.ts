import { acquireConnectionLease, releaseConnectionLease, type LeasePurpose } from "@/connections/lock";
import { recordLoginOutcome } from "@/connections/service";
import { isConnectionId } from "@/connections/store";
import type { Sql } from "@/db/sql";
import { clinicToday, endOfMonth, isIsoDate, startOfMonth, type IsoDate } from "@/filters";
import {
  AuthFailed,
  getInvoice,
  listInvoices,
  listLocations,
  listStaff,
  RateLimited,
  SALE_LIST_PAGE_SIZE,
  Transient,
  type InvoiceListQuery,
  type InvoicePage,
  type KrelosesInvoiceDetail,
  type KrelosesLocation,
  type KrelosesSession,
  type KrelosesStaffMember,
} from "@/kreloses";
import { upsertStaffDirectory } from "@/staff/store";

import { describeSyncFailure, isLoginFailure, type SyncFailure } from "./messages";
import {
  finishRun,
  markInterruptedRuns,
  NO_COUNTS,
  recordProgress,
  resumablePage,
  startRun,
  type SyncCheckpoint,
  type SyncCounts,
  type SyncMode,
} from "./runs";
import { invoicesNeedingLines, saveInvoiceLines } from "./lines";
import { saveInvoicePage, upsertBranches } from "./store";

/**
 * The Sync Engine: reads a connection's Kreloses Sale List for a date range, page by page, stores
 * invoices, branches and customers idempotently, then reads the line items of the page's new and
 * changed invoices (#5) and derives their credited lines, recording a `sync_runs` row for every
 * run (including failures).
 *
 *   const result = await runSync(syncDeps(), connectionId, "manual", { dateRange: { from, to } });
 *
 * One run, in order:
 * 1. Takes the connection's lease (`@/connections/lock`), so no other sync or login test uses the
 *    same Kreloses login meanwhile; if it is held, returns `{status: "busy"}` without a run row.
 *    Runs of this connection still marked `running` (their server died) become `interrupted`.
 * 2. Logs in, reads the branches and the staff list the login can see (the Connections page status
 *    is updated from this login: Connected, or Login failed with the reason); unmatched staff
 *    names on lines are matched again against the staff list.
 * 3. Reads Sale List pages serially (the Reader waits its polite delay between requests); each page
 *    is stored with the run's counts and checkpoint in one transaction, so a crash loses nothing
 *    already read.
 * 4. After each page, reads the Sale Overview page of each of its invoices whose line items are
 *    missing or stale (`invoicesNeedingLines`, in ./lines.ts: the ONE place deciding that) and
 *    stores lines + credited lines per invoice in one transaction (`saveInvoiceLines`). The page
 *    stays the checkpoint until its line items are done.
 * 5. Finishes `succeeded`, `partial` (time budget reached; `checkpoint` says where to carry on) or
 *    `failed`.
 *
 * Errors: `AuthFailed` and `LayoutChanged` are never retried (the owner or a code fix must act); an
 * expired session gets ONE fresh login per run; `RateLimited` / `Transient` are retried with
 * backoff (honouring Retry-After) within the time budget, then the run fails and the next sync
 * tries again.
 *
 * Extension points: #6 (nightly cron, change detection, resume) passes `mode: "nightly"` and
 * `startPage` from a checkpoint, and refines which invoices need their lines re-read in
 * `invoicesNeedingLines`; #8 (backfill) runs bounded chunks with `mode: "backfill"` and a date
 * range per chunk.
 */
export interface SyncDeps {
  sql: Sql;
  /** Logs in as the connection; in the app `(id) => loginAsConnection(connectionsContext(), id)`. */
  login: (connectionId: string) => Promise<KrelosesSession>;
  /** Defaults to the Kreloses Reader. Tests may pass a fake. */
  reader?: SyncReader;
  /** The clock (run timestamps, the time budget, the lease). Default: the real time. */
  now?: () => Date;
  /** Waits between retries. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The Reader functions the engine uses. */
export interface SyncReader {
  listLocations(session: KrelosesSession): Promise<KrelosesLocation[]>;
  listStaff(session: KrelosesSession): Promise<KrelosesStaffMember[]>;
  listInvoices(session: KrelosesSession, query: InvoiceListQuery): Promise<InvoicePage>;
  getInvoice(session: KrelosesSession, saleId: string): Promise<KrelosesInvoiceDetail>;
}

export interface SyncOptions {
  /** Clinic days to read (inclusive). Default: the current clinic month. */
  dateRange?: { from: IsoDate; to: IsoDate };
  /** No new Kreloses request starts after this long; the run stops as `partial`. Default 200 s. */
  timeBudgetMs?: number;
  /** Sale List rows per page. Default 500 (the Kreloses UI's). */
  pageSize?: number;
  /** First page to read, when carrying on from a checkpoint. Default 1. */
  startPage?: number;
  /**
   * Carry on from the connection's latest run of exactly these dates if it stopped at its time
   * budget (`partial`); otherwise start from page 1. Ignored when `startPage` is given. "Sync now"
   * uses it, so "sync again" finishes a month rather than starting it over.
   */
  resume?: boolean;
  /** Retries per request for RateLimited / Transient. Default 3. */
  maxRetries?: number;
}

export type SyncResult =
  | { status: "succeeded" | "partial" | "failed"; runId: string; counts: SyncCounts; error?: SyncFailure }
  /** Another sync or a login test holds the connection; nothing was done. */
  | { status: "busy"; heldFor: LeasePurpose; until: Date }
  | { status: "not_found" };

export type { SyncMode } from "./runs";

/**
 * Well under Vercel's function limit (maxDuration 300 s on the pages that start a sync): one
 * in-flight request (Reader timeout 20 s, plus retries only if they fit) and the final writes
 * still finish in time.
 */
export const DEFAULT_TIME_BUDGET_MS = 200_000;
/** The lease outlives the time budget by this much, so it never expires under a healthy run. */
const LEASE_MARGIN_MS = 120_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_READER: SyncReader = { listLocations, listStaff, listInvoices, getInvoice };

/** The clinic month containing `now`, first to last day. */
export function currentClinicMonth(now: Date): { from: IsoDate; to: IsoDate } {
  const today = clinicToday(now);
  return { from: startOfMonth(today), to: endOfMonth(today) };
}

export async function runSync(deps: SyncDeps, connectionId: string, mode: SyncMode, options: SyncOptions = {}): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const range = options.dateRange ?? currentClinicMonth(now());
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.from > range.to) {
    throw new RangeError(`bad sync date range ${range.from}..${range.to}`);
  }
  const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  if (!isConnectionId(connectionId)) return { status: "not_found" };
  const [connection] = await deps.sql<{ label: string }[]>`select label from connections where id = ${connectionId}`;
  if (!connection) return { status: "not_found" };

  const attempt = await acquireConnectionLease(deps.sql, connectionId, { purpose: "sync", ttlMs: budgetMs + LEASE_MARGIN_MS, now: now() });
  if (attempt.status !== "acquired") return attempt;
  try {
    await markInterruptedRuns(deps.sql, connectionId, now());
    let runOptions = options;
    if (options.resume && options.startPage === undefined) {
      const nextPage = await resumablePage(deps.sql, connectionId, range, options.pageSize ?? SALE_LIST_PAGE_SIZE);
      if (nextPage !== null) runOptions = { ...options, startPage: nextPage };
    }
    const startedAt = now();
    const runId = await startRun(deps.sql, {
      connectionId,
      connectionLabel: connection.label,
      mode,
      dateFrom: range.from,
      dateTo: range.to,
      startedAt,
    });
    return await execute({ deps, connectionId, runId, range, options: runOptions, now, deadline: startedAt.getTime() + budgetMs });
  } finally {
    await releaseConnectionLease(deps.sql, attempt.lease);
  }
}

interface RunContext {
  deps: SyncDeps;
  connectionId: string;
  runId: string;
  range: { from: IsoDate; to: IsoDate };
  options: SyncOptions;
  now: () => Date;
  deadline: number;
}

async function execute(run: RunContext): Promise<SyncResult> {
  const { deps, connectionId, runId, range, options, now } = run;
  const reader = deps.reader ?? DEFAULT_READER;
  const pageSize = options.pageSize ?? SALE_LIST_PAGE_SIZE;
  let counts: SyncCounts = { ...NO_COUNTS };
  let page = options.startPage ?? 1;
  // Handed back to the Reader with the next page, so paging that does not advance fails loudly.
  let previous: InvoicePage | undefined;
  const checkpoint = (): SyncCheckpoint => ({ nextPage: page, pageSize });
  const client = new KrelosesClient(run);

  try {
    const locations = await client.call((session) => reader.listLocations(session));
    await recordLoginOutcome(deps.sql, connectionId, { ok: true, visibleLocations: locations });
    await upsertBranches(deps.sql, connectionId, locations);
    const staff = await client.call((session) => reader.listStaff(session));
    await upsertStaffDirectory(deps.sql, connectionId, staff);

    const outOfTime = () => now().getTime() >= run.deadline;
    const stopPartial = async (): Promise<SyncResult> => {
      await finishRun(deps.sql, runId, { status: "partial", finishedAt: now(), counts, checkpoint: checkpoint() });
      return { status: "partial", runId, counts };
    };
    for (;;) {
      if (outOfTime()) return await stopPartial();
      const result = await client.call((session) =>
        reader.listInvoices(session, { page, dateRange: range, includeCancelled: true, pageSize, previous }),
      );
      await deps.sql.begin(async (tx) => {
        const written = await saveInvoicePage(tx, { runId, connectionId, invoices: result.invoices, fetchedAt: now() });
        counts = {
          ...counts,
          pages: counts.pages + 1,
          invoicesSeen: counts.invoicesSeen + result.invoices.length,
          inserted: counts.inserted + written.inserted,
          updated: counts.updated + written.updated,
          unchanged: counts.unchanged + written.unchanged,
        };
        // This page is where to carry on until its line items have been read too.
        await recordProgress(tx, runId, counts, checkpoint());
      });

      // Line items of the page's new and changed invoices, one Sale Overview page at a time.
      for (const invoice of await invoicesNeedingLines(deps.sql, result.invoices.map((invoice) => invoice.saleId))) {
        if (outOfTime()) return await stopPartial();
        const detail = await client.call((session) => reader.getInvoice(session, invoice.saleId));
        await saveInvoiceLines(deps.sql, { invoiceId: invoice.invoiceId, detail, fetchedAt: now() });
        counts = { ...counts, lineItemsRead: counts.lineItemsRead + 1 };
        await recordProgress(deps.sql, runId, counts, checkpoint());
      }
      await recordProgress(deps.sql, runId, counts, result.hasMore ? { nextPage: page + 1, pageSize } : null);
      if (!result.hasMore) break;
      previous = result;
      page += 1;
    }

    await finishRun(deps.sql, runId, {
      status: "succeeded",
      finishedAt: now(),
      counts,
      coveredLocationIds: locations.map((location) => location.id),
    });
    return { status: "succeeded", runId, counts };
  } catch (error) {
    const failure = describeSyncFailure(error);
    if (failure.code === "internal") {
      console.error(`[sync] run ${runId} (connection ${connectionId}) failed unexpectedly: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
    }
    if (isLoginFailure(error)) await recordLoginOutcome(deps.sql, connectionId, { ok: false, error });
    await finishRun(deps.sql, runId, {
      status: "failed",
      finishedAt: now(),
      counts,
      checkpoint: counts.pages > 0 || page > 1 ? checkpoint() : null,
      errorCode: failure.code,
      error: failure.message,
    });
    return { status: "failed", runId, counts, error: failure };
  }
}

/**
 * A run's Kreloses session: logs in lazily, logs in again ONCE per run when the session expires,
 * and retries `RateLimited` / `Transient` with backoff while the time budget allows.
 */
class KrelosesClient {
  #session: KrelosesSession | null = null;
  #loggedInAgain = false;
  readonly #run: RunContext;

  constructor(run: RunContext) {
    this.#run = run;
  }

  async call<T>(request: (session: KrelosesSession) => Promise<T>): Promise<T> {
    this.#session ??= await this.#retrying(() => this.#run.deps.login(this.#run.connectionId));
    try {
      return await this.#retrying(() => request(this.#session!));
    } catch (error) {
      if (!(error instanceof AuthFailed && error.reason === "session_expired") || this.#loggedInAgain) throw error;
      this.#loggedInAgain = true;
      this.#session = await this.#retrying(() => this.#run.deps.login(this.#run.connectionId));
      return this.#retrying(() => request(this.#session!));
    }
  }

  async #retrying<T>(attempt: () => Promise<T>): Promise<T> {
    const { deps, options, now, deadline } = this.#run;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let retry = 0; ; retry += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof RateLimited || error instanceof Transient) || retry >= maxRetries) throw error;
        const wait =
          error instanceof RateLimited && error.retryAfterSeconds !== undefined
            ? error.retryAfterSeconds * 1000
            : RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]!;
        // Not worth waiting if the budget would run out first: the next sync tries again.
        if (now().getTime() + wait >= deadline) throw error;
        await sleep(wait);
      }
    }
  }
}
