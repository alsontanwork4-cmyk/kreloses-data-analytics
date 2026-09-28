import { isConnectionId } from "@/connections/store";
import type { Sql } from "@/db/sql";
import { addDays, clinicToday, endOfMonth, startOfMonth, type IsoDate } from "@/filters";
import type { KrelosesSession } from "@/kreloses";

import { BACKFILL_CHUNK_BUDGET_MS, nightWindowAt, type BackfillConfig } from "./backfill-config";
import { completeBackfill, planBackfill } from "./backfill-store";
import { runSync, type StopReason, type SyncDeps, type SyncResult } from "./engine";
import type { SyncCounts, SyncErrorCode } from "./runs";

/**
 * The history backfill (#8, spec stories 10–12): every invoice of a connection's Kreloses login
 * from 1 Jan 2024 up to the day its first chunk ran, loaded MONTH BY MONTH, NEWEST FIRST (recent
 * history is the most useful soonest), in small chunks spread over several nights.
 *
 *   const outcome = await runBackfill(backfillSyncDeps(), { config: backfillConfigFromEnv() });   // the endpoint
 *
 * One chunk of one connection (`runBackfillChunk`), in order:
 * 1. Does nothing — without a single Kreloses request — outside the night window, when the backfill
 *    is not active (never started, paused, complete), while the connection's login is failing, once
 *    tonight's request budget is used up, or after tonight's latest backfill run failed because
 *    Kreloses asked to slow down or changed its pages (the next night tries again).
 * 2. Fixes the backfill's dates on its first chunk: 1 Jan 2024 → the clinic day it ran.
 * 3. Takes the newest month that is not done yet and runs the Sync Engine over exactly that month
 *    (`mode: "backfill"`, page-based checkpoint, `resume` from the month's previous backfill run, no
 *    sweep), with the rest of the chunk's time and of tonight's request budget; while the month
 *    completes with time and budget left, goes on to the next one — reusing the Kreloses session,
 *    so one chunk logs in once.
 * 4. Stops at the time limit, the request budget, when the nightly sync or Sync now asks for the
 *    connection (the run steps aside, docs/adr/0010), on a failure, or when every month is done
 *    (the backfill becomes `complete`).
 *
 * A month is DONE once any complete sync run of this connection — succeeded, or read its whole
 * listing with some invoice pages missing — covered all its days: the backfill's own, a nightly
 * whose window contained it, or a Sync now of that month. So months the nightly sync already read
 * are never listed again, and within a month the Sync Engine opens only invoice pages whose line
 * items are not current (`invoicesNeedingLines`): no invoice page is read twice for the same
 * header, whichever mode read it first. Idempotent: running a month again changes nothing.
 */

/** Chains of a month's runs older than this start the month afresh (a re-listing; no page is read twice). */
export const BACKFILL_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A month's run is not started with less of the chunk's time left than this. */
export const MIN_BACKFILL_RUN_MS = 20_000;
/** Failures after which the connection's backfill waits for the next night (Kreloses must not be pushed). */
const STOP_FOR_THE_NIGHT: readonly SyncErrorCode[] = ["rate_limited", "layout_changed"];
/** Retries per request within a backfill run (the next chunk, 15 minutes later, tries again anyway). */
const BACKFILL_MAX_RETRIES = 1;

export interface BackfillMonth {
  /** `"YYYY-MM"` */
  month: string;
  /** The month's days within the backfill's dates. */
  from: IsoDate;
  to: IsoDate;
}

/** The calendar months from `from` to `to` (clinic days, inclusive), newest first, clipped to the dates. */
export function backfillMonths(from: IsoDate, to: IsoDate): BackfillMonth[] {
  const months: BackfillMonth[] = [];
  for (let start = startOfMonth(to); start >= startOfMonth(from); start = startOfMonth(addDays(start, -1))) {
    months.push({ month: start.slice(0, 7), from: start < from ? from : start, to: endOfMonth(start) > to ? to : endOfMonth(start) });
  }
  return months;
}

