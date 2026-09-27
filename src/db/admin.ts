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

/** `kx_test_<base36 ms>_<random>`; the timestamp lets stale databases be cleaned up safely. */
export function timestampedDatabaseName(prefix: "kx_test_" | "kx_e2e_"): string {
  return `${prefix}${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
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
 * Drops `kx_test_*` / `kx_e2e_*` databases left behind by crashed runs. Only databases older than
 * `olderThanMs` are touched, so runs in other worktrees that are still going are safe.
 */
export async function dropStaleDatabases(
  prefix: "kx_test_" | "kx_e2e_",
  olderThanMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  const names = await withAdminSql(async (sql) => {
    const rows = await sql<{ datname: string }[]>`
      select datname from pg_database where starts_with(datname, ${prefix})
    `;
    return rows.map((row) => row.datname);
  });
  const stale = names.filter((name) => {
    const createdAt = parseInt(name.slice(prefix.length).split("_")[0] ?? "", 36);
    return Number.isFinite(createdAt) && now - createdAt > olderThanMs;
  });
  for (const name of stale) await dropDatabase(name);
  return stale;
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
