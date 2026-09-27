import { randomBytes } from "node:crypto";

import { createSql, type Sql } from "./sql";

/**
 * Cluster-level helpers for LOCAL development and tests: create/drop throwaway databases on the
 * shared local Supabase Postgres. Never used by the running app.
 *
 * Every database these helpers touch must be named `kx_<something>` (e.g. `kx_test_…`,
 * `kx_e2e_…`, `kx_dev_issue5`), so they can never drop `postgres` or another project's database.
 */
export const DEFAULT_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Superuser URL of the local cluster. Override with `DATABASE_ADMIN_URL`. */
export function adminUrl(): string {
  return process.env.DATABASE_ADMIN_URL || DEFAULT_ADMIN_URL;
}

/** Connection URL for another database on the same cluster as `base`. */
export function databaseUrl(name: string, base: string = adminUrl()): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

const MANAGED_NAME = /^kx_[a-z0-9_]{1,60}$/;

export function assertManagedDatabaseName(name: string): void {
  if (!MANAGED_NAME.test(name)) {
    throw new Error(
      `Refusing to touch database "${name}": managed database names must match ${MANAGED_NAME} (e.g. kx_dev_issue5).`,
    );
  }
}

export type ThrowawayPrefix = "kx_test_" | "kx_e2e_";

/** `kx_test_<base36 ms>_<8 hex>`; the timestamp lets stale databases be cleaned up safely. */
export function timestampedDatabaseName(prefix: ThrowawayPrefix, createdAt: number = Date.now()): string {
  return `${prefix}${createdAt.toString(36)}_${randomBytes(4).toString("hex")}`;
}

const GENERATED_NAME = /^kx_(?:test|e2e)_([0-9a-z]{8,9})_[0-9a-f]{8}$/;
const EARLIEST_PLAUSIBLE = Date.UTC(2024, 0, 1);

/** Creation time encoded in a `timestampedDatabaseName`, or null for any other name. */
function generatedAt(name: string, now: number): number | null {
  const match = GENERATED_NAME.exec(name);
  if (!match) return null;
  const createdAt = parseInt(match[1]!, 36);
  return createdAt >= EARLIEST_PLAUSIBLE && createdAt <= now ? createdAt : null;
}

export async function withAdminSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = createSql(adminUrl(), { max: 1 });
  try {
    return await fn(sql);
  } catch (error) {
    throw explainConnectionError(error);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function databaseExists(name: string): Promise<boolean> {
  return withAdminSql(async (sql) => {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  });
}

/** Creates an empty database from `template0` (a pristine, plain Postgres database). */
export async function createDatabase(name: string): Promise<void> {
  assertManagedDatabaseName(name);
  await withAdminSql((sql) => sql.unsafe(`create database "${name}" template template0`));
}

/** Drops the database, disconnecting anyone still connected. No-op if it does not exist. */
export async function dropDatabase(name: string): Promise<void> {
  assertManagedDatabaseName(name);
  await withAdminSql((sql) => sql.unsafe(`drop database if exists "${name}" with (force)`));
}

/**
 * Drops `kx_test_*` / `kx_e2e_*` databases left behind by crashed runs. Only databases whose name
 * has the exact generated shape, that are older than `olderThanMs`, and that nobody is connected
 * to are touched — so runs in other worktrees (even a long `playwright test --ui` session) and
 * hand-named databases are never disturbed.
 */
export async function dropStaleDatabases(
  prefix: ThrowawayPrefix,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  const candidates = await withAdminSql(async (sql) => {
    const rows = await sql<{ datname: string }[]>`
      select d.datname
      from pg_database d
      where starts_with(d.datname, ${prefix})
        and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)
    `;
    return rows.map((row) => row.datname);
  });
  const stale = candidates.filter((name) => {
    const createdAt = generatedAt(name, now);
    return createdAt !== null && now - createdAt > olderThanMs;
  });
  const dropped: string[] = [];
  for (const name of stale) {
    // Re-check under the drop: someone may have connected since the listing. Plain DROP (no
    // FORCE) fails instead of kicking them off.
    try {
      await withAdminSql((sql) => sql.unsafe(`drop database if exists "${name}"`));
      dropped.push(name);
    } catch {
      // In use: leave it.
    }
  }
  return dropped;
}

function explainConnectionError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "CONNECT_TIMEOUT") {
    return new Error(
      `Cannot reach the local Postgres cluster at ${new URL(adminUrl()).host}. ` +
        "Start the shared local Supabase stack with `supabase start` (never `supabase stop` it: other worktrees use it).",
      { cause: error },
    );
  }
  return error;
}