/**
 * The months (`"YYYY-MM"`) covered completely by a complete sync run of this connection (any
 * kind): a run that succeeded or read its whole listing, whose dates include all the month's days.
 */
export async function completedMonths(sql: Sql, connectionId: string, months: readonly BackfillMonth[]): Promise<Set<string>> {
  if (months.length === 0) return new Set();
  const rows = await sql<{ month: string }[]>`
    select m.month
    from unnest(${months.map((m) => m.month)}::text[], ${months.map((m) => m.from)}::date[], ${months.map((m) => m.to)}::date[])
      as m(month, date_from, date_to)
    where exists (
      select 1 from sync_runs r
      where r.connection_id = ${connectionId}
        and (r.status = 'succeeded' or cardinality(r.covered_location_ids) > 0)
        and r.date_from <= m.date_from and r.date_to >= m.date_to
    )
  `;
  return new Set(rows.map((row) => row.month));
}

/** The night's backfill so far for a connection: requests sent, and how its latest run ended. */
export async function backfillNight(
  sql: Sql,
  connectionId: string,
  night: { start: Date; end: Date },
): Promise<{ requestsUsed: number; latestErrorCode: SyncErrorCode | null }> {
  const [row] = await sql<{ requestsUsed: number; latestErrorCode: SyncErrorCode | null }[]>`
    select
      coalesce(sum(coalesce((r.counts ->> 'requests')::int, 0)), 0)::int as requests_used,
      (
        select l.error_code from sync_runs l
        where l.connection_id = ${connectionId} and l.mode = 'backfill' and l.started_at >= ${night.start} and l.started_at < ${night.end}
        order by l.started_at desc, l.id desc
        limit 1
      ) as latest_error_code
    from sync_runs r
    where r.connection_id = ${connectionId} and r.mode = 'backfill' and r.started_at >= ${night.start} and r.started_at < ${night.end}
  `;
  return row!;
}

export interface BackfillChunkOptions {
  config: BackfillConfig;
  /** This chunk's time budget. Default `BACKFILL_CHUNK_BUDGET_MS` (240 s). */
  budgetMs?: number;
  /** Sale List rows per page (tests). Default 500. */
  pageSize?: number;
}

/** One month's run within a chunk. */
export interface BackfillChunkRun {
  month: string;
  runId: string;
  status: "succeeded" | "partial" | "failed";
  counts: SyncCounts;
  error?: string;
}

export type BackfillIdleReason =
  | "outside_window"
  | "not_started"
  | "paused"
  | "complete"
  | "login_failed"
  | "budget_spent"
  | "failed_tonight";

export type BackfillChunkResult =
  /** Nothing to do: no Kreloses request was sent. */
  | { status: "idle"; reason: BackfillIdleReason }
  /**
   * Worked on one or more months. `stoppedBy`: `complete` (every month is done now), `time_limit`,
   * `request_limit` (tonight's budget), `yielded` (the nightly sync or Sync now needed the login),
   * `busy` (another sync held it), `paused` (by the owner meanwhile) or `failed` (see `error`).
   */
  | {
      status: "ran";
      runs: BackfillChunkRun[];
      requests: number;
      monthsCompleted: number;
      stoppedBy: "complete" | StopReason | "busy" | "paused" | "failed";
      error?: string;
    };

