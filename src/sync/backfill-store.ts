import { isConnectionId } from "@/connections/store";
import type { Queryable, Sql } from "@/db/sql";
import type { IsoDate } from "@/filters";

/**
 * A connection's history backfill (`connection_backfills`, #8): whether it runs, and which dates it
 * loads. Where each month stands is derived from `sync_runs` (./backfill.ts). No imports from the
 * Sync Engine, so the connections service can start a backfill without an import cycle.
 */
export type BackfillStatus = "active" | "paused" | "complete";

export interface BackfillState {
  connectionId: string;
  status: BackfillStatus;
  dateFrom: IsoDate;
  /** Null until the first chunk runs (it fixes the last day as the clinic day it ran). */
  dateTo: IsoDate | null;
  requestedAt: Date;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
}

const COLUMNS = `
  connection_id::text as connection_id, status, date_from, date_to, requested_at, started_at, paused_at, completed_at
`;

export async function readBackfill(sql: Queryable, connectionId: string): Promise<BackfillState | null> {
  if (!isConnectionId(connectionId)) return null;
  const [row] = await sql<BackfillState[]>`select ${sql.unsafe(COLUMNS)} from connection_backfills where connection_id = ${connectionId}`;
  return row ?? null;
}

/**
 * Asks for a connection's backfill the first time its login works (spec story 10: "history from
 * 1 Jan 2024 loaded on first connection"). A backfill that exists already — running, paused by the
 * owner, or complete — is left as it is.
 */
export async function ensureBackfill(sql: Queryable, connectionId: string): Promise<void> {
  await sql`
    insert into connection_backfills (connection_id, status) values (${connectionId}, 'active')
    on conflict (connection_id) do nothing
  `;
}

/**
 * "Start backfill" (owner): starts one that was never started, or resumes a paused one where it
 * stopped. A complete one stays complete. Null if the connection does not exist.
 */
export async function startBackfill(sql: Sql, connectionId: string): Promise<BackfillState | null> {
  if (!isConnectionId(connectionId)) return null;
  try {
    await sql`
      insert into connection_backfills (connection_id, status) values (${connectionId}, 'active')
      on conflict (connection_id) do update set status = 'active', paused_at = null
      where connection_backfills.status = 'paused'
    `;
  } catch (error) {
    if ((error as { code?: string }).code === "23503") return null; // no such connection
    throw error;
  }
  return readBackfill(sql, connectionId);
}

/** "Pause backfill" (owner): no more chunks until it is started again; progress is kept. */
export async function pauseBackfill(sql: Sql, connectionId: string): Promise<BackfillState | null> {
  if (!isConnectionId(connectionId)) return null;
  await sql`
    update connection_backfills set status = 'paused', paused_at = now()
    where connection_id = ${connectionId} and status = 'active'
  `;
  return readBackfill(sql, connectionId);
}

/**
 * The dates a backfill loads, fixed by its first chunk: `today` (the clinic day it ran) becomes its
 * last day. Returns the (possibly earlier) plan.
 */
export async function planBackfill(sql: Sql, connectionId: string, today: IsoDate, now: Date): Promise<{ dateFrom: IsoDate; dateTo: IsoDate }> {
  await sql`
    update connection_backfills set date_to = greatest(${today}::date, date_from), started_at = ${now}
    where connection_id = ${connectionId} and date_to is null
  `;
  const [row] = await sql<{ dateFrom: IsoDate; dateTo: IsoDate }[]>`
    select date_from, date_to from connection_backfills where connection_id = ${connectionId}
  `;
  if (!row) throw new Error(`connection ${connectionId} has no backfill`);
  return row;
}

/** Every month is done. */
export async function completeBackfill(sql: Sql, connectionId: string, now: Date): Promise<void> {
  await sql`
    update connection_backfills set status = 'complete', completed_at = ${now}
    where connection_id = ${connectionId} and status = 'active'
  `;
}
