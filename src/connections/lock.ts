import { randomUUID } from "node:crypto";

import type { Sql } from "@/db/sql";

import { isConnectionId } from "./store";

/**
 * A lease per connection (`connection_locks`): whoever holds it is the only code with a Kreloses
 * session for that login, so a sync, a second sync and a "Test again" never log in to the same
 * Kreloses account at the same time — from any server instance.
 *
 * A table row rather than a Postgres advisory lock because session-level advisory locks do not
 * survive Supabase's transaction pooler (docs/adr/0004). A lease expires on its own (`ttlMs`), so
 * a holder that crashed frees the connection after the TTL; choose a TTL longer than the work can
 * possibly take (a sync run stops itself at its time budget).
 */
export type LeasePurpose = "sync" | "login-test";

export interface ConnectionLease {
  connectionId: string;
  /** `<purpose>:<random token>`: only this holder can release it. */
  holder: string;
  purpose: LeasePurpose;
  expiresAt: Date;
}

export type LeaseAttempt =
  | { status: "acquired"; lease: ConnectionLease }
  | { status: "busy"; heldFor: LeasePurpose; until: Date }
  | { status: "not_found" };

export interface LeaseOptions {
  purpose: LeasePurpose;
  ttlMs: number;
  now: Date;
}

/** Takes the connection's lease if it is free (or expired). Never waits. */
export async function acquireConnectionLease(sql: Sql, connectionId: string, options: LeaseOptions): Promise<LeaseAttempt> {
  if (!isConnectionId(connectionId)) return { status: "not_found" };
  const holder = `${options.purpose}:${randomUUID()}`;
  const expiresAt = new Date(options.now.getTime() + options.ttlMs);

  // A lease released between the insert and the look-up below is simply tried again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let taken: { holder: string }[];
    try {
      taken = await sql<{ holder: string }[]>`
        insert into connection_locks (connection_id, holder, acquired_at, expires_at)
        values (${connectionId}, ${holder}, ${options.now}, ${expiresAt})
        on conflict (connection_id) do update set
          holder = excluded.holder,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        where connection_locks.expires_at <= excluded.acquired_at
        returning holder
      `;
    } catch (error) {
      if ((error as { code?: string }).code === "23503") return { status: "not_found" }; // no such connection
      throw error;
    }
    if (taken.length > 0) {
      return { status: "acquired", lease: { connectionId, holder, purpose: options.purpose, expiresAt } };
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

/** Gives the lease back. A no-op if it has expired and someone else holds it now. */
export async function releaseConnectionLease(sql: Sql, lease: ConnectionLease): Promise<void> {
  await sql`delete from connection_locks where connection_id = ${lease.connectionId} and holder = ${lease.holder}`;
}

/** Runs `work` while holding the connection's lease, and releases it afterwards (even on error). */
export async function withConnectionLease<T>(
  sql: Sql,
  connectionId: string,
  options: Omit<LeaseOptions, "now"> & { now: () => Date },
  work: (lease: ConnectionLease) => Promise<T>,
): Promise<{ status: "done"; value: T } | Exclude<LeaseAttempt, { status: "acquired" }>> {
  const attempt = await acquireConnectionLease(sql, connectionId, { ...options, now: options.now() });
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
    super(heldFor === "sync" ? "A sync is using this Kreloses login right now." : "This Kreloses login is being tested right now.");
    this.name = "ConnectionBusy";
    this.heldFor = heldFor;
    this.until = until;
  }
}

function purposeOf(holder: string): LeasePurpose {
  return holder.startsWith("login-test:") ? "login-test" : "sync";
}