/** One chunk of one connection's backfill; see the module comment. */
export async function runBackfillChunk(deps: SyncDeps, connectionId: string, options: BackfillChunkOptions): Promise<BackfillChunkResult> {
  const { sql } = deps;
  const now = deps.now ?? (() => new Date());
  const entry = now();
  const deadline = entry.getTime() + (options.budgetMs ?? BACKFILL_CHUNK_BUDGET_MS);
  const budget = options.config.maxRequestsPerNight;
  const night = nightWindowAt(entry, options.config.nightWindow);
  if (!night.inWindow) return { status: "idle", reason: "outside_window" };

  const idle = await idleReason(sql, connectionId);
  if (idle) return { status: "idle", reason: idle };
  const tonight = await backfillNight(sql, connectionId, night);
  if (tonight.requestsUsed >= budget) return { status: "idle", reason: "budget_spent" };
  if (tonight.latestErrorCode && STOP_FOR_THE_NIGHT.includes(tonight.latestErrorCode)) return { status: "idle", reason: "failed_tonight" };

  const plan = await planBackfill(sql, connectionId, clinicToday(entry), entry);
  const months = backfillMonths(plan.dateFrom, plan.dateTo);
  const session = sessionReuse(deps);
  const runs: BackfillChunkRun[] = [];
  let used = tonight.requestsUsed;
  let monthsCompleted = 0;
  let lastCompleted: string | null = null;
  const ran = (stoppedBy: Extract<BackfillChunkResult, { status: "ran" }>["stoppedBy"], error?: string): BackfillChunkResult => ({
    status: "ran",
    runs,
    requests: used - tonight.requestsUsed,
    monthsCompleted,
    stoppedBy,
    ...(error ? { error } : {}),
  });

  for (;;) {
    // The owner may pause it (or the connection may go) while a chunk runs: checked between months.
    if (runs.length > 0) {
      const stop = await idleReason(sql, connectionId);
      if (stop === "paused") return ran("paused");
      if (stop) return ran("failed");
    }
    const done = await completedMonths(sql, connectionId, months);
    const month = months.find((candidate) => !done.has(candidate.month));
    if (!month) {
      await completeBackfill(sql, connectionId, now());
      return ran("complete");
    }
    // A month whose run just completed must count as done (a complete run covers it): never loop on it.
    if (month.month === lastCompleted) throw new Error(`backfill month ${month.month} was read completely but is not recorded as done`);
    const left = deadline - now().getTime();
    if (left < MIN_BACKFILL_RUN_MS) return ran("time_limit");
    if (used >= budget) return ran("request_limit");

    const result: SyncResult = await runSync(session.forRun(), connectionId, "backfill", {
      dateRange: { from: month.from, to: month.to },
      resume: true,
      resumeMaxAgeMs: BACKFILL_RESUME_MAX_AGE_MS,
      sweep: false,
      timeBudgetMs: left,
      maxRequests: budget - used,
      maxRetries: BACKFILL_MAX_RETRIES,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    });
    if (result.status === "busy") return ran("busy");
    if (result.status === "not_found") return ran("failed", "The connection no longer exists.");
    used += result.counts.requests;
    runs.push({
      month: month.month,
      runId: result.runId,
      status: result.status,
      counts: result.counts,
      ...(result.error ? { error: result.error.message } : {}),
    });
    if (result.status === "failed") return ran("failed", result.error?.message);
    if (result.status === "partial" && result.stoppedAtTimeLimit) return ran(result.stopReason ?? "time_limit");
    // Succeeded, or read its whole listing with some invoice pages missing (retried by later syncs): done.
    monthsCompleted += 1;
    lastCompleted = month.month;
  }
}

/** Why a connection's backfill must not run now, or null if it may. */
async function idleReason(sql: Sql, connectionId: string): Promise<Exclude<BackfillIdleReason, "outside_window" | "budget_spent" | "failed_tonight"> | null> {
  if (!isConnectionId(connectionId)) return "not_started";
  const [row] = await sql<{ status: "active" | "paused" | "complete" | null; loginStatus: string }[]>`
    select b.status, c.status as login_status
    from connections c left join connection_backfills b on b.connection_id = c.id
    where c.id = ${connectionId}
  `;
  if (!row || row.status === null) return "not_started";
  if (row.status === "paused") return "paused";
  if (row.status === "complete") return "complete";
  // A login that fails must not be retried every 15 minutes (the account could be locked): the
  // nightly sync or "Test again" finds out when it works again.
  if (row.loginStatus === "failed") return "login_failed";
  return null;
}

