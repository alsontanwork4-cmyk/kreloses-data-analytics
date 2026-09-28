import { acquireConnectionLease, releaseConnectionLease, renewConnectionLease, type ConnectionLease, type LeasePurpose } from "@/connections/lock";
import { recordLoginOutcome } from "@/connections/service";
import { isConnectionId } from "@/connections/store";
import type { Queryable, Sql } from "@/db/sql";
import { addDays, clinicToday, endOfMonth, isIsoDate, startOfMonth, type IsoDate } from "@/filters";
import {
  AuthFailed,
  getInvoice,
  LayoutChanged,
  listInvoices,
  listLocations,
  listStaff,
  PageMissing,
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
import { reclassifyAllItems } from "@/items/store";
import { upsertStaffDirectory } from "@/staff/store";

import { countInvoicesNeedingLines, invoicesNeedingLines, recordMissingPage, saveInvoiceLines, type InvoiceNeedingLines, type SweepCursor } from "./lines";
import {
  describeSyncFailure,
  isLoginFailure,
  lineItemsLeftWarning,
  missingPagesWarning,
  staffListWarning,
  unreadablePagesWarning,
  type SyncFailure,
} from "./messages";
import {
  abandonRun,
  findResumableRun,
  finishRun,
  LEASE_LOST_MESSAGE,
  markInterruptedRuns,
  NO_COUNTS,
  recordProgress,
  RESUME_MAX_AGE_MS,
  startRun,
  type ResumePoint,
  type SyncCheckpoint,
  type SyncCounts,
  type SyncMode,
  type SyncWarning,
} from "./runs";
import { saveInvoicePage, upsertBranches } from "./store";

/**
 * The Sync Engine: reads a connection's Kreloses Sale List for a date range, page by page, stores
 * invoices, branches and customers idempotently, then reads the line items of the page's new and
 * changed invoices (#5) and derives their credited lines, recording a `sync_runs` row for every
 * run (including failures).
 *
 *   const result = await runSync(syncDeps(), connectionId, "manual", { dateRange: { from, to } });
 *   const nightly = await runSync(syncDeps(), connectionId, "nightly", { resume: true }); // #6
 *
 * One run, in order:
 * 1. Takes the connection's lease (`@/connections/lock`, database clock), so no other sync or login
 *    test uses the same Kreloses login meanwhile; if it is held, returns `{status: "busy"}` without a
 *    run row. Runs of this connection still marked `running` (their server died) become
 *    `interrupted`. EVERY write of the run renews the lease inside the writing transaction and the
 *    run stops the moment a renewal fails (fencing: after its lease expired another run took over),
 *    so two runs never write for one connection at once.
 * 2. With `resume`, carries on from the connection's latest run that stopped part-way (time limit,
 *    failure, crash) a few hours ago at most (`findResumableRun`): same dates, its checkpoint, and
 *    "data as of" = the start of the first run of that chain.
 * 3. Logs in, reads the branches and the staff list the login can see (the Connections page status
 *    is updated from this login: Connected, or Login failed with the reason); unmatched staff
 *    names on lines are matched again against the staff list.
 * 4. Reads Sale List pages serially (the Reader waits its polite delay between requests); each page
 *    is stored with the run's counts and checkpoint in one transaction, so a crash loses nothing
 *    already read.
 * 5. After each page, reads the Sale Overview page of each of its invoices whose line items are
 *    missing or stale (`invoicesNeedingLines`, in ./lines.ts: the ONE place deciding that — an
 *    unchanged invoice costs no request) and stores lines + credited lines per invoice in one
 *    transaction (`saveInvoiceLines`). The page stays the checkpoint until its line items are done.
 *    A page that is not there (`PageMissing`) is skipped and counted (`lineItemsFailed`); the
 *    invoice stays "not synced yet" and is tried again by later runs, up to
 *    `MAX_PAGE_MISSING_ATTEMPTS` times in a row.
 * 6. Nightly only: the SWEEP — active invoices of ANY date whose lines are still not current (synced
 *    before line items existed, changed outside the window, left pending by a missing page), newest
 *    first, while the time budget lasts (`line_items_left` warning when it runs out).
 * 7. Finishes `succeeded`, `partial` (time budget reached — `checkpoint` says where to carry on —
 *    or everything read but some invoice pages missing) or `failed` (also when the first
 *    MISSING_PAGES_TO_FAIL invoice pages it tries for the first time are all missing). Warnings go
 *    on the run.
 *
 * Errors: `AuthFailed` and `LayoutChanged` are never retried (the owner or a code fix must act); an
 * expired session gets ONE fresh login per run; `RateLimited` / `Transient` are retried with
 * backoff (honouring Retry-After) within the time budget, then the run fails and the next sync
 * tries again.
 *
 * Modes: `manual` ("Sync now": one chosen month), `nightly` (the cron: a recent window,
 * `nightlyWindow`, change detection + sweep, date-based checkpoint), `backfill` (#8: bounded past
 * ranges, page-based checkpoint).
 */
export interface SyncDeps {
  sql: Sql;
  /** Logs in as the connection; in the app `(id) => loginAsConnection(connectionsContext(), id)`. */
  login: (connectionId: string) => Promise<KrelosesSession>;
  /** Defaults to the Kreloses Reader. Tests may pass a fake. */
  reader?: SyncReader;
  /** The clock (run timestamps, the time budget). Default: the real time. The lease uses the database clock. */
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
  /**
   * Clinic days to read (inclusive). Default: `nightly` → the last `windowDays` days up to today
   * (`nightlyWindow`); otherwise the current clinic month.
   */
  dateRange?: { from: IsoDate; to: IsoDate };
  /** Nightly: how many days back from today the window starts. Default `NIGHTLY_WINDOW_DAYS` (45). */
  windowDays?: number;
  /** No new Kreloses request starts after this long; the run stops as `partial`. Default 200 s. */
  timeBudgetMs?: number;
  /** Sale List rows per page. Default 500 (the Kreloses UI's). */
  pageSize?: number;
  /** First page to read, when carrying on from a known page. Default 1. Disables `resume`. */
  startPage?: number;
  /**
   * Carry on from the connection's latest run of the same mode (nightly: any window; otherwise
   * exactly these dates) if it stopped part-way — at its time budget, or failed / interrupted with a
   * checkpoint — and its chain started less than `resumeMaxAgeMs` ago; otherwise start afresh.
   * "Sync now" and the nightly cron use it.
   */
  resume?: boolean;
  /** Oldest chain `resume` carries on (from the start of its first run). Default 6 hours. */
  resumeMaxAgeMs?: number;
  /** Retries per request for RateLimited / Transient. Default 3. */
  maxRetries?: number;
  /** Also sweep invoices of any date whose line items are not current. Default: nightly only. */
  sweep?: boolean;
}

export type SyncResult =
  | {
      status: "succeeded" | "partial" | "failed";
      runId: string;
      counts: SyncCounts;
      error?: SyncFailure;
      /** Things to tell the owner even though the run did not fail (also on Sync status). */
      warnings: SyncWarning[];
      /**
       * For `partial`: true = stopped at the time budget (carry on from `checkpoint`); false = read
       * everything but some invoice pages were missing (`counts.lineItemsFailed`) — a COMPLETE
       * listing (it counts for "data as of" and is never resumed).
       */
      stoppedAtTimeLimit?: boolean;
      /** The run this one carried on from (`resume`), if any. */
      resumedFromRunId?: string;
    }
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
/**
 * The lease lasts this long past the database's `now()` at every renewal (every write): longer than
 * the longest stretch without a write (one Kreloses request with its retries: at most 20 s × 4 +
 * 65 s of backoff), so a healthy run never loses it, and a crashed run frees the connection soon.
 */
export const LEASE_TTL_MS = 240_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const DEFAULT_MAX_RETRIES = 3;
/**
 * A run fails when this many invoice pages of its LISTING (new or changed sales), tried for the first
 * time, are missing before any could be read. The sweep of older invoices never fails a run.
 */
export const MISSING_PAGES_TO_FAIL = 3;
/**
 * A login (the first, or the one fresh login after an expired session) is not started with less of
 * the time budget left than this: it takes several requests, and must not run past the function's
 * limit. The run stops cleanly (`partial`) instead and the next sync carries on.
 */
export const MIN_LOGIN_BUDGET_MS = 15_000;
/** The nightly window: this many days back from today (spec story 13: edits, cancellations, refunds). */
export const NIGHTLY_WINDOW_DAYS = 45;
/** Invoices the sweep loads at a time. */
const SWEEP_BATCH = 50;

const DEFAULT_READER: SyncReader = { listLocations, listStaff, listInvoices, getInvoice };

/** The clinic month containing `now`, first to last day. */
export function currentClinicMonth(now: Date): { from: IsoDate; to: IsoDate } {
  const today = clinicToday(now);
  return { from: startOfMonth(today), to: endOfMonth(today) };
}

/** The nightly window: `days` clinic days back from today, up to today (inclusive). */
export function nightlyWindow(now: Date, days: number = NIGHTLY_WINDOW_DAYS): { from: IsoDate; to: IsoDate } {
  if (!Number.isInteger(days) || days < 0 || days > 3660) throw new RangeError(`bad nightly window of ${days} days`);
  const today = clinicToday(now);
  return { from: addDays(today, -days), to: today };
}

/** Thrown inside a write when the run's lease was lost: the run stops writing at once. */
class LeaseLost extends Error {
  constructor() {
    super("the connection lease was lost");
    this.name = "LeaseLost";
  }
}

export async function runSync(deps: SyncDeps, connectionId: string, mode: SyncMode, options: SyncOptions = {}): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const requested = options.dateRange ?? (mode === "nightly" ? nightlyWindow(now(), options.windowDays) : currentClinicMonth(now()));
  if (!isIsoDate(requested.from) || !isIsoDate(requested.to) || requested.from > requested.to) {
    throw new RangeError(`bad sync date range ${requested.from}..${requested.to}`);
  }
  const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const pageSize = options.pageSize ?? SALE_LIST_PAGE_SIZE;
  if (!isConnectionId(connectionId)) return { status: "not_found" };
  const [connection] = await deps.sql<{ label: string }[]>`select label from connections where id = ${connectionId}`;
  if (!connection) return { status: "not_found" };

  const attempt = await acquireConnectionLease(deps.sql, connectionId, { purpose: "sync", ttlMs: LEASE_TTL_MS });
  if (attempt.status !== "acquired") return attempt;
  try {
    await markInterruptedRuns(deps.sql, connectionId, now());
    // #9: every item name's service-mix classification brought up to date with the rules as they are
    // now — names stored without one, and rule changes made outside the app (a seed-rule migration).
    // Every run goes through here (manual, nightly and its sweep).
    await reclassifyAllItems(deps.sql);
    const resumeFrom =
      options.resume && options.startPage === undefined
        ? await findResumableRun(deps.sql, connectionId, { mode, range: requested, pageSize, now: now(), maxAgeMs: options.resumeMaxAgeMs ?? RESUME_MAX_AGE_MS })
        : null;
    const range = resumeFrom?.range ?? requested;
    const startedAt = now();
    const runId = await startRun(deps.sql, {
      connectionId,
      connectionLabel: connection.label,
      mode,
      dateFrom: range.from,
      dateTo: range.to,
      startedAt,
      resumes: resumeFrom ? { runId: resumeFrom.runId, chainStartedAt: resumeFrom.chainStartedAt } : null,
    });
    return await execute({
      deps,
      lease: attempt.lease,
      connectionId,
      runId,
      mode,
      range,
      pageSize,
      resumeFrom,
      options,
      now,
      deadline: startedAt.getTime() + budgetMs,
    });
  } finally {
    await releaseConnectionLease(deps.sql, attempt.lease);
  }
}

