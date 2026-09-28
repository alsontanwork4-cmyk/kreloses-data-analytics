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