/**
 * Hands every run of a chunk the same Kreloses session: each run's first login gets the session
 * of the run before (none for the first); a second login within a run (the session expired) logs
 * in afresh and is kept for the runs after.
 */
function sessionReuse(deps: SyncDeps): { forRun(): SyncDeps } {
  let current: KrelosesSession | null = null;
  return {
    forRun() {
      let logins = 0;
      return {
        ...deps,
        login: async (connectionId: string) => {
          logins += 1;
          if (logins === 1 && current) return current;
          current = await deps.login(connectionId);
          return current;
        },
      };
    },
  };
}

export interface BackfillConnectionResult {
  connectionId: string;
  connectionLabel: string;
  result: BackfillChunkResult;
}

export interface BackfillOutcome {
  /** The night window around the call (Kuala Lumpur time), and whether the call was inside it. */
  window: { start: Date; end: Date; inWindow: boolean; nextStart: Date };
  /** One entry per connection with an active backfill (none outside the window). */
  connections: BackfillConnectionResult[];
}

/**
 * The backfill endpoint's work: one chunk for every connection whose backfill is active. Logins that
 * see different branches run side by side (each has its own Kreloses login, lease and budget;
 * requests stay serial per login); logins that share a branch run one after the other within the
 * invocation's time, so they never open the same invoice page at the same moment (the second finds
 * its lines current). Outside the night window it returns at once without touching the database.
 */
export async function runBackfill(deps: SyncDeps, options: BackfillChunkOptions): Promise<BackfillOutcome> {
  const now = deps.now ?? (() => new Date());
  const start = now();
  const window = nightWindowAt(start, options.config.nightWindow);
  if (!window.inWindow) return { window, connections: [] };
  const deadline = start.getTime() + (options.budgetMs ?? BACKFILL_CHUNK_BUDGET_MS);
  const active = await deps.sql<{ id: string; label: string; locationIds: string[] }[]>`
    select c.id::text as id, c.label,
      array(select location ->> 'id' from jsonb_array_elements(c.visible_locations) as location) as location_ids
    from connections c join connection_backfills b on b.connection_id = c.id
    where b.status = 'active'
    order by c.id
  `;
  const chunkOf = async (connection: { id: string; label: string }): Promise<BackfillConnectionResult> => {
    try {
      const result = await runBackfillChunk(deps, connection.id, { ...options, budgetMs: Math.max(0, deadline - now().getTime()) });
      return { connectionId: connection.id, connectionLabel: connection.label, result };
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
      console.error(`[backfill] chunk of connection ${connection.id} threw: ${message}`);
      return { connectionId: connection.id, connectionLabel: connection.label, result: { status: "ran", runs: [], requests: 0, monthsCompleted: 0, stoppedBy: "failed", error: "internal error" } };
    }
  };
  const groups = await Promise.all(
    sharingBranches(active).map(async (group) => {
      const results: BackfillConnectionResult[] = [];
      for (const connection of group) results.push(await chunkOf(connection));
      return results;
    }),
  );
  const byId = new Map(groups.flat().map((result) => [result.connectionId, result]));
  return { window, connections: active.map((connection) => byId.get(connection.id)!) };
}

/** Connections grouped so that any two whose logins see a common Kreloses location are in the same group (order kept). */
function sharingBranches<T extends { id: string; locationIds: string[] }>(connections: readonly T[]): T[][] {
  const groups: { members: T[]; locations: Set<string> }[] = [];
  for (const connection of connections) {
    const joined = groups.filter((group) => connection.locationIds.some((id) => group.locations.has(id)));
    const merged = { members: [...joined.flatMap((group) => group.members), connection], locations: new Set([...joined.flatMap((group) => [...group.locations]), ...connection.locationIds]) };
    merged.members.sort((a, b) => connections.indexOf(a) - connections.indexOf(b));
    for (const group of joined) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups.map((group) => group.members);
}
