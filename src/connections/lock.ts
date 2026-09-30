import { randomUUID } from "node:crypto";

import type { Queryable, Sql } from "@/db/sql";

import { isConnectionId } from "./store";

/**
 * A lease per connection (`connection_locks`): whoever holds it is the only code with a Kreloses
 * session for that login, so a sync, a second sync and a "Test again" never log in to the same
 * Kreloses account at the same time — from any server instance.
 *
 * A table row rather than a Postgres advisory lock because session-level advisory locks do not
 * survive Supabase's transaction pooler (docs/adr/0004). Expiry is judged by the DATABASE clock
 * (`now()`), never a server's clock, so instances with skewed clocks agree (docs/adr/0009). A lease
 * expires on its own (`ttlMs`), so a holder that crashed frees the connection after the TTL; a
 * long-running holder (a sync) keeps it by renewing it with every write (`renewConnectionLease`) and
 * stops writing the moment a renewal fails (fencing: someone else took it after it expired).
 */
export type LeasePurpose = "sync" | "backfill" | "login-test";

export interface ConnectionLease {
  connectionId: string;
  /** `<purpose>:<random token>`: only this holder can renew or release it. */
  holder: string;
  purpose: LeasePurpose;
  expiresAt: Date;
  /**
   * A backfill lease only: another sync (nightly, Sync now) asked it to step aside
   * (`requestBackfillYield`). Updated by every `renewConnectionLease`; the backfill run stops at its
   * next request and releases the lease (docs/adr/0011).
   */
  yieldRequested?: boolean;
}

export type LeaseAttempt =
  | { status: "acquired"; lease: ConnectionLease }
  | { status: "busy"; heldFor: LeasePurpose; until: Date }
  | { status: "not_found" };

export interface LeaseOptions {
  purpose: LeasePurpose;
  /** How long the lease lasts without a renewal (from the database's `now()`). */
  ttlMs: number;
}

/** Takes the connection's lease if it is free (or expired, by the database clock). Never waits. */
export async function acquireConnectionLease(sql: Sql, connectionId: string, options: LeaseOptions): Promise<LeaseAttempt> {
  if (!isConnectionId(connectionId)) return { status: "not_found" };
  const holder = `${options.purpose}:${randomUUID()}`;
  const ttl = ttlSeconds(options.ttlMs);

  // A lease released between the insert and the look-up below is simply tried again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let taken: { holder: string; expiresAt: Date }[];
    try {
      taken = await sql<{ holder: string; expiresAt: Date }[]>`
        insert into connection_locks (connection_id, holder, acquired_at, expires_at)
        values (${connectionId}, ${holder}, now(), now() + make_interval(secs => ${ttl}))
        on conflict (connection_id) do update set
          holder = excluded.holder,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          yield_requested_at = null
        where connection_locks.expires_at <= now()
        returning holder, expires_at
      `;
    } catch (error) {
      if ((error as { code?: string }).code === "23503") return { status: "not_found" }; // no such connection
      throw error;
    }
    if (taken.length > 0) {
      return { status: "acquired", lease: { connectionId, holder, purpose: options.purpose, expiresAt: taken[0]!.expiresAt } };
    }
    const [current] = await sql<{ holder: string; expiresAt: Date }[]>`
      select holder, expires_at from connection_locks where connection_id = ${connectionId}
    `;
    if (current) return { status: "busy", heldFor: purposeOf(current.holder), until: current.expiresAt };
  }
  const [current] = await sql<{ holder: string; expiresAt: Date }[]>`
    select holder, expires_at from connection_locks where connection_id = ${connectionId}
  `;
  return current ? { status: "busy", heldFor: purposeOf(current.holder), until: current.expiresAt } : { status: "not_found" };
}

/**
 * Extends the lease to `ttlMs` from the database's `now()` — if `lease.holder` still holds it.
 * False = it was lost (it expired and someone else took it, or the connection was deleted): the
 * caller must stop writing. Run it INSIDE the transaction that writes, so a write can never commit
 * after the lease was lost (the row stays locked until the transaction ends).
 */
export async function renewConnectionLease(sql: Queryable, lease: ConnectionLease, ttlMs: number): Promise<boolean> {
  const renewed = await sql<{ expiresAt: Date; yieldRequestedAt: Date | null }[]>`
    update connection_locks set expires_at = greatest(expires_at, now() + make_interval(secs => ${ttlSeconds(ttlMs)}))
    where connection_id = ${lease.connectionId} and holder = ${lease.holder}
    returning expires_at, yield_requested_at
  `;
  if (renewed.length === 0) return false;
  lease.expiresAt = renewed[0]!.expiresAt;
  lease.yieldRequested = renewed[0]!.yieldRequestedAt !== null;
  return true;
}

/**
 * Asks the history backfill holding this connection's lease (if one does and its lease has not
 * expired) to step aside: it stops at its next request and releases the lease (docs/adr/0011).
 * True if a backfill holds it. The nightly sync and Sync now call this, then wait for the lease.
 */
export async function requestBackfillYield(sql: Sql, connectionId: string): Promise<boolean> {
  if (!isConnectionId(connectionId)) return false;
  const asked = await sql`
    update connection_locks set yield_requested_at = coalesce(yield_requested_at, now())
    where connection_id = ${connectionId} and holder like 'backfill:%' and expires_at > now()
    returning 1
  `;
  return asked.length > 0;
}

/** Gives the lease back. A no-op if it has expired and someone else holds it now. */
export async function releaseConnectionLease(sql: Sql, lease: ConnectionLease): Promise<void> {
  await sql`delete from connection_locks where connection_id = ${lease.connectionId} and holder = ${lease.holder}`;
}

/** Runs `work` while holding the connection's lease, and releases it afterwards (even on error). */
export async function withConnectionLease<T>(
  sql: Sql,
  connectionId: string,
  options: LeaseOptions,
  work: (lease: ConnectionLease) => Promise<T>,
): Promise<{ status: "done"; value: T } | Exclude<LeaseAttempt, { status: "acquired" }>> {
  const attempt = await acquireConnectionLease(sql, connectionId, options);
  if (attempt.status !== "acquired") return attempt;
  try {
    return { status: "done", value: await work(attempt.lease) };
  } finally {
    await releaseConnectionLease(sql, attempt.lease);
  }
}

/** Thrown by `testConnection` when a sync (or another test) is using the connection right now. */
export class ConnectionBusy extends Error {
  readonly heldFor: LeasePurpose;
  readonly until: Date;

  constructor(heldFor: LeasePurpose, until: Date) {
    super(
      heldFor === "sync"
        ? "A sync is using this Kreloses login right now."
        : heldFor === "backfill"
          ? "The history backfill is using this Kreloses login right now (it runs in short chunks at night)."
          : "This Kreloses login is being tested right now.",
    );
    this.name = "ConnectionBusy";
    this.heldFor = heldFor;
    this.until = until;
  }
}

function purposeOf(holder: string): LeasePurpose {
  if (holder.startsWith("login-test:")) return "login-test";
  return holder.startsWith("backfill:") ? "backfill" : "sync";
}

function ttlSeconds(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`bad lease TTL ${ttlMs}`);
  return ttlMs / 1000;
}
