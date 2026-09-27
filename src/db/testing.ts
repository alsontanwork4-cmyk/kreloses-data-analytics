import { afterAll, beforeAll } from "vitest";

import {
  createDatabase,
  databaseUrl,
  dropDatabase,
  timestampedDatabaseName,
} from "./admin";
import { applyMigrations } from "./migrate";
import { createSql, type Sql } from "./sql";

/**
 * Test harness: every call creates a brand-new database `kx_test_<timestamp>_<random>` on the
 * shared local cluster, applies every migration to it, and drops it on `close()`. Unique names
 * make it safe for several worktrees to run `npm test` at the same time. Never point tests at
 * the shared `postgres` database.
 */
export interface TestDatabase {
  name: string;
  url: string;
  sql: Sql;
  /** Closes the connection pool and drops the database. */
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = timestampedDatabaseName("kx_test_");
  const url = databaseUrl(name);
  await createDatabase(name);
  const sql = createSql(url, { max: 2 });
  const close = async () => {
    await sql.end({ timeout: 5 });
    await dropDatabase(name);
  };
  try {
    await applyMigrations(sql);
  } catch (error) {
    await close();
    throw error;
  }
  return { name, url, sql, close };
}

/**
 * Vitest helper: one fresh, migrated database per test file (created in `beforeAll`, dropped in
 * `afterAll`). Tests in the same file share it, so use distinct data per test or clean up.
 *
 *   const db = useTestDatabase();
 *   it("…", async () => { await db.sql`select 1`; });
 */
export function useTestDatabase(): { readonly sql: Sql; readonly url: string } {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await database?.close();
  }, 60_000);
  const current = () => {
    if (!database) throw new Error("useTestDatabase(): the database is only available inside tests/hooks");
    return database;
  };
  return {
    get sql() {
      return current().sql;
    },
    get url() {
      return current().url;
    },
  };
}
