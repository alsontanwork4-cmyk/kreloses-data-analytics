import { dropStaleDatabases, withAdminSql } from "./admin";

/**
 * Runs once per `npm test`: fails fast with a clear message if the local cluster is down, and
 * drops throwaway test databases left behind by crashed runs (older than 2 hours only, so test
 * runs in other worktrees are never disturbed).
 */
export default async function setup(): Promise<void> {
  await withAdminSql((sql) => sql`select 1`);
  await dropStaleDatabases("kx_test_", 2 * 60 * 60 * 1000);
}