interface RunContext {
  deps: SyncDeps;
  lease: ConnectionLease;
  connectionId: string;
  runId: string;
  mode: SyncMode;
  range: { from: IsoDate; to: IsoDate };
  pageSize: number;
  resumeFrom: ResumePoint | null;
  options: SyncOptions;
  now: () => Date;
  deadline: number;
}

/** A run stopped at its time budget: unwinds to `execute`, which records it as `partial`. */
class OutOfTime extends Error {
  constructor() {
    super("time budget reached");
    this.name = "OutOfTime";
  }
}

async function execute(run: RunContext): Promise<SyncResult> {
  const { deps, connectionId, runId, range, pageSize, now } = run;
  const reader = deps.reader ?? DEFAULT_READER;
  const dateBased = run.mode === "nightly";
  const sweep = run.options.sweep ?? run.mode === "nightly";
  let counts: SyncCounts = { ...NO_COUNTS };
  const warnings: SyncWarning[] = [];
  // Where to carry on: a page (fixed ranges) or, nightly, "everything newer than processedAfter".
  let checkpoint: SyncCheckpoint = initialCheckpoint(run);
  const startedMidway = checkpoint.nextPage > 1 || checkpoint.processedAfter !== undefined || checkpoint.listingDone === true;
  const client = new KrelosesClient(run);
  /** Invoices whose page this run has tried (the sweep never tries one twice). */
  const tried = new Set<string>();
  let firstTimeMissing = 0;

  /** Every write goes through here: renew the lease in the same transaction, or stop. */
  const fence = async (tx: Queryable) => {
    if (!(await renewConnectionLease(tx, run.lease, LEASE_TTL_MS))) throw new LeaseLost();
  };
  const fenced = <T>(write: (tx: Queryable) => Promise<T>): Promise<T> =>
    deps.sql.begin(async (tx) => {
      await fence(tx);
      return write(tx);
    }) as Promise<T>;
  const outOfTime = () => now().getTime() >= run.deadline;
  let firstUnreadable: LayoutChanged | null = null;
  /** The run's warnings, plus the invoice pages it could not open or read. */
  const withPageWarnings = (): SyncWarning[] => [
    ...warnings,
    ...(counts.lineItemsFailed > 0 ? [missingPagesWarning(counts.lineItemsFailed)] : []),
    ...(counts.lineItemsUnreadable > 0 && firstUnreadable ? [unreadablePagesWarning(counts.lineItemsUnreadable, firstUnreadable)] : []),
  ];

  /** Reads one invoice's page and stores its lines (or records it missing). Check the time budget first. */
  const readLines = async (invoice: InvoiceNeedingLines, swept: boolean) => {
    tried.add(invoice.invoiceId);
    let detail: KrelosesInvoiceDetail;
    try {
      detail = await client.call((session) => reader.getInvoice(session, invoice.saleId));
    } catch (error) {
      // One page that is not there must not stop every other invoice (nor "data as of"): skip it —
      // it stays "not synced yet" at its revenue base — and try again next run (up to
      // MAX_PAGE_MISSING_ATTEMPTS times). In the LISTING, a page whose content changed
      // (LayoutChanged proper) stays fatal — a new or changed sale the app cannot read means
      // Kreloses changed — and so does a run whose first MISSING_PAGES_TO_FAIL never-tried pages
      // are all missing (something systematic, e.g. a new URL); pages already missing in earlier
      // runs do not count, so a few permanently missing pages never fail every sync. In the SWEEP
      // (older sales), neither ever fails the run: one odd old page must not stop every night (and
      // "data as of"); it is a warning and the listing still counts. A page that is not THERE uses
      // up one of its MAX_PAGE_MISSING_ATTEMPTS; a page the app cannot READ does not (a layout the
      // app does not know is the app's problem, not the invoice's: once the app is updated, the next
      // sweep reads it — it must never have become "permanently missing" in between).
      const missing = error instanceof PageMissing;
      const unreadable = swept && !missing && error instanceof LayoutChanged;
      if (!missing && !unreadable) throw error;
      if (missing) counts = { ...counts, lineItemsFailed: counts.lineItemsFailed + 1 };
      else {
        counts = { ...counts, lineItemsUnreadable: counts.lineItemsUnreadable + 1 };
        firstUnreadable ??= error as LayoutChanged;
      }
      if (!swept && invoice.missingAttempts === 0) firstTimeMissing += 1;
      await fenced(async (tx) => {
        if (missing) await recordMissingPage(tx, invoice.invoiceId, invoice.headerVersion);
        await recordProgress(tx, runId, counts, checkpoint);
      });
      if (!swept && counts.lineItemsRead === 0 && firstTimeMissing >= MISSING_PAGES_TO_FAIL) throw error;
      return;
    }
    const saved = await saveInvoiceLines(deps.sql, { invoiceId: invoice.invoiceId, headerVersion: invoice.headerVersion, detail, fetchedAt: now() }, { fence });
    if (saved.status === "stored") {
      counts = {
        ...counts,
        lineItemsRead: counts.lineItemsRead + 1,
        lineItemGaps: counts.lineItemGaps + (saved.gapSen !== 0 ? 1 : 0),
        lineItemsSwept: counts.lineItemsSwept + (swept ? 1 : 0),
      };
    }
    await fenced((tx) => recordProgress(tx, runId, counts, checkpoint));
  };

  try {
    // KrelosesClient.call stops the run (OutOfTime) instead of starting a request or a login past the budget.
    const locations = await client.call((session) => reader.listLocations(session));
    // The Kreloses locations (branches) this login can see: what it covers, and all its sweep may open.
    const locationIds = locations.map((location) => location.id);
    await fenced(async (tx) => {
      await recordLoginOutcome(tx, connectionId, { ok: true, visibleLocations: locations });
      await upsertBranches(tx, connectionId, locations);
    });
    try {
      const staff = await client.call((session) => reader.listStaff(session));
      await upsertStaffDirectory(deps.sql, connectionId, staff, { fence });
    } catch (error) {
      // The staff list only improves name matching: without it, lines are still credited (to
      // unmatched names), so it is a warning, never a reason to stop the sync.
      if (!(error instanceof LayoutChanged)) throw error;
      warnings.push(staffListWarning(error));
    }

    // 1. The listing (change detection): headers, then the page's new and changed invoices' lines.
    if (!checkpoint.listingDone) {
      // Nightly carries on by date: only the days up to the last processed sale are listed again.
      const listTo = dateBased && checkpoint.processedAfter ? minDate(range.to, clinicToday(new Date(checkpoint.processedAfter))) : range.to;
      let page = dateBased && checkpoint.processedAfter ? 1 : checkpoint.nextPage;
      // Handed back to the Reader with the next page, so paging that does not advance fails loudly.
      let previous: InvoicePage | undefined;
      while (listTo >= range.from) {
        if (outOfTime()) throw new OutOfTime();
        const result = await client.call((session) =>
          reader.listInvoices(session, { page, dateRange: { from: range.from, to: listTo }, includeCancelled: true, pageSize, previous }),
        );
        await fenced(async (tx) => {
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
          await recordProgress(tx, runId, counts, checkpoint);
        });

        // Line items of the page's new and changed invoices, one Sale Overview page at a time.
        for (const invoice of await invoicesNeedingLines(deps.sql, { saleIds: result.invoices.map((invoice) => invoice.saleId) })) {
          if (outOfTime()) throw new OutOfTime();
          await readLines(invoice, false);
        }

        // The page is done: move the checkpoint past it.
        checkpoint = { ...checkpoint, nextPage: page + 1 };
        if (dateBased && result.span?.newestFirstSoFar) {
          const oldest = result.span.oldestAt.toISOString();
          if (!checkpoint.processedAfter || oldest < checkpoint.processedAfter) checkpoint = { ...checkpoint, processedAfter: oldest };
        }
        if (!result.hasMore) checkpoint = dateBased ? { ...checkpoint, listingDone: true } : checkpoint;
        const done = !result.hasMore;
        await fenced((tx) => recordProgress(tx, runId, counts, dateBased || !done ? checkpoint : null));
        if (done) break;
        previous = result;
        page += 1;
      }
      if (dateBased) checkpoint = { ...checkpoint, listingDone: true };
    }

    // 2. The sweep (nightly): invoices of any date whose line items are still not current.
    if (sweep) {
      let after: SweepCursor | undefined;
      sweeping: for (;;) {
        // Only invoices of the branches THIS login listed this run: another login's are not ours to open.
        const batch = await invoicesNeedingLines(deps.sql, { sweep: { locationIds, limit: SWEEP_BATCH, after } });
        if (batch.length === 0) break;
        for (const invoice of batch) {
          after = { saleAt: invoice.saleAt, invoiceId: invoice.invoiceId };
          if (tried.has(invoice.invoiceId)) continue;
          if (outOfTime()) {
            warnings.push(lineItemsLeftWarning(await countInvoicesNeedingLines(deps.sql, { locationIds })));
            break sweeping;
          }
          await readLines(invoice, true);
        }
      }
    }

    const coveredLocationIds = locationIds;
    if (counts.lineItemsFailed > 0 || counts.lineItemsUnreadable > 0) {
      // The whole listing was read (it counts for "data as of" and is complete: never resumed), but
      // some invoices still need their lines: the next sync retries them.
      await fenced((tx) =>
        finishRun(tx, runId, { status: "partial", finishedAt: now(), counts, checkpoint: { nextPage: 1, pageSize }, coveredLocationIds, warnings: withPageWarnings() }),
      );
      return { status: "partial", runId, counts, warnings: withPageWarnings(), stoppedAtTimeLimit: false, ...resumed(run) };
    }
    await fenced((tx) => finishRun(tx, runId, { status: "succeeded", finishedAt: now(), counts, coveredLocationIds, warnings }));
    return { status: "succeeded", runId, counts, warnings, ...resumed(run) };
  } catch (error) {
    if (error instanceof LeaseLost) return await leaseLost(run, counts, warnings);
    try {
      if (error instanceof OutOfTime) {
        await fenced((tx) => finishRun(tx, runId, { status: "partial", finishedAt: now(), counts, checkpoint, warnings: withPageWarnings() }));
        return { status: "partial", runId, counts, warnings: withPageWarnings(), stoppedAtTimeLimit: true, ...resumed(run) };
      }
      const failure = describeSyncFailure(error);
      if (failure.code === "internal") {
        console.error(`[sync] run ${runId} (connection ${connectionId}) failed unexpectedly: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
      }
      await fenced(async (tx) => {
        if (isLoginFailure(error)) await recordLoginOutcome(tx, connectionId, { ok: false, error });
        await finishRun(tx, runId, {
          status: "failed",
          finishedAt: now(),
          counts,
          // Where a later run can carry on (nothing, if nothing was read and it started from scratch).
          checkpoint: counts.pages > 0 || startedMidway ? checkpoint : null,
          errorCode: failure.code,
          error: failure.message,
          warnings,
        });
      });
      return { status: "failed", runId, counts, error: failure, warnings, ...resumed(run) };
    } catch (writeError) {
      if (writeError instanceof LeaseLost) return await leaseLost(run, counts, warnings);
      throw writeError;
    }
  }
}

/** The run lost its lease: it records only that it stopped (if nobody did yet) and writes nothing else. */
async function leaseLost(run: RunContext, counts: SyncCounts, warnings: SyncWarning[]): Promise<SyncResult> {
  await abandonRun(run.deps.sql, run.runId, run.now());
  return { status: "failed", runId: run.runId, counts, error: { code: "interrupted", message: LEASE_LOST_MESSAGE }, warnings, ...resumed(run) };
}

function resumed(run: RunContext): { resumedFromRunId?: string } {
  return run.resumeFrom ? { resumedFromRunId: run.resumeFrom.runId } : {};
}

/** Where the run starts: an explicit page, the checkpoint of the run it resumes, or the beginning. */
function initialCheckpoint(run: RunContext): SyncCheckpoint {
  if (run.options.startPage !== undefined) return { nextPage: run.options.startPage, pageSize: run.pageSize };
  const from = run.resumeFrom?.checkpoint;
  if (!from) return { nextPage: 1, pageSize: run.pageSize };
  const checkpoint: SyncCheckpoint = { nextPage: from.nextPage, pageSize: run.pageSize };
  if (run.mode === "nightly" && from.processedAfter) checkpoint.processedAfter = from.processedAfter;
  if (run.mode === "nightly" && from.listingDone) checkpoint.listingDone = true;
  return checkpoint;
}

function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a < b ? a : b;
}

/**
 * A run's Kreloses session: logs in lazily, logs in again ONCE per run when the session expires,
 * and retries `RateLimited` / `Transient` with backoff while the time budget allows. Requests are
 * awaited one at a time, and the Reader's session queues them with its polite delay.
 */
class KrelosesClient {
  #session: KrelosesSession | null = null;
  #loggedInAgain = false;
  readonly #run: RunContext;

  constructor(run: RunContext) {
    this.#run = run;
  }

  async call<T>(request: (session: KrelosesSession) => Promise<T>): Promise<T> {
    this.#session ??= await this.#login();
    // No new request once the budget is spent (the listing and the line items check before each
    // one too; this also covers the start: locations and the staff list after a slow login).
    if (this.#run.now().getTime() >= this.#run.deadline) throw new OutOfTime();
    try {
      return await this.#retrying(() => request(this.#session!));
    } catch (error) {
      if (!(error instanceof AuthFailed && error.reason === "session_expired") || this.#loggedInAgain) throw error;
      this.#loggedInAgain = true;
      this.#session = await this.#login();
      return this.#retrying(() => request(this.#session!));
    }
  }

  /** Logs in, unless too little of the budget is left for a login to finish (then the run stops cleanly). */
  async #login(): Promise<KrelosesSession> {
    if (this.#run.now().getTime() + MIN_LOGIN_BUDGET_MS > this.#run.deadline) throw new OutOfTime();
    return this.#retrying(() => this.#run.deps.login(this.#run.connectionId));
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
