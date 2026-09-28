import { createSql, type Sql } from "../../src/db/sql";

import { run } from "./run";

/** Runs `fn` against this e2e run's database (the one the app under test uses). */
export async function withRunDatabase<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = createSql(run.databaseUrl, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Leaves the run's database as the other specs expect it: no synced sales (invoices, their lines
 * and credited lines), staff, customers, sync runs, branches or connections. Children first.
 */
export async function clearSyncedData(): Promise<void> {
  await withRunDatabase(async (sql) => {
    await sql`delete from invoices`; // cascades to invoice_lines and credited_lines
    await sql`delete from staff_aliases`;
    await sql`delete from staff`;
    await sql`delete from customers`;
    await sql`delete from sync_runs`;
    await sql`delete from branches`;
    await sql`delete from connections`;
  });
}
